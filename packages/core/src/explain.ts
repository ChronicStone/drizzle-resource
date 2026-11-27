import { sql } from "drizzle-orm";
import {
  isCallerTransaction,
  isPostgresDatabase,
  parseDurationMilliseconds,
  runTimed,
} from "./postgres.js";
import { cloneShape, describeRequestShape, statementText } from "./observe.js";
import type { CapturedStatement, QueryEvent, RequestShape } from "./observe.js";
import type { QueryEngineDb, QueryRequest } from "./types.js";

/** Stages `explain()` reports. A page's rows are a primary-key lookup of the ids and are not explained. */
export type ExplainStageName = "ids" | "count" | "facets" | "summary";

export type ExplainWarningCode =
  | "full-count"
  | "index-walk"
  | "seq-scan"
  | "deep-offset"
  | "misestimate"
  | "relation-sort"
  | "single-cpu-facets";

export interface ExplainWarning {
  code: ExplainWarningCode;
  /** What is slow, in plain words, with the numbers from the plan. */
  message: string;
  /** What to change, when something fixes it. */
  fix?: string;
  /** `measured` comes from `EXPLAIN ANALYZE`; `estimated` from the planner's own numbers. */
  basis: "measured" | "estimated";
}

/** One node of PostgreSQL's `EXPLAIN (FORMAT JSON)` tree. */
export interface ExplainPlanNode {
  "Node Type": string;
  Plans?: ExplainPlanNode[];
  [key: string]: unknown;
}

export interface ExplainStage {
  stage: ExplainStageName;
  /** Which facets a facets statement answers, or why a statement is unusual. */
  label?: string;
  /** The statement the engine runs, with `$1` placeholders. */
  sql: string;
  /** `EXPLAIN ANALYZE` execution time. Only with `analyze: true`. */
  ms?: number;
  /** Rows the scans read, including the ones a filter dropped. Only with `analyze: true`. */
  rowsRead?: number;
  /** Rows the statement returned. Only with `analyze: true`. */
  rowsReturned?: number;
  /** How the statement reads its data, in one line. Estimates are marked with `about`. */
  summary: string;
  /** PostgreSQL's plan: the `Plan` object of `EXPLAIN (FORMAT JSON)`. */
  plan: ExplainPlanNode;
  warnings: ExplainWarning[];
  /** A search without an exact count runs its ordinary plan first and the indexed plan as a fallback. */
  attempt?: "ordinary" | "indexed";
  /** With `analyze`, the budget the attempt ran under and whether it ran over. */
  budget?: { ms: number; exceeded: boolean };
  /** The ordinary plan run again with no budget, after the attempts before it ran over. */
  final?: boolean;
  /** Which attempt of its statement this row is: 1, 2 or 3. */
  attemptNumber?: number;
  /** For a page after a capped count: the count outcome that makes this row part of the path. */
  countOutcome?: "at cap" | "under cap";
  /** `analyze` only: the stage's `query.timeouts` value and whether the statement ran over it. */
  timeout?: { ms: number; exceeded: boolean };
  /** `analyze` only: the statement would fail, and why. */
  failure?: string;
}

export interface ExplainReport {
  resource: string;
  /** The request shape as one line. */
  shape: string;
  shapeKey: RequestShape;
  /** True when the statements ran under `EXPLAIN ANALYZE` (in a transaction that was rolled back). */
  analyzed: boolean;
  stages: ExplainStage[];
  /** The planning statements the engine ran on the way: plan estimates and index catalog reads. */
  planning: Array<Pick<QueryEvent, "stage" | "sql" | "ms" | "rows">>;
  /** Things the report leaves out or cannot know, in plain words. */
  notes: string[];
}

/** Limits above which a plan is reported. */
export const explainThresholds = {
  /** An exact count, or a scan, reading at least this many rows is worth a warning. */
  rows: 100_000,
  /** A filtered walk of a sort index must discard at least this many rows. */
  walkedRows: 10_000,
  /** Rows skipped by an offset page. */
  offset: 10_000,
  /** A misestimate is a factor of at least this much and at least `misestimateRows` rows. */
  misestimateFactor: 10,
  misestimateRows: 10_000,
  /** A seq scan whose filter keeps less than this share of the rows should have an index. */
  seqScanKeep: 0.1,
};

type Node = ExplainPlanNode;

const stageOrder: Record<ExplainStageName, number> = { ids: 0, count: 1, facets: 2, summary: 3 };

const blocking = new Set(["Sort", "Aggregate", "Hash", "WindowAgg", "Materialize"]);

