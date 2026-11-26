import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { QueryCountMode, QueryFilterNode, QueryRequest } from "./types.js";

/** What a statement is for. `plan` is the engine's own planning work: EXPLAINs and index catalog reads. */
export type QueryStage = "ids" | "count" | "rows" | "facets" | "summary" | "plan" | "scan";

/**
 * A stable, value-free description of a request: what it filters, sorts, searches and counts,
 * never the values. Two requests with the same shape get the same `shape` string.
 */
export interface RequestShape {
  resource: string;
  /** Filter conditions as `key:operator`, sorted. An `or` group reads `(a:is|b:is)`. */
  filters: string[];
  /** Sort keys with their direction, as `createdAt desc`. */
  sorting: string[];
  /** Search fields, sorted. Empty when the request has no search text. */
  search: string[];
  /** Facet keys with their mode, as `status:exclude-self`, sorted. */
  facets: string[];
  pagination: "offset" | "cursor";
  count: QueryCountMode;
}

/** One statement the engine ran, handed to `onQuery`. */
export interface QueryEvent {
  resource: string;
  stage: QueryStage;
  /** The request shape as one line, for logs and metric labels. */
  shape: string;
  /** The same shape as an object. */
  shapeKey: RequestShape;
  /** Wall-clock milliseconds the statement took, including the driver round trip. */
  ms: number;
  /** Rows the statement returned. */
  rows: number;
  /** The statement with `$1` placeholders. Parameter values are never included. */
  sql: string;
  /** Set when the statement failed. The engine still throws or degrades as it would without a hook. */
  error?: unknown;
}

export type QueryObserver = (event: QueryEvent) => void | Promise<void>;

const dialect = new PgDialect();
const shapeCache = new WeakMap<object, { shape: string; key: RequestShape }>();

function renderFilters(nodes: readonly QueryFilterNode[], ignore?: (node: object) => boolean) {
  return [...new Set(nodes.flatMap((node) => renderNode(node, ignore)))].toSorted();
}

function renderNode(node: QueryFilterNode, ignore?: (node: object) => boolean): string[] {
  if (ignore?.(node)) return [];
  if (node.type === "condition") return [`${node.key}:${node.operator}`];
  const children = renderFilters(node.children, ignore);
  if (children.length === 0) return [];
  // An `and` group reads the same as its members side by side.
  return node.combinator === "and" ? children : [`(${children.join("|")})`];
}

/** The shape of a normalized request. `ignore` skips nodes the resource's scope added. */
export function describeRequestShape(
  resource: string,
  request: QueryRequest | undefined,
  ignore?: (node: object) => boolean,
): { shape: string; key: RequestShape } {
  const cached = request ? shapeCache.get(request) : undefined;
  if (cached) return cached;

  const key: RequestShape = request
    ? {
        resource,
        filters: renderFilters(request.filters, ignore),
        // The engine appends an `id` tie-breaker. It only shows when it breaks the direction.
        sorting: request.sorting
          .filter(
            (rule, index, all) =>
              !(rule.key === "id" && index === all.length - 1 && all[index - 1]?.dir === rule.dir),
          )
          .map((rule) => `${rule.key} ${rule.dir}`),
        search:
          request.search.value.length > 0 ? [...new Set(request.search.fields)].toSorted() : [],
        facets: (request.facets ?? [])
          .map((facet) => `${facet.key}:${facet.mode ?? "exclude-self"}`)
          .toSorted(),
        pagination: request.pagination.mode,
        count: request.pagination.count,
      }
    : {
        resource,
        filters: [],
        sorting: [],
        search: [],
        facets: [],
        pagination: "offset",
        count: "none",
      };

  const parts = [key.resource];
  if (key.filters.length) parts.push(`filter ${key.filters.join(",")}`);
  if (key.sorting.length) parts.push(`sort ${key.sorting.join(", ")}`);
  if (key.search.length) parts.push(`search ${key.search.join(",")}`);
  if (key.facets.length) parts.push(`facets ${key.facets.join(",")}`);
  if (request) parts.push(key.pagination, `count ${key.count}`);

  const described = { shape: parts.join(" · "), key };
  if (request) shapeCache.set(request, described);
  return described;
}

/** A copy of a shape that shares nothing with the cached one. */
export function cloneShape(key: RequestShape): RequestShape {
  return {
    ...key,
    filters: [...key.filters],
    sorting: [...key.sorting],
    search: [...key.search],
    facets: [...key.facets],
  };
}

/** The SQL text of a statement, with placeholders and without parameter values. */
export function statementText(statement: SQL): string {
  return dialect.sqlToQuery(statement).sql;
}

type Statement<T> = PromiseLike<T> & { toSQL(): { sql: string } };

