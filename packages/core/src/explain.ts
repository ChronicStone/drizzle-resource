import { sql } from "drizzle-orm";
import { isPostgresDatabase } from "./postgres.js";
import { describeRequestShape, statementText } from "./observe.js";
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
}

function walk(node: Node, visit: (node: Node, context: Context) => void, context?: Context) {
  const current = context ?? { early: false, workers: 0 };
  visit(node, current);
  const type = node["Node Type"];
  const next: Context = {
    early: type === "Limit" ? true : blocking.has(type) ? false : current.early,
    limit: type === "Limit" ? node : current.limit,
    workers:
      type === "Gather" || type === "Gather Merge"
        ? (number(node, "Workers Planned") ?? 0)
        : current.workers,
  };
  for (const child of node.Plans ?? []) walk(child, visit, next);
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
  /** The root table of the resource. */
  root: string;
  pagination: { mode: "offset" | "cursor"; offset: number; pageSize: number; pageIndex: number };
  allowsCursor: boolean;
  hasSearch: boolean;
  /** Sort fields that live on a related table. */
  relationSorts: readonly string[];
  /** The statement answers several facets through GROUPING SETS. */
  groupingSets: boolean;
  facets?: readonly string[];
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

/** Decide what a plan says. Pure: a plan, what the request asked for, and sizes in. */
export function analyzePlan(input: AnalysisInput): Analysis {
  const { plan, analyzed, stage } = input;
  const all = nodes(plan);
  const scans = all.filter(({ node }) => isScan(node));
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
      basis: "measured",
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
    const fix = input.hasSearch
      ? "add an index that starts with the filtered columns and ends with the sort columns; for the search, a lower(column) trigram index (gin_trgm_ops) lets PostgreSQL find the matches without walking the sort index"
      : "add an index that starts with the filtered columns and ends with the sort columns, so the filter and the order come from one index";
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
        }
      | undefined;
    const consider = (
      planned: number,
      actual: number,
      label: string,
      relation?: string,
      implied = false,
    ) => {
      const low = Math.min(planned, actual);
      const high = Math.max(planned, actual);
      if (
        high - low < thresholds.misestimateRows ||
        high / Math.max(low, 1) < thresholds.misestimateFactor
      )
        return;
      if (!worst || high - low > worst.score) {
        worst = { score: high - low, planned, actual, label, relation, implied };
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
            );
          }
        }
        continue;
      }
      consider(planned, actual, label, relation);
    }
    const found = worst as
      | {
          planned: number;
          actual: number;
          label: string;
          relation?: string;
          implied: boolean;
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
        fix: `run ANALYZE${found.relation ? ` ${found.relation}` : ""}; if the estimate stays off, create extended statistics (CREATE STATISTICS) on the filtered columns, or put the filtered column on the root table`,
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
      message: `reads ${about}${formatNumber(examined)} rows of ${text(node, "Relation Name")} to keep ${about}${formatNumber(kept)}: no index serves the filter ${filter.length > 90 ? `${filter.slice(0, 87)}...` : filter}`,
      fix: `add an index on the filtered column(s) of ${text(node, "Relation Name")}`,
      basis,
    });
  }

  // full-count: an exact count that reads every matching row
  if (stage === "count" && !all.some(({ node }) => node["Node Type"] === "Limit")) {
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
        message: `${analyzed ? "reads" : "expects to read"} ${about}${formatNumber(read)} rows to return one number`,
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
        fix: "request fewer facets at once, or load each facet in its own request: a statement with one facet can use parallel workers",
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

export interface ExplainRun {
  resource: string;
  database: QueryEngineDb;
  request: QueryRequest;
  captured: CapturedStatement[];
  planning: QueryEvent[];
  analyze: boolean;
  countCap: number;
  allowsCursor: boolean;
  relationSorts: readonly string[];
  ignoreFilter: (node: object) => boolean;
  notes: string[];
}

/** EXPLAIN every captured statement, one after the other, and read what the plans say. */
export async function explainCaptured(run: ExplainRun): Promise<ExplainReport> {
  const { database, analyze } = run;
  if (!isPostgresDatabase(database)) {
    throw new Error(
      "explain() needs a PostgreSQL database: it runs EXPLAIN on the statements the engine builds",
    );
  }
  const statements = run.captured
    .filter(
      (entry): entry is CapturedStatement & { stage: ExplainStageName } =>
        entry.stage in stageOrder,
    )
    .toSorted((left, right) => stageOrder[left.stage] - stageOrder[right.stage]);

  async function explainAll(db: QueryEngineDb) {
    const prefix = analyze
      ? sql`explain (analyze, buffers, verbose, format json)`
      : sql`explain (verbose, format json)`;
    const plans: Array<{ plan: Node; executionTime?: number }> = [];
    for (const entry of statements) {
      const rows = await (db as any).execute(sql`${prefix} ${entry.statement}`, "objects");
      plans.push(parsePlan(rows));
    }
    return plans;
  }

  let plans: Array<{ plan: Node; executionTime?: number }>;
  if (analyze) {
    // EXPLAIN ANALYZE runs the statements for real: do it where nothing can be kept.
    plans = [];
    try {
      await (database as any).transaction(
        async (transaction: QueryEngineDb) => {
          plans = await explainAll(transaction);
          throw rollback;
        },
        { accessMode: "read only" },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  } else {
    plans = await explainAll(database);
  }

  const tables = await tableSizes(
    database,
    plans.map(({ plan }) => plan),
  );
  const { shape, key } = describeRequestShape(run.resource, run.request, run.ignoreFilter);
  const { pagination } = run.request;
  const pageSize = pagination.pageSize <= 0 ? 25 : pagination.pageSize;
  const offset =
    pagination.mode === "offset" ? (Math.max(pagination.pageIndex, 1) - 1) * pageSize : 0;

  const stages = statements.map((entry, index): ExplainStage => {
    const { plan, executionTime } = plans[index]!;
    const analysis = analyzePlan({
      stage: entry.stage,
      plan,
      analyzed: analyze,
      tables,
      countCap: run.countCap,
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
      facets: entry.facets,
    });
    const label =
      entry.stage === "facets" && entry.facets
        ? `${entry.facets.join(", ")}${entry.groupingSets ? " (GROUPING SETS)" : ""}${entry.note ? `: ${entry.note}` : ""}`
        : entry.note;
    return {
      stage: entry.stage,
      ...(label ? { label } : {}),
      sql: statementText(entry.statement),
      ...(analyze && executionTime !== undefined ? { ms: executionTime } : {}),
      ...(analysis.rowsRead === undefined ? {} : { rowsRead: analysis.rowsRead }),
      ...(analysis.rowsReturned === undefined ? {} : { rowsReturned: analysis.rowsReturned }),
      summary: analysis.summary,
      plan,
      warnings: analysis.warnings,
    };
  });

  return {
    resource: run.resource,
    shape,
    shapeKey: key,
    analyzed: analyze,
    stages,
    planning: run.planning.map(({ stage, sql: statement, ms, rows }) => ({
      stage,
      sql: statement,
      ms,
      rows,
    })),
    notes: run.notes,
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
    stage.warnings.forEach((warning, index) => {
      const lead = index === 0 ? row(stage.stage, time, "") : indent;
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