function text(node: Node, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function number(node: Node, key: string): number | undefined {
  const value = node[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

interface Context {
  /** A parent can stop reading this node early: it sits under a Limit with nothing blocking between. */
  early: boolean;
  limit?: Node;
  /** Workers planned by the nearest Gather above. */
  workers: number;
  /** Below an InitPlan or SubPlan: the plan may never run it. */
  conditional: boolean;
}

function walk(node: Node, visit: (node: Node, context: Context) => void, context?: Context) {
  const current = context ?? { early: false, workers: 0, conditional: false };
  visit(node, current);
  const type = node["Node Type"];
  const next: Context = {
    early: type === "Limit" ? true : blocking.has(type) ? false : current.early,
    limit: type === "Limit" ? node : current.limit,
    workers:
      type === "Gather" || type === "Gather Merge"
        ? (number(node, "Workers Planned") ?? 0)
        : current.workers,
    conditional: current.conditional,
  };
  for (const child of node.Plans ?? []) {
    const conditional =
      next.conditional ||
      child["Parent Relationship"] === "InitPlan" ||
      child["Parent Relationship"] === "SubPlan";
    walk(child, visit, { ...next, conditional });
  }
}

function nodes(plan: Node) {
  const found: Array<{ node: Node; context: Context }> = [];
  walk(plan, (node, context) => found.push({ node, context }));
  return found;
}

function isScan(node: Node) {
  return text(node, "Relation Name") !== undefined && node["Node Type"].endsWith("Scan");
}

function loops(node: Node) {
  return number(node, "Actual Loops") ?? 1;
}

/** Rows the node produced over all its loops. */
function actualRows(node: Node) {
  return (number(node, "Actual Rows") ?? 0) * loops(node);
}

function relationKey(node: Node) {
  return `${text(node, "Schema") ?? "public"}.${text(node, "Relation Name")}`;
}

/** Rows a scan looked at, including the ones its filter or recheck dropped. */
function rowsReadBy(node: Node) {
  return (
    actualRows(node) +
    ((number(node, "Rows Removed by Filter") ?? 0) +
      (number(node, "Rows Removed by Index Recheck") ?? 0)) *
      loops(node)
  );
}

interface Analysis {
  warnings: ExplainWarning[];
  summary: string;
  rowsRead?: number;
  rowsReturned?: number;
}

export interface AnalysisInput {
  stage: ExplainStageName;
  plan: Node;
  analyzed: boolean;
  /** `reltuples` of the relations in the plan, by `schema.relation`. */
  tables: ReadonlyMap<string, number>;
  countCap: number;
  /** `query.facets.splitAbove` of the resource. */
  facetSplitAbove: number;
  /** The root table of the resource. */
  root: string;
  pagination: { mode: "offset" | "cursor"; offset: number; pageSize: number; pageIndex: number };
  allowsCursor: boolean;
  hasSearch: boolean;
  /** Sort fields that live on a related table. */
  relationSorts: readonly string[];
  /** The statement answers several facets through GROUPING SETS. */
  groupingSets: boolean;
  /** The exact count of the page is a column of this statement. */
  carriesCount?: boolean;
  facets?: readonly string[];
  /** Index definitions of the relations in the plan, by `schema.relation`, when they were read. */
  indexes?: ReadonlyMap<string, readonly string[]>;
}

/** How many processes share a parallel scan, as the planner counts them. */
function parallelDivisor(node: Node, context: Context) {
  if (node["Parallel Aware"] !== true || context.workers <= 0) return 1;
  const leader = 1 - 0.3 * context.workers;
  return context.workers + (leader > 0 ? leader : 0);
}

/** Rows a scan produces in total, from the planner's per-process estimate. */
function plannedRows(node: Node, context: Context) {
  return (number(node, "Plan Rows") ?? 0) * parallelDivisor(node, context);
}

/**
 * Rows the planner expects a scan to read: a seq scan reads its table and other scans what they
 * return, less when a Limit above stops the read once it has enough rows.
 */
function estimatedRead(node: Node, context: Context, input: AnalysisInput) {
  const matches = plannedRows(node, context);
  const tuples = input.tables.get(relationKey(node));
  let reads =
    node["Node Type"] === "Seq Scan" && tuples !== undefined && tuples >= 0 ? tuples : matches;
  if (context.early && context.limit) {
    const needed =
      (number(context.limit, "Plan Rows") ?? 0) +
      (input.stage === "ids" ? input.pagination.offset : 0);
    reads *= matches > 0 ? Math.min(1, needed / matches) : 1;
  }
  return reads;
}

function describeScan(node: Node) {
  const type = node["Node Type"];
  const relation = text(node, "Relation Name")!;
  const index = text(node, "Index Name");
  if (index) return `index ${index}`;
  if (type.includes("Bitmap")) return `bitmap scan on ${relation}`;
  if (type.includes("Seq")) return `seq scan on ${relation}`;
  return `${type.toLowerCase()} on ${relation}`;
}

/**
 * Text filters compile to `lower(column) = $1` (and `lower(column) like ...`), so a plain index
 * on the column does not serve them. Reads the expressions a plan's filter compares.
 */
export function lowerExpressions(filter: string | undefined) {
  const equal = new Set<string>();
  const like = new Set<string>();
  const pattern = /lower\(\(?(?:"?\w+"?\.)?"?(\w+)"?\)?(?:::[a-z ]+)?\)\s*(~~\*?|=|<>|<=|>=|<|>)/g;
  for (const match of filter?.matchAll(pattern) ?? []) {
    (match[2]!.startsWith("~~") ? like : equal).add(match[1]!);
  }
  return { equal: [...equal], like: [...like] };
}

/** Whether one of the index definitions is on `lower(column)`. */
function hasExpressionIndex(definitions: readonly string[], column: string) {
  const pattern = new RegExp(`lower\\(\\(?"?${column}"?\\)?(::[a-z ]+)?\\)`);
  return definitions.some((definition) => pattern.test(definition));
}

/** What index serves a filter, in plain words. */
function indexAdvice(
  filter: string | undefined,
  relation: string,
  existing: readonly string[] | undefined,
) {
  const { equal, like } = lowerExpressions(filter);
  const parts: string[] = [];
  const present: string[] = [];
  const missing = (columns: string[]) =>
    columns.filter((column) => {
      const found = existing !== undefined && hasExpressionIndex(existing, column);
      if (found) present.push(column);
      return !found;
    });
  const equalMissing = missing(equal);
  const likeMissing = missing(like);
  if (equalMissing.length > 0) {
    const expressions = equalMissing.map((column) => `lower(${column})`).join(", ");
    parts.push(
      `index the expression ${expressions} (CREATE INDEX ON ${relation} (${expressions})): the engine compares text without case, so a plain index on ${equalMissing.join(", ")} is not used. Or add ${equalMissing.map((column) => `"${column}"`).join(", ")} to filters.caseSensitive and keep the plain index`,
    );
  }
  if (likeMissing.length > 0) {
    parts.push(
      `a trigram index on ${likeMissing.map((column) => `lower(${column})`).join(", ")} (CREATE INDEX ON ${relation} USING gin (lower(${likeMissing[0]}) gin_trgm_ops))`,
    );
  }
  if (present.length > 0 && parts.length === 0) {
    const expressions = [...new Set(present)].map((column) => `lower(${column})`).join(", ");
    return `an index on ${expressions} already exists and the plan does not use it: run ANALYZE ${relation}, and check that the index type serves the filter (a btree serves = but not LIKE, a trigram index serves both)`;
  }
  return parts.length > 0
    ? parts.join("; ")
    : `add an index on the filtered column(s) of ${relation}`;
}

function misestimateFix(
  filter: string | undefined,
  indexed: string | undefined,
  relation: string | undefined,
  existing: readonly string[] | undefined,
) {
  const inFilter = lowerExpressions(filter);
  const inIndex = lowerExpressions(indexed);
  // An expression with an index has statistics of its own, whether or not the plan reads the index.
  const covered = new Set([
    ...inIndex.equal,
    ...inIndex.like,
    ...[...inFilter.equal, ...inFilter.like].filter(
      (column) => existing !== undefined && hasExpressionIndex(existing, column),
    ),
  ]);
  const unindexed = [...new Set([...inFilter.equal, ...inFilter.like])].filter(
    (column) => !covered.has(column),
  );
  if (unindexed.length > 0) {
    const expressions = unindexed.map((column) => `lower(${column})`).join(", ");
    return `PostgreSQL keeps no statistics on ${expressions}, so ANALYZE cannot fix this estimate: create an expression index on it (that also gathers statistics) or extended statistics on the expression (CREATE STATISTICS ... ON (${unindexed.map((column) => `lower(${column})`).join("), (")}) FROM ${relation ?? "the table"})`;
  }
  if (inIndex.like.length > 0 || inFilter.like.length > 0) {
    // A substring match is estimated from a fixed guess, whichever plan reads it.
    return `PostgreSQL estimates a substring match (LIKE '%...%') from a fixed guess, not from statistics, so ANALYZE does not tighten it. The index is used; judge the plan by its time, or narrow the searched fields`;
  }
  return `run ANALYZE${relation ? ` ${relation}` : ""}; if the estimate stays off, create extended statistics (CREATE STATISTICS) on the filtered columns, or put the filtered column on the root table`;
}

/** The conditions of a node and of the scans below it, as the plan prints them. */
function conditionsOf(node: Node) {
  const filters: string[] = [];
  const indexed: string[] = [];
  for (const { node: inner } of nodes(node)) {
    const filter = text(inner, "Filter");
    if (filter) filters.push(filter);
    for (const key of ["Index Cond", "Recheck Cond"]) {
      const condition = text(inner, key);
      if (condition) indexed.push(condition);
    }
  }
  return {
    filter: filters.length > 0 ? filters.join(" AND ") : undefined,
    indexed: indexed.length > 0 ? indexed.join(" AND ") : undefined,
  };
}

/** Decide what a plan says. Pure: a plan, what the request asked for, and sizes in. */
export function analyzePlan(input: AnalysisInput): Analysis {
  const { plan, analyzed, stage } = input;
  const all = nodes(plan);
  // A scan below an InitPlan or SubPlan may never run; a plan that was not run cannot say.
  const scans = all.filter(
    ({ node, context }) => isScan(node) && (analyzed || !context.conditional),
  );
  const basis = analyzed ? ("measured" as const) : ("estimated" as const);
  const about = analyzed ? "" : "about ";
  const warnings: ExplainWarning[] = [];
  const thresholds = explainThresholds;

  const read = analyzed
    ? scans.reduce((total, { node }) => total + rowsReadBy(node), 0)
    : scans.reduce((total, { node, context }) => total + estimatedRead(node, context, input), 0);

  // relation-sort: no index serves an order that comes from a related table
  if (stage === "ids" && input.relationSorts.length > 0) {
    const sort = all.find(({ node }) => node["Node Type"] === "Sort");
    const sorted = sort
      ? analyzed
        ? (sort.node.Plans ?? []).reduce((total, child) => total + actualRows(child), 0)
        : (number(sort.node, "Plan Rows") ?? 0) *
          (sort.context.workers > 0
            ? sort.context.workers + Math.max(0, 1 - 0.3 * sort.context.workers)
            : 1)
      : undefined;
    if ((sorted ?? read) >= thresholds.rows)
      warnings.push({
        code: "relation-sort",
        message: `sorting by ${input.relationSorts.join(", ")} joins every matching row of ${input.root} to the related table before it can sort${sorted === undefined ? "" : ` (${about}${formatNumber(sorted)} rows sorted)`}`,
        fix: `copy ${input.relationSorts.join(", ")} onto ${input.root} and sort by the copy, or add ${input.relationSorts.map((field) => `"${field}"`).join(", ")} to sort.disabled`,
        basis,
      });
  }

  // deep-offset
  if (
    stage === "ids" &&
    input.pagination.mode === "offset" &&
    input.pagination.offset >= thresholds.offset
  ) {
    warnings.push({
      code: "deep-offset",
      message: `page ${formatNumber(input.pagination.pageIndex)} skips ${formatNumber(input.pagination.offset)} rows to return ${formatNumber(input.pagination.pageSize)}: PostgreSQL reads and discards every row before the page`,
      fix: input.allowsCursor
        ? 'use cursor pagination (pagination: { mode: "cursor" }): it starts after the last row of the previous page, at any depth'
        : 'allow cursor pagination (query.pagination.modes: ["offset", "cursor"]) and page with it: it starts after the last row of the previous page, at any depth',
      basis,
    });
  }

  // index-walk: a sort index read row by row, with the filter applied after it
  for (const { node, context } of scans) {
    const type = node["Node Type"];
    if (
      !context.early ||
      !type.startsWith("Index") ||
      text(node, "Filter") === undefined ||
      !(stage === "ids" || stage === "count")
    )
      continue;
    const name = text(node, "Index Name") ?? text(node, "Relation Name");
    const { equal, like } = lowerExpressions(text(node, "Filter"));
    const starts =
      equal.length > 0
        ? `the expression ${equal.map((column) => `lower(${column})`).join(", ")} (the engine compares text without case, so a plain index on the column is not used)`
        : "the filtered columns";
    const fix =
      like.length > 0
        ? indexAdvice(
            text(node, "Filter"),
            text(node, "Relation Name")!,
            input.indexes?.get(relationKey(node)),
          )
        : input.hasSearch
          ? `add an index that starts with ${starts} and ends with the sort columns; for the search, a lower(column) trigram index (gin_trgm_ops) lets PostgreSQL find the matches without walking the sort index`
          : `add an index that starts with ${starts} and ends with the sort columns, so the filter and the order come from one index`;
    if (analyzed) {
      const removed = (number(node, "Rows Removed by Filter") ?? 0) * loops(node);
      const returned = actualRows(node);
      if (
        removed >= thresholds.walkedRows &&
        removed >= thresholds.misestimateFactor * Math.max(returned, 1)
      ) {
        warnings.push({
          code: "index-walk",
          message: `walks ${formatNumber(returned + removed)} rows of ${name} to find ${formatNumber(returned)} matching rows: the filter is checked row by row after the index`,
          fix,
          basis,
        });
      }
    } else {
      const tuples = input.tables.get(relationKey(node));
      const matches = number(node, "Plan Rows") ?? 0;
      const needed =
        (number(context.limit ?? node, "Plan Rows") ?? 0) +
        (stage === "ids" ? input.pagination.offset : 0);
      if (tuples !== undefined && tuples > 0 && matches > 0 && needed > 0) {
        const walked = Math.min(tuples, (needed * tuples) / matches);
        if (walked >= thresholds.walkedRows && walked >= thresholds.misestimateFactor * needed) {
          warnings.push({
            code: "index-walk",
            message: `expects to walk about ${formatNumber(walked)} rows of ${name} to find ${formatNumber(needed)} matching rows: the filter is checked row by row after the index`,
            fix,
            basis,
          });
        }
      }
    }
  }

  // misestimate: only a measurement can show it
  if (analyzed) {
    let worst:
      | {
          score: number;
          planned: number;
          actual: number;
          label: string;
          relation?: string;
          implied: boolean;
          filter?: string;
          indexed?: string;
        }
      | undefined;
    const consider = (
      planned: number,
      actual: number,
      label: string,
      relation?: string,
      implied = false,
      filter?: string,
      indexed?: string,
    ) => {
      const low = Math.min(planned, actual);
      const high = Math.max(planned, actual);
      if (
        high - low < thresholds.misestimateRows ||
        high / Math.max(low, 1) < thresholds.misestimateFactor
      )
        return;
      if (!worst || high - low > worst.score) {
        worst = { score: high - low, planned, actual, label, relation, implied, filter, indexed };
      }
    };
    for (const { node, context } of all) {
      if (loops(node) === 0 || node["Node Type"] === "Limit") continue;
      if (number(node, "Plan Rows") === undefined) continue;
      const planned = (number(node, "Plan Rows") ?? 0) * loops(node);
      const actual = actualRows(node);
      const relation =
        text(node, "Relation Name") ??
        nodes(node)
          .find((inner) => isScan(inner.node))
          ?.node["Relation Name"]?.toString();
      const label = relation ? `${relation}` : node["Node Type"].toLowerCase();
      // A parent that stops early explains fewer rows than planned, but never more.
      if (context.early && actual <= planned) {
        if (isScan(node) && text(node, "Filter") !== undefined) {
          const tuples = input.tables.get(relationKey(node));
          const removed = (number(node, "Rows Removed by Filter") ?? 0) * loops(node);
          if (tuples !== undefined && tuples > 0 && actual > 0) {
            // The walk read `actual + removed` rows to find `actual` matches: it implies the total.
            consider(
              planned,
              Math.min(tuples, (tuples * actual) / (actual + removed)),
              label,
              relation,
              true,
              text(node, "Filter"),
              text(node, "Index Cond"),
            );
          }
        }
        continue;
      }
      const conditions = conditionsOf(node);
      consider(planned, actual, label, relation, false, conditions.filter, conditions.indexed);
    }
    const found = worst as
      | {
          planned: number;
          actual: number;
          label: string;
          relation?: string;
          implied: boolean;
          filter?: string;
          indexed?: string;
        }
      | undefined;
    if (found) {
      const factor = Math.round(
        Math.max(found.planned, found.actual) / Math.max(Math.min(found.planned, found.actual), 1),
      );
      const direction = found.actual > found.planned ? "more" : "fewer";
      warnings.push({
        code: "misestimate",
        message: found.implied
          ? `PostgreSQL expected ${formatNumber(found.planned)} matching rows in ${found.label}, but the rows it walked imply about ${formatNumber(found.actual)} (${formatNumber(factor)}x ${direction}), so it can pick a plan that is slow at this size`
          : `PostgreSQL expected ${formatNumber(found.planned)} rows from ${found.label} but got ${formatNumber(found.actual)} (${formatNumber(factor)}x ${direction}), so it can pick a plan that is slow at this size`,
        fix: misestimateFix(
          found.filter,
          found.indexed,
          found.relation,
          found.relation
            ? [...(input.indexes ?? [])].find(([key]) => key.endsWith(`.${found.relation}`))?.[1]
            : undefined,
        ),
        basis,
      });
    }
  }

  // seq-scan: a selective filter that no index serves
  const seen = new Set<string>();
  for (const { node, context } of scans) {
    if (!node["Node Type"].endsWith("Seq Scan") || text(node, "Filter") === undefined) continue;
    const key = relationKey(node);
    if (seen.has(key)) continue;
    const examined = analyzed ? rowsReadBy(node) : estimatedRead(node, context, input);
    const kept = analyzed ? actualRows(node) : plannedRows(node, context);
    if (examined < thresholds.rows || kept / Math.max(examined, 1) >= thresholds.seqScanKeep)
      continue;
    seen.add(key);
    const filter = text(node, "Filter")!;
    warnings.push({
      code: "seq-scan",
      message: `reads ${about}${formatNumber(examined)} rows of ${text(node, "Relation Name")} to keep ${about}${formatNumber(kept)}: it checks the filter ${filter.length > 90 ? `${filter.slice(0, 87)}...` : filter} on every row`,
      fix: indexAdvice(filter, text(node, "Relation Name")!, input.indexes?.get(relationKey(node))),
      basis,
    });
  }

  // full-count: an exact count that reads every matching row
  if (
    (stage === "count" || input.carriesCount) &&
    !all.some(({ node }) => node["Node Type"] === "Limit")
  ) {
    const bottom = all.filter(
      ({ node }) =>
        node["Node Type"] === "Aggregate" &&
        !all.some(
          ({ node: other }) =>
            other !== node &&
            other["Node Type"] === "Aggregate" &&
            nodes(node).some((inner) => inner.node === other),
        ),
    );
    const matched = bottom.reduce(
      (total, { node, context }) =>
        total +
        (node.Plans ?? []).reduce(
          (sum, child) => sum + (analyzed ? actualRows(child) : plannedRows(child, context)),
          0,
        ),
      0,
    );
    if (bottom.length > 0 && read >= thresholds.rows && matched > input.countCap) {
      warnings.push({
        code: "full-count",
        message:
          stage === "count"
            ? `${analyzed ? "reads" : "expects to read"} ${about}${formatNumber(read)} rows to return one number`
            : `the exact count rides in this ${stage} statement, which ${analyzed ? "reads" : "expects to read"} ${about}${formatNumber(read)} rows to produce it`,
        fix: `count: "capped" stops after ${formatNumber(input.countCap + 1)} rows and shows "${formatNumber(input.countCap)}+" instead`,
        basis,
      });
    }
  }

  // single-cpu-facets: facets sharing one GROUPING SETS statement
  if (stage === "facets" && input.groupingSets && read >= thresholds.rows) {
    const parallel = all.some(
      ({ node }) => node["Node Type"] === "Aggregate" && node["Partial Mode"] === "Partial",
    );
    if (!parallel) {
      const count = input.facets?.length ?? 0;
      warnings.push({
        code: "single-cpu-facets",
        message: `${count} facets (${input.facets?.join(", ")}) share one GROUPING SETS statement, which PostgreSQL runs on one CPU while it reads ${about}${formatNumber(read)} rows`,
        fix:
          input.facetSplitAbove === Infinity
            ? "set query.facets.splitAbove to a number of rows: above it each facet runs as its own statement, which can use parallel workers"
            : `lower query.facets.splitAbove (now ${formatNumber(input.facetSplitAbove)}): above it each facet runs as its own statement, which can use parallel workers`,
        basis,
      });
    }
  }

  const accessed = [...new Set(scans.map(({ node }) => describeScan(node)))];
  const summary =
    scans.length === 0
      ? "no table scan"
      : `${accessed.length > 2 ? `${accessed.slice(0, 2).join(", ")} and ${accessed.length - 2} more` : accessed.join(", ")}, ${about}${formatNumber(read)} rows read`;

  return {
    warnings,
    summary,
    ...(analyzed ? { rowsRead: read, rowsReturned: actualRows(plan) } : {}),
  };
}

function parsePlan(rows: unknown): {
  plan: Node;
  executionTime?: number;
} {
  const first = (rows as Array<Record<string, unknown>>)[0]?.["QUERY PLAN"];
  const parsed = (typeof first === "string" ? JSON.parse(first) : first) as Array<{
    Plan: Node;
    "Execution Time"?: number;
  }>;
  const entry = parsed[0];
  if (!entry?.Plan) throw new Error("PostgreSQL returned no plan for the statement");
  return { plan: entry.Plan, executionTime: entry["Execution Time"] };
}

const rollback = Symbol("explain-rollback");

async function tableSizes(database: QueryEngineDb, plans: Node[]) {
  const sizes = new Map<string, number>();
  const relations = new Map<string, { schema: string; name: string }>();
  for (const plan of plans) {
    walk(plan, (node) => {
      if (isScan(node)) {
        relations.set(relationKey(node), {
          schema: text(node, "Schema") ?? "public",
          name: text(node, "Relation Name")!,
        });
      }
    });
  }
  if (relations.size === 0) return sizes;
  try {
    const pairs = sql.join(
      [...relations.values()].map(({ schema, name }) => sql`(${schema}::text, ${name}::text)`),
      sql`, `,
    );
    const rows = await (database as any).execute(
      sql`
        select wanted.schema as schema, wanted.name as name, class.reltuples::float8 as tuples
        from (values ${pairs}) as wanted(schema, name)
        join pg_catalog.pg_namespace as namespace on namespace.nspname = wanted.schema
        join pg_catalog.pg_class as class
          on class.relnamespace = namespace.oid and class.relname = wanted.name
      `,
      "objects",
    );
    for (const row of rows as Array<{ schema: string; name: string; tuples: number }>) {
      sizes.set(`${row.schema}.${row.name}`, Number(row.tuples));
    }
  } catch {
    // sizes only sharpen the estimates of a plan that was not run
  }
  return sizes;
}

/** The index definitions of the relations in the plans, by `schema.relation`. */
async function tableIndexes(database: QueryEngineDb, plans: Node[]) {
  const indexes = new Map<string, string[]>();
  const relations = new Map<string, { schema: string; name: string }>();
  for (const plan of plans) {
    walk(plan, (node) => {
      if (isScan(node)) {
        relations.set(relationKey(node), {
          schema: text(node, "Schema") ?? "public",
          name: text(node, "Relation Name")!,
        });
      }
    });
  }
  if (relations.size === 0) return indexes;
  try {
    const pairs = sql.join(
      [...relations.values()].map(({ schema, name }) => sql`(${schema}::text, ${name}::text)`),
      sql`, `,
    );
    const rows = await (database as any).execute(
      sql`
        select listed.schemaname as schema, listed.tablename as name, listed.indexdef as definition
        from pg_catalog.pg_indexes as listed
        join (values ${pairs}) as wanted(schema, name)
          on wanted.schema = listed.schemaname and wanted.name = listed.tablename
      `,
      "objects",
    );
    for (const row of rows as Array<{ schema: string; name: string; definition: string }>) {
      const key = `${row.schema}.${row.name}`;
      indexes.set(key, [...(indexes.get(key) ?? []), row.definition]);
    }
  } catch {
    // the advice then assumes no index exists
  }
  return indexes;
}

export interface ExplainRun {
  resource: string;
  database: QueryEngineDb;
  request: QueryRequest;
  captured: CapturedStatement[];
  /**
   * `facets.whenCapped: "skip"` with a capped or estimated count: query runs the facets only when
   * the count stays within its cap.
   */
  skipsFacetsAboveCap?: boolean;
  planning: QueryEvent[];
  analyze: boolean;
  countCap: number;
  /** The resource's `query.timeouts`, in milliseconds. */
  timeouts?: { count?: number; facets?: number; summary?: number };
  facetSplitAbove: number;
  allowsCursor: boolean;
  relationSorts: readonly string[];
  ignoreFilter: (node: object) => boolean;
  notes: string[];
}

type Entry = CapturedStatement & { stage: ExplainStageName };

interface Explained {
  entry: Entry;
  plan?: Node;
  executionTime?: number;
  /** The plan carries measurements. */
  measured: boolean;
  /** The attempt ran over the budget the engine gave it. */
  exceeded?: boolean;
  /** The attempt would fail: the connection cancels it before its budget. */
  failure?: string;
  /** The budget the attempt ran under, after the connection's own `statement_timeout`. */
  budgetMs?: number;
  /** The ordinary plan again, with no budget, after the attempts before it ran over. */
  final?: boolean;
  /** Which attempt of its statement this row is, and for a page, which count outcome selects it. */
  role?: { nth: number; outcome?: "at cap" | "under cap" };
  /** The stage's `query.timeouts` value, under analyze. */
  timeout?: { ms: number; exceeded: boolean };
  /** Same statement as an earlier row: its warnings are not repeated. */
  duplicate?: boolean;
}

/** How a count that was measured under `analyze` came out. */
interface CountOutcome {
  counted: number;
  /** A capped count under its cap is exact: the page then starts on the indexed plan. */
  underCap: boolean;
}

/** EXPLAIN every captured statement, one after the other, and read what the plans say. */
export async function explainCaptured(run: ExplainRun): Promise<ExplainReport> {
  const { database, analyze } = run;
  if (!isPostgresDatabase(database)) {
    throw new Error(
      "explain() needs a PostgreSQL database: it runs EXPLAIN on the statements the engine builds",
    );
  }
  const inStages = (entry: CapturedStatement): entry is Entry => entry.stage in stageOrder;
  const captured = run.captured.filter(inStages);
  const budgeted = (entry: Entry) => entry.attempt !== undefined && entry.budget !== undefined;
  // Stages come in the order the request runs them: the page's ids last, a count before them.
  const rank = new Map<ExplainStageName, number>();
  for (const entry of captured) if (!rank.has(entry.stage)) rank.set(entry.stage, rank.size);
  const statements = captured.toSorted(
    (left, right) => rank.get(left.stage)! - rank.get(right.stage)!,
  );
  // The count and the page of a search without an exact count each have their own attempts.
  const attemptAt = (stage: ExplainStageName, attempt: "ordinary" | "indexed") =>
    statements.findIndex((e) => e.stage === stage && e.attempt === attempt && budgeted(e));
  // A capped count steers the page that follows it.
  // An estimated count over a search across tables falls back to a capped one.
  const informed =
    run.request.pagination.count === "capped" ||
    (run.request.pagination.count === "estimated" && attemptAt("count", "ordinary") >= 0);
  // `query` sets no timeouts inside a transaction the caller passed in.
  const timeouts = isCallerTransaction(database) ? {} : (run.timeouts ?? {});

  const plainPrefix = sql`explain (verbose, format json)`;
  const analyzePrefix = sql`explain (analyze, buffers, verbose, format json)`;

  /**
   * A budgeted attempt runs as the engine runs it: `runTimed` is the engine's own clock and
   * timeout. A cancel after the budget is the budget running out; a cancel before it is the
   * connection's own timeout, which the engine does not catch, so query throws it.
   */
  async function attemptWithin(
    db: QueryEngineDb,
    entry: Entry,
    budget: number,
    options: { capToCurrent: boolean } = { capToCurrent: true },
  ) {
    const outcome = await runTimed(
      db,
      budget,
      (timed) => (timed as any).execute(sql`${analyzePrefix} ${entry.statement}`, "objects"),
      options,
    );
    if (outcome.kind === "ok") {
      return {
        ...parsePlan(outcome.value),
        measured: true,
        budgetMs: outcome.effective,
      } as Omit<Explained, "entry">;
    }
    const rows = await (db as any).execute(sql`${plainPrefix} ${entry.statement}`, "objects");
    return {
      ...parsePlan(rows),
      executionTime: outcome.elapsed,
      measured: false,
      budgetMs: outcome.effective,
      ...(outcome.kind === "exceeded"
        ? { exceeded: true }
        : {
            failure: `would fail: the connection's statement_timeout (${outcome.effective} ms) cancels it before its ${budget} ms budget, so query throws the cancel error`,
          }),
    } as Omit<Explained, "entry">;
  }

  async function explainAll(db: QueryEngineDb) {
    const results: Explained[] = statements.map((entry) => ({ entry, measured: false }));
    /** The ordinary plan run again with no budget, after the indexed plan of the same statement. */
    const finals = new Map<number, Explained>();
    let failed = false;
    let countOutcome: CountOutcome | undefined;
    let facetsSkipped: { counted: number } | undefined;
    let countTimedOut = false;
    // Which attempt each budgeted statement ended on, for the notes.
    const kept = new Map<
      ExplainStageName,
      "ordinary" | "indexed" | "final" | "failed" | "timeout"
    >();
    let pageFirst: "ordinary" | "indexed" | undefined;

    /** The rows a measured count matched: its Limit, or what its aggregate was fed. */
    const countedBy = (plan: Node) => {
      const all = nodes(plan);
      const limit = all.find(({ node }) => node["Node Type"] === "Limit");
      if (limit) return actualRows(limit.node);
      const aggregates = all.filter(({ node }) => node["Node Type"] === "Aggregate");
      const bottom = aggregates.filter(
        ({ node }) =>
          !aggregates.some(
            ({ node: other }) =>
              other !== node && nodes(node).some((inner) => inner.node === other),
          ),
      );
      return bottom.length > 0
        ? bottom.reduce(
            (total, { node }) =>
              total + (node.Plans ?? []).reduce((sum, child) => sum + actualRows(child), 0),
            0,
          )
        : undefined;
    };
    const decide = (result: Explained | undefined) => {
      if (!result?.plan || result.exceeded || result.timeout?.exceeded) return;
      const counted = countedBy(result.plan);
      if (counted === undefined) return;
      countOutcome = { counted, underCap: counted <= run.countCap };
      if (run.skipsFacetsAboveCap && !countOutcome.underCap) facetsSkipped = { counted };
    };
    /** The page does not run when the count is exactly 0: query returns before it. */
    const pageSkipped = () => countOutcome?.counted === 0;

    /** One statement's attempts, in the order the engine tries them. */
    async function sequence(
      stage: ExplainStageName,
      first: "ordinary" | "indexed",
      outcome?: "at cap" | "under cap",
    ) {
      const ordinaryAt = attemptAt(stage, "ordinary");
      const indexedAt = attemptAt(stage, "indexed");
      const stageTimeout = stage === "count" ? timeouts.count : undefined;
      const tried: Array<[number, "ordinary" | "indexed"]> = [];
      if (first === "ordinary" && ordinaryAt >= 0) tried.push([ordinaryAt, "ordinary"]);
      if (indexedAt >= 0) tried.push([indexedAt, "indexed"]);
      let nth = 0;
      for (const [at, kind] of tried) {
        nth += 1;
        const entry = statements[at]!;
        // `query.timeouts` caps each attempt, as the connection's own timeout does.
        const budget = Math.min(entry.budget!, stageTimeout ?? Number.POSITIVE_INFINITY);
        const attempt = await attemptWithin(db, entry, budget);
        results[at] = { entry, ...attempt, role: { nth, outcome } };
        if (attempt.failure) {
          failed = true;
          kept.set(stage, "failed");
          return results[at];
        }
        if (!attempt.exceeded) {
          kept.set(stage, kind);
          return results[at];
        }
      }
      const entry = statements[ordinaryAt]!;
      nth += 1;
      let final: Explained;
      if (stageTimeout !== undefined) {
        // The ordinary plan with no budget still runs under the stage's timeout.
        const attempt = await attemptWithin(db, entry, stageTimeout, { capToCurrent: false });
        final = {
          entry,
          ...attempt,
          final: true,
          role: { nth, outcome },
          timeout: { ms: stageTimeout, exceeded: attempt.exceeded === true },
        };
        if (attempt.failure) {
          failed = true;
          kept.set(stage, "failed");
        } else if (attempt.exceeded) {
          countTimedOut = true;
          kept.set(stage, "timeout");
        } else kept.set(stage, "final");
      } else {
        const rows = await (db as any).execute(sql`${analyzePrefix} ${entry.statement}`, "objects");
        final = { entry, ...parsePlan(rows), measured: true, final: true, role: { nth, outcome } };
        kept.set(stage, "final");
      }
      finals.set(indexedAt >= 0 ? indexedAt : ordinaryAt, final);
      return final;
    }

    /** A statement that is not budgeted: it runs plain, under its stage's `query.timeouts`. */
    const plainOne = async (index: number) => {
      const entry = statements[index]!;
      const stageTimeout =
        analyze && entry.stage !== "ids"
          ? timeouts[entry.stage as "count" | "facets" | "summary"]
          : undefined;
      if (stageTimeout !== undefined) {
        const attempt = await attemptWithin(db, entry, stageTimeout, { capToCurrent: false });
        Object.assign(results[index]!, attempt, {
          timeout: { ms: stageTimeout, exceeded: attempt.exceeded === true },
        });
        if (attempt.failure) failed = true;
        if (attempt.exceeded && entry.stage === "count") countTimedOut = true;
        return;
      }
      const rows = await (db as any).execute(
        sql`${analyze ? analyzePrefix : plainPrefix} ${entry.statement}`,
        "objects",
      );
      Object.assign(results[index]!, parsePlan(rows), { measured: analyze });
    };

    if (!analyze) {
      for (const index of statements.keys()) await plainOne(index);
      // Without the count's value, every path the page can take is listed, one role per row.
      const rows: Explained[] = [];
      const shown = new Set<string>();
      for (const [index, entry] of statements.entries()) {
        if (!budgeted(entry)) {
          rows.push(results[index]!);
          continue;
        }
        if (entry.attempt === "indexed") continue;
        const stage = entry.stage;
        const ordinary = results[index]!;
        const indexed = results[attemptAt(stage, "indexed")]!;
        const paths: Array<{
          outcome?: "at cap" | "under cap";
          order: Array<"ordinary" | "indexed" | "final">;
        }> =
          stage === "ids" && informed
            ? [
                { outcome: "at cap", order: ["ordinary", "indexed", "final"] },
                { outcome: "under cap", order: ["indexed", "final"] },
              ]
            : [{ order: ["ordinary", "indexed", "final"] }];
        for (const path of paths) {
          for (const [position, kind] of path.order.entries()) {
            const source = kind === "indexed" ? indexed : ordinary;
            const key = `${stage}:${kind === "indexed" ? "indexed" : "ordinary"}`;
            rows.push({
              ...source,
              final: kind === "final",
              role: { nth: position + 1, outcome: path.outcome },
              duplicate: shown.has(key),
            });
            shown.add(key);
          }
        }
      }
      return {
        rows,
        kept,
        countOutcome,
        facetsSkipped,
        pageFirst,
        countTimedOut,
        pageSkipped: false,
      };
    }
    // The count first: it decides the facets and the page. Then the rest, in run order.
    if (attemptAt("count", "ordinary") >= 0) {
      decide(await sequence("count", "ordinary"));
    }
    for (const [index, entry] of statements.entries()) {
      if (failed) break;
      if (budgeted(entry) || entry.stage === "ids") continue;
      if (facetsSkipped && entry.stage === "facets") continue;
      await plainOne(index);
      if (entry.stage === "count") decide(results[index]);
    }
    const skipPage = pageSkipped();
    if (!failed && !skipPage && attemptAt("ids", "ordinary") >= 0) {
      // A capped count that came back under its cap is exact and small: the indexed plan reads at
      // most that many matches. One that hit the cap says the matches are common. A count that
      // timed out, or an estimated one, steers nothing.
      pageFirst = informed && countOutcome?.underCap ? "indexed" : "ordinary";
      await sequence(
        "ids",
        pageFirst,
        informed && countOutcome ? (countOutcome.underCap ? "under cap" : "at cap") : undefined,
      );
    }
    for (const [index, entry] of statements.entries()) {
      if (failed || skipPage) break;
      if (entry.stage === "ids" && !budgeted(entry)) await plainOne(index);
    }
    const rows = results.flatMap((result, index) => {
      const final = finals.get(index);
      return final ? [result, final] : [result];
    });
    return {
      rows,
      kept,
      countOutcome,
      facetsSkipped,
      pageFirst,
      countTimedOut,
      pageSkipped: skipPage,
    };
  }

  let explained: Explained[] = [];
  let kept = new Map<ExplainStageName, "ordinary" | "indexed" | "final" | "failed" | "timeout">();
  let countOutcome: CountOutcome | undefined;
  let facetsSkipped: { counted: number } | undefined;
  let countTimedOut = false;
  let pageSkipped = false;
  const assemble = (done: Awaited<ReturnType<typeof explainAll>>) => {
    explained = done.rows;
    ({ kept, countOutcome, facetsSkipped, countTimedOut, pageSkipped } = done);
  };
  if (analyze) {
    // EXPLAIN ANALYZE runs the statements for real: do it where nothing can be kept.
    try {
      await (database as any).transaction(
        async (transaction: QueryEngineDb) => {
          assemble(await explainAll(transaction));
          throw rollback;
        },
        { accessMode: "read only" },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  } else {
    assemble(await explainAll(database));
  }
  const ran = explained.filter(
    (result): result is Explained & { plan: Node } => result.plan !== undefined,
  );

  const tables = await tableSizes(
    database,
    ran.map(({ plan }) => plan),
  );
  const indexes = await tableIndexes(
    database,
    ran.map(({ plan }) => plan),
  );
  const { shape, key } = describeRequestShape(run.resource, run.request, run.ignoreFilter);
  const { pagination } = run.request;
  const pageSize = pagination.pageSize <= 0 ? 25 : pagination.pageSize;
  const offset =
    pagination.mode === "offset" ? (Math.max(pagination.pageIndex, 1) - 1) * pageSize : 0;
  // Under analyze the count is measured: say what query does, instead of what it might do.
  const notes = run.notes.filter(
    (note) => !analyze || !note.startsWith('facets.whenCapped is "skip"'),
  );
  if (analyze && run.skipsFacetsAboveCap) {
    notes.push(
      facetsSkipped
        ? `facets.whenCapped is "skip" and the count passes ${formatNumber(run.countCap)} (it read ${formatNumber(facetsSkipped.counted)} rows): query skips the facets, so they are not run here`
        : `facets.whenCapped is "skip", but the count stays within ${formatNumber(run.countCap)}: query runs the facets`,
    );
  }
  const millis = (value: number | undefined) => (value === undefined ? "" : `${value} ms`);

  // Reading the connection's timeout runs nothing, so a plain explain can still warn about it.
  const firstAttempt = statements.find((e) => e.attempt === "ordinary" && budgeted(e));
  if (!analyze && firstAttempt) {
    try {
      const [row] = (await (database as any).execute(
        sql`select current_setting('statement_timeout') as value`,
        "objects",
      )) as Array<{ value: string }>;
      const timeout = parseDurationMilliseconds(row?.value) ?? 0;
      const budget = firstAttempt.budget!;
      if (timeout > 0 && timeout < budget - Math.min(5, budget * 0.1)) {
        notes.push(
          `search: the connection's statement_timeout (${formatNumber(timeout)} ms) is below the ${budget} ms plan budget: the budgeted attempts are capped to it, and the ordinary plan then runs again with no budget, so a statement that needs longer than ${formatNumber(timeout)} ms fails with the cancel error`,
        );
      }
    } catch {
      // the setting only sharpens the notes
    }
  }

  const stages = ran.map(
    ({
      entry,
      plan,
      executionTime,
      measured,
      exceeded,
      failure,
      budgetMs,
      final,
      role,
      timeout,
      duplicate,
    }): ExplainStage => {
      const analysis = analyzePlan({
        stage: entry.stage,
        plan,
        analyzed: measured,
        tables,
        countCap: run.countCap,
        facetSplitAbove: run.facetSplitAbove,
        root: run.resource,
        pagination: {
          mode: pagination.mode,
          offset,
          pageSize,
          pageIndex: pagination.mode === "offset" ? pagination.pageIndex : 1,
        },
        allowsCursor: run.allowsCursor,
        hasSearch: run.request.search.value.length > 0,
        relationSorts: run.relationSorts,
        groupingSets: entry.groupingSets === true,
        carriesCount: entry.carriesCount === true,
        facets: entry.facets,
        indexes,
      });
      const ordinal = (position: number) => ["1st", "2nd", "3rd"][position - 1] ?? `${position}th`;
      const kind = final ? "ordinary" : entry.attempt;
      // One role per row: which attempt of which statement, and for a page the count outcome.
      const attempt =
        role && kind
          ? `${entry.stage === "count" ? "count" : "page"}${role.outcome ? ` · count ${role.outcome}` : ""}: ${ordinal(role.nth)} attempt, ${final ? "no budget" : millis(entry.budget)}, ${kind} plan`
          : undefined;
      const label = [
        entry.stage === "facets" && entry.facets
          ? `${entry.facets.join(", ")}${entry.groupingSets ? " (GROUPING SETS)" : ""}`
          : undefined,
        attempt,
        entry.note,
      ]
        .filter(Boolean)
        .join("; ");
      const summary = duplicate
        ? `the statement of an earlier row: ${analysis.summary}`
        : failure
          ? `${failure}; planned: ${analysis.summary}`
          : timeout?.exceeded
            ? `stopped at query.timeouts.${entry.stage === "ids" ? "page" : entry.stage} (${millis(timeout.ms)}); planned: ${analysis.summary}`
            : exceeded
              ? `stopped at its ${millis(budgetMs)} budget; planned: ${analysis.summary}`
              : analysis.summary;
      return {
        stage: entry.stage,
        ...(label ? { label } : {}),
        sql: statementText(entry.statement),
        ...(executionTime !== undefined && (measured || exceeded || failure)
          ? { ms: executionTime }
          : {}),
        ...(analysis.rowsRead === undefined ? {} : { rowsRead: analysis.rowsRead }),
        ...(analysis.rowsReturned === undefined ? {} : { rowsReturned: analysis.rowsReturned }),
        summary,
        plan,
        warnings: duplicate ? [] : analysis.warnings,
        ...(failure ? { failure } : {}),
        ...(timeout ? { timeout } : {}),
        ...(role ? { attemptNumber: role.nth } : {}),
        ...(role?.outcome ? { countOutcome: role.outcome } : {}),
        ...(entry.attempt === undefined
          ? {}
          : {
              attempt: entry.attempt,
              ...(final ? { final: true } : {}),
              ...(budgeted(entry) && !final && analyze
                ? { budget: { ms: budgetMs ?? entry.budget!, exceeded: exceeded === true } }
                : {}),
            }),
      };
    },
  );

  // Say which attempt query keeps for the count and for the page, and why.
  for (const stage of ["count", "ids"] as const) {
    const first = ran.find(
      ({ entry, final }) =>
        !final && entry.stage === stage && entry.attempt === "ordinary" && budgeted(entry),
    );
    const second = ran.find(
      ({ entry }) => entry.stage === stage && entry.attempt === "indexed" && budgeted(entry),
    );
    if (!first && !second) continue;
    const what = stage === "count" ? "the count" : "the page";
    const ordinaryBudget = first?.budgetMs ?? first?.entry.budget ?? second?.entry.budget;
    const indexedBudget = second?.budgetMs ?? second?.entry.budget;
    const steered = stage === "ids" && informed;
    if (analyze) {
      const outcome = kept.get(stage);
      const why =
        steered && countOutcome
          ? countOutcome.underCap
            ? `the count came back under its cap (${formatNumber(countOutcome.counted)} rows), so ${what} starts on the indexed plan; `
            : `the count hit its cap, so ${what} starts on the ordinary plan; `
          : steered && countTimedOut
            ? `the count timed out, so ${what} takes the per-statement path; `
            : "";
      const body =
        outcome === "timeout"
          ? `the ordinary plan, run with no budget, ran over query.timeouts.count (${formatNumber(timeouts.count ?? 0)} ms): query reports no count (pageInfo count "none", reason "timeout") and goes on`
          : outcome === "failed"
            ? `${ran.find(({ failure, entry }) => failure && entry.stage === stage)?.failure ?? ""}: the request fails there, so later statements are not run`
            : outcome === "ordinary"
              ? `the ordinary plan finished within its ${ordinaryBudget} ms budget, so query keeps it and never runs the indexed plan`
              : outcome === "indexed"
                ? `${first?.exceeded ? `the ordinary plan ran over its ${ordinaryBudget} ms budget and ` : ""}the indexed plan finished within its ${indexedBudget} ms, so query keeps it; ${what} pays ${first?.exceeded ? `the first ${ordinaryBudget} ms on every request with this search` : "nothing extra"}`
                : `${first?.exceeded ? `the ordinary plan ran over its ${ordinaryBudget} ms budget and ` : ""}the indexed plan ran over its ${indexedBudget} ms too, so query runs the ordinary plan again with no budget and keeps it`;
      notes.push(`search, ${what}: ${why}${body}`);
    } else if (first && second) {
      const cost = (node: Node) => number(node, "Total Cost") ?? 0;
      const ordinaryCost = cost(first.plan);
      const indexedCost = cost(second.plan);
      notes.push(
        `search, ${what}: the engine runs the ordinary plan with a ${ordinaryBudget} ms budget; if that runs over it tries the indexed plan with ${indexedBudget} ms; if that runs over too it runs the ordinary plan again with no budget${steered ? ". The count steers it: when the count comes back under its cap the page starts on the indexed plan, and when the count hits the cap it starts on the ordinary plan" : ""}. It cannot know which before running. PostgreSQL costs the ordinary plan at ${formatNumber(ordinaryCost)} and the indexed plan at ${formatNumber(indexedCost)}, so ${indexedCost < ordinaryCost ? "it expects the indexed plan to be cheaper: a rare term falls back to it" : "it expects the ordinary plan to be the cheaper one"}`,
      );
    }
  }

  if (analyze && pageSkipped) {
    notes.push(
      "the count is 0, so query returns before it runs the page: the page is not run here either",
    );
  }
  if (!analyze) {
    const configured = (["count", "facets", "summary"] as const)
      .filter((stage) => timeouts[stage] !== undefined)
      .map((stage) => `${stage} ${formatNumber(timeouts[stage]!)} ms`);
    if (configured.length > 0) {
      notes.push(
        `query.timeouts (${configured.join(", ")}) apply when the statements run; a plain explain runs nothing, and analyze applies them`,
      );
    }
  }

  return {
    resource: run.resource,
    shape,
    shapeKey: cloneShape(key),
    analyzed: analyze,
    stages,
    planning: run.planning.map(({ stage, sql: statement, ms, rows }) => ({
      stage,
      sql: statement,
      ms,
      rows,
    })),
    notes,
  };
}

function duration(ms: number) {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The report as text for a terminal: one line per stage, with what is slow and what fixes it. */
export function formatExplain(report: ExplainReport): string {
  const lines = [report.shape];
  const stageWidth = Math.max(...report.stages.map(({ stage }) => stage.length), 5);
  const timeWidth = 9;
  const indent = `  ${" ".repeat(stageWidth + 2)}${" ".repeat(timeWidth)}`;
  const row = (stage: string, time: string, body: string) =>
    `  ${stage.padEnd(stageWidth + 2)}${time.padEnd(timeWidth)}${body}`;
  for (const stage of report.stages) {
    const time = stage.ms === undefined ? "-" : duration(stage.ms);
    const label = stage.label ? `${stage.label}: ` : "";
    const body = [`${label}${stage.summary}`];
    if (stage.warnings.length === 0) {
      lines.push(row(stage.stage, time, body[0]!));
      continue;
    }
    // The label says which statement the warnings are about, so it always prints.
    if (stage.label) lines.push(row(stage.stage, time, stage.label));
    stage.warnings.forEach((warning, index) => {
      const lead = index === 0 && !stage.label ? row(stage.stage, time, "") : indent;
      lines.push(`${lead}${warning.message}`);
      if (warning.fix) lines.push(`${indent}fix: ${warning.fix}`);
    });
  }
  if (report.planning.length > 0) {
    const total = report.planning.reduce((sum, entry) => sum + entry.ms, 0);
    lines.push(
      row(
        "plan",
        duration(total),
        `${report.planning.length} statement${report.planning.length === 1 ? "" : "s"} ran while planning`,
      ),
    );
  }
  if (!report.analyzed) {
    lines.push("", "plan only, nothing was executed: pass analyze: true for timings and rows read");
  }
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}