/** One statement captured by a dry run instead of being executed. */
export interface CapturedStatement {
  stage: QueryStage;
  statement: SQL;
  /** Which facets the statement answers, when it is a facets statement. */
  facets?: string[];
  /** Whether several facets share the statement through GROUPING SETS. */
  groupingSets?: boolean;
  /** Why the statement is not an ordinary one, in plain words. */
  note?: string;
  /** The exact count of the page is a column of this statement, not a statement of its own. */
  carriesCount?: boolean;
  /**
   * A search without an exact count runs the `ordinary` plan first, with a time budget, and the
   * `indexed` plan only when the budget runs out.
   */
  attempt?: "ordinary" | "indexed";
  /** The budget of the `ordinary` attempt, in milliseconds. */
  budget?: number;
}

export interface ObservedStatementOptions<T> {
  /** What a dry run returns in place of the statement's rows. */
  dry?: T;
  facets?: string[];
  groupingSets?: boolean;
  note?: string;
  carriesCount?: boolean;
}

/**
 * Wraps the statements of one resource. Without an observer and outside a dry run, every call
 * hands the query straight back, so an engine nobody observes pays one boolean check per statement.
 */
export interface StatementObserver {
  readonly active: boolean;
  /** Run a drizzle query builder. */
  run<T>(
    stage: QueryStage,
    request: QueryRequest | undefined,
    query: Statement<T>,
    options?: ObservedStatementOptions<T>,
  ): PromiseLike<T>;
  /** Run a raw `sql` statement through `database.execute`. */
  raw<T>(
    stage: QueryStage,
    request: QueryRequest | undefined,
    statement: SQL,
    execution: PromiseLike<T>,
    options?: ObservedStatementOptions<T>,
  ): PromiseLike<T>;
  /** True when statements are captured instead of executed. */
  readonly dry: boolean;
  /** Add a statement to a dry run's capture without running anything. */
  record(entry: CapturedStatement): void;
  /** How many statements a dry run has captured so far. */
  captured(): number;
  /** Mark the statements a dry run captured since `from`. */
  annotate(from: number, patch: Partial<CapturedStatement>): void;
}

/** Planning and scan statements run even in a dry run: they are not the request's own work. */
const alwaysRun = new Set<QueryStage>(["plan", "scan"]);

function countRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * @param observers called for every statement; errors they throw are swallowed
 * @param capture when set, `ids`, `count`, `rows`, `facets` and `summary` statements are pushed here
 *   and answered with their `dry` value instead of being executed
 */
export function createStatementObserver(
  resource: string,
  observers: ReadonlyArray<QueryObserver | undefined>,
  options: {
    ignoreFilter?: (node: object) => boolean;
    capture?: CapturedStatement[];
  } = {},
): StatementObserver {
  const listeners = observers.filter(
    (observer): observer is QueryObserver => observer !== undefined,
  );
  const { capture } = options;
  const active = listeners.length > 0;

  function emit(
    stage: QueryStage,
    request: QueryRequest | undefined,
    text: () => string,
    started: number,
    rows: number,
    error?: unknown,
  ) {
    try {
      const { shape, key } = describeRequestShape(resource, request, options.ignoreFilter);
      const event: QueryEvent = {
        resource,
        stage,
        shape,
        // Each event gets its own copy: a hook that edits one must not change the next.
        shapeKey: cloneShape(key),
        ms: performance.now() - started,
        rows,
        sql: text(),
        ...(error === undefined ? {} : { error }),
      };
      for (const listener of listeners) {
        try {
          const returned = listener(event);
          if (returned) void Promise.resolve(returned).catch(() => undefined);
        } catch {
          // a hook never changes a result
        }
      }
    } catch {
      // describing a statement must never fail the request
    }
  }

  async function observed<T>(
    stage: QueryStage,
    request: QueryRequest | undefined,
    text: () => string,
    execution: PromiseLike<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await execution;
      emit(stage, request, text, started, countRows(result));
      return result;
    } catch (error) {
      emit(stage, request, text, started, 0, error ?? new Error("Statement failed"));
      throw error;
    }
  }

  const dry = capture !== undefined;

  return {
    active,
    dry,
    record(entry) {
      capture?.push(entry);
    },
    captured: () => capture?.length ?? 0,
    annotate(from, patch) {
      for (const entry of capture?.slice(from) ?? []) Object.assign(entry, patch);
    },
    run(stage, request, query, statementOptions) {
      if (capture && !alwaysRun.has(stage)) {
        capture.push({
          stage,
          statement: (query as unknown as { getSQL(): SQL }).getSQL(),
          facets: statementOptions?.facets,
          groupingSets: statementOptions?.groupingSets,
          note: statementOptions?.note,
          carriesCount: statementOptions?.carriesCount,
        });
        return Promise.resolve(statementOptions?.dry as never);
      }
      if (!active) return query;
      return observed(stage, request, () => query.toSQL().sql, query);
    },
    raw(stage, request, statement, execution, statementOptions) {
      if (capture && !alwaysRun.has(stage)) {
        capture.push({ stage, statement, note: statementOptions?.note });
        return Promise.resolve(statementOptions?.dry as never);
      }
      if (!active) return execution;
      return observed(stage, request, () => statementText(statement), execution);
    },
  };
}

/** The observer of an engine nobody observes. */
export const silentObserver: StatementObserver = createStatementObserver("", []);
