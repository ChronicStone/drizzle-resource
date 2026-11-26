import { getColumns, is, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgColumn, PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core/async";

import { createQueryFilterBuilder } from "./filters.js";
import { pageQueryHooks } from "./plan-hook.js";
import { isPostgresDatabase, listPostgresSearchColumns } from "./postgres.js";
import type {
  FieldRegistryEntry,
  FieldRegistryRelationStep,
  QueryEngineDb,
  QueryFilterInput,
  QueryFilterNode,
} from "./types.js";

export type IndexFindingLevel = "error" | "warn" | "info";

export type IndexFindingRule =
  | "default-sort-unindexed"
  | "sort-unindexed"
  | "mixed-direction-sort"
  | "relation-sort"
  | "scope-through-relation"
  | "search-unindexed"
  | "many-to-many-facet"
  | "search-numbers"
  | "open-surface"
  | "exact-count-large-table";

/** One thing `checkIndexes()` found, in plain data. */
export interface IndexFinding {
  /** Root table key of the resource the finding is about. */
  resource: string;
  level: IndexFindingLevel;
  rule: IndexFindingRule;
  /** What is wrong, in plain words. */
  message: string;
  /** Field paths involved. */
  fields: string[];
  /** An index that fixes it, as a Drizzle definition and as SQL. One statement per line. */
  fix?: { drizzle: string; sql: string };
}

export interface CheckIndexesOptions {
  /**
   * Also read the real indexes (btree and pg_trgm) and table sizes from PostgreSQL. The call
   * then returns a promise. Without it, only the Drizzle schema and resource definitions are read.
   */
  live?: boolean;
  /** Database to read when `live` is true. Defaults to the engine's database. */
  db?: QueryEngineDb;
  /**
   * Context passed to `query.scope` so its equality filters can be read. Values are never used
   * in a query. Defaults to a placeholder that answers every property.
   */
  context?: Record<string, unknown>;
  /** Row counts from which a live finding matters. */
  largeTable?: {
    /** Searching a table with no trigram index. Default 100,000. */
    search?: number;
    /** Counting every matching row on each page. Default 1,000,000. */
    count?: number;
  };
}

/** What `checkIndexes` needs to know about one resource. Built by the engine. */
export interface IndexCheckTarget {
  key: string;
  table: PgTable;
  schema: Record<string, unknown>;
  db: QueryEngineDb;
  /** Fields a client can reach. */
  fields: Map<string, FieldRegistryEntry>;
  /** Fields the engine itself can use, hidden ones included (scope filters on hidden fields). */
  trustedFields: Map<string, FieldRegistryEntry>;
  scope?: (filters: any, context: any) => QueryFilterInput;
  sortDefaults: readonly { key: string; dir: "asc" | "desc" }[];
  search: { explicit: boolean; allowed: readonly string[]; defaults: readonly string[] };
  facets: { explicit: boolean; allowed: readonly string[] };
  caseSensitive: ReadonlySet<string>;
  defaultPagination?: { mode?: "offset" | "cursor"; count?: "none" | "exact" };
  /** A custom `strategy.query` or `strategy.ids` replaces the sorts and scope this analyses. */
  customQuery: boolean;
  customFacets: boolean;
  /** Runs the engine's default page query on the given database. */
  queryPage?: (db: QueryEngineDb, context: unknown) => Promise<unknown>;
}

interface IndexKey {
  /** `col:<name>` for a column, `expr:<normalised sql>` for an expression. */
  id: string;
  dir: "asc" | "desc";
  nulls: "first" | "last";
}

interface IndexInfo {
  name: string;
  method: string;
  unique: boolean;
  partial: boolean;
  /** The `where` condition of a partial index, as text. */
  predicate?: string;
  valid: boolean;
  keys: IndexKey[];
}

interface Names {
  column(column: PgColumn): string;
  table(table: PgTable): { name: string; schema?: string };
}

interface IndexSource {
  names: Names;
  indexes(table: PgTable): IndexInfo[];
  rows(table: PgTable): number | undefined;
  trigram(table: PgTable): Set<string> | undefined;
}

const defaultDialect = new PgDialect();

// ---------------------------------------------------------------------------
// Names and normalised expressions
// ---------------------------------------------------------------------------

function createNames(db: QueryEngineDb): Names {
  const candidate = (db as { dialect?: { sqlToQuery?: unknown } }).dialect;
  const dialect = (
    typeof candidate?.sqlToQuery === "function" ? candidate : defaultDialect
  ) as PgDialect;
  return {
    column(column) {
      const rendered = dialect.sqlToQuery(sql`${column}`).sql;
      return /"([^"]+)"$/.exec(rendered)?.[1] ?? column.name;
    },
    table(table) {
      const { name, schema } = getTableConfig(table);
      return { name, schema };
    },
  };
}

/** Make `lower("t"."org")`, `lower((org)::text)` and `lower(org)` comparable. */
function normalizeExpression(text: string) {
  return text
    .toLowerCase()
    .replace(/"[^"]*"\./g, "")
    .replaceAll('"', "")
    .replace(/::[a-z_]+(?: [a-z_]+)?/g, "")
    .replace(/[\s()]/g, "");
}

const columnId = (name: string) => `col:${name}`;
const expressionId = (text: string) => `expr:${normalizeExpression(text)}`;

/** Words PostgreSQL does not accept as a bare table or column name. */
const reservedWords = new Set(
  `all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with`.split(
    " ",
  ),
);

function quoteIdentifier(name: string) {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !reservedWords.has(name)
    ? name
    : `"${name.replaceAll('"', '""')}"`;
}

/**
 * Split a partial index condition into its `and` parts, comparable with the scope's facts:
 * `deleted_at is null`, `status = 'open'`. String literals keep their case.
 */
function predicateParts(text: string): string[] {
  const parts = text
    .split(/('(?:[^']|'')*')/)
    .map((piece, position) =>
      position % 2 === 1
        ? piece
        : piece
            .toLowerCase()
            .replace(/"[^"]*"\./g, "")
            .replaceAll('"', "")
            .replace(/::[a-z_]+(?: [a-z_]+)?/g, "")
            .replace(/[()]/g, " "),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return parts.split(/ and /i).map((part) => part.trim());
}

function qualifiedTable(names: Names, table: PgTable) {
  const { name, schema } = names.table(table);
  return `${schema ? `${quoteIdentifier(schema)}.` : ""}${quoteIdentifier(name)}`;
}

// ---------------------------------------------------------------------------
// Where the indexes come from
// ---------------------------------------------------------------------------

function schemaIndexes(table: PgTable, names: Names): IndexInfo[] {
  const config = getTableConfig(table);
  const columns = Object.values(getColumns(table)) as PgColumn[];
  const plain = (name: string, method: string, unique: boolean, ids: string[]): IndexInfo => ({
    name,
    method,
    unique,
    partial: false,
    valid: true,
    keys: ids.map((id) => ({ id, dir: "asc", nulls: "last" })),
  });
  const idOf = (column: PgColumn) => columnId(names.column(column));
  const result: IndexInfo[] = [];
  for (const column of config.columns) {
    if (column.primary) result.push(plain(`${config.name}_pkey`, "btree", true, [idOf(column)]));
    else if (column.isUnique)
      result.push(plain(`${config.name}_${column.name}_key`, "btree", true, [idOf(column)]));
  }
  for (const key of config.primaryKeys) {
    result.push(plain(key.getName(), "btree", true, key.columns.map(idOf)));
  }
  for (const constraint of config.uniqueConstraints) {
    result.push(plain(constraint.name ?? "unique", "btree", true, constraint.columns.map(idOf)));
  }
  for (const { config: index } of config.indexes) {
    result.push({
      name: index.name ?? "index",
      method: index.method ?? "btree",
      unique: Boolean(index.unique),
      partial: Boolean(index.where),
      predicate: index.where ? defaultDialect.sqlToQuery(index.where).sql : undefined,
      valid: true,
      keys: index.columns.map((entry): IndexKey => {
        if (is(entry, IndexedColumn)) {
          const column = columns.find((candidate) => candidate.name === entry.name);
          return {
            id: column ? idOf(column) : columnId(entry.name),
            dir: entry.indexConfig.order === "desc" ? "desc" : "asc",
            nulls: entry.indexConfig.nulls === "first" ? "first" : "last",
          };
        }
        const rendered = defaultDialect.sqlToQuery(entry as never).sql;
        return { id: expressionId(rendered), dir: "asc", nulls: "last" };
      }),
    });
  }
  return result;
}

type LiveIndexRow = {
  name: string;
  method: string;
  unique: boolean;
  valid: boolean;
  partial: boolean;
  predicate: string | null;
  keys: Array<{
    column: string | null;
    expression: string | null;
    desc: boolean;
    nullsFirst: boolean;
  }>;
};

interface LiveTable {
  indexes: IndexInfo[];
  rows: number | undefined;
  trigram: Set<string>;
}

async function loadLiveTable(
  database: PgAsyncDatabase<any, any>,
  names: Names,
  table: PgTable,
): Promise<LiveTable> {
  const regclass = qualifiedTable(names, table);
  const [existing] = await database.execute<{ found: boolean }>(
    sql`select to_regclass(${regclass}) is not null as found`,
    "objects",
  );
  if (!existing?.found) {
    throw new Error(`Table ${regclass} was not found in the database: run your migrations first`);
  }
  const [indexRows, sizes, trigram] = await Promise.all([
    database.execute<LiveIndexRow>(
      sql`
        select
          relation.relname as name,
          method.amname as method,
          idx.indisunique as unique,
          (idx.indisvalid and idx.indisready) as valid,
          idx.indpred is not null as partial,
          pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) as predicate,
          (
            select json_agg(
              json_build_object(
                'column', case when idx.indkey[key.n - 1] = 0 then null else (
                  select attribute.attname from pg_catalog.pg_attribute as attribute
                  where attribute.attrelid = idx.indrelid and attribute.attnum = idx.indkey[key.n - 1]
                ) end,
                'expression', case when idx.indkey[key.n - 1] = 0
                  then pg_catalog.pg_get_indexdef(idx.indexrelid, key.n, true) end,
                'desc', (idx.indoption[key.n - 1] & 1) = 1,
                'nullsFirst', (idx.indoption[key.n - 1] & 2) = 2
              ) order by key.n
            )
            from generate_series(1, idx.indnkeyatts) as key(n)
          ) as keys
        from pg_catalog.pg_index as idx
        join pg_catalog.pg_class as relation on relation.oid = idx.indexrelid
        join pg_catalog.pg_am as method on method.oid = relation.relam
        where idx.indrelid = to_regclass(${regclass})
      `,
      "objects",
    ),
    database.execute<{ rows: number }>(
      sql`select reltuples::float8 as rows from pg_catalog.pg_class where oid = to_regclass(${regclass})`,
      "objects",
    ),
    listPostgresSearchColumns(database, table),
  ]);
  const reltuples = Number(sizes[0]?.rows ?? -1);
  return {
    indexes: indexRows.map((row) => ({
      name: row.name,
      method: row.method,
      unique: row.unique,
      partial: row.partial,
      predicate: row.predicate ?? undefined,
      valid: row.valid,
      keys: (row.keys ?? []).map((key): IndexKey => ({
        id: key.column === null ? expressionId(key.expression ?? "") : columnId(key.column),
        dir: key.desc ? "desc" : "asc",
        nulls: key.nullsFirst ? "first" : "last",
      })),
    })),
    // PostgreSQL reports -1 for a table that was never analysed: the size is unknown.
    rows: reltuples >= 0 ? reltuples : undefined,
    trigram,
  };
}

function schemaSource(db: QueryEngineDb): IndexSource {
  const names = createNames(db);
  const cache = new Map<PgTable, IndexInfo[]>();
  return {
    names,
    indexes(table) {
      let indexes = cache.get(table);
      if (!indexes) {
        indexes = schemaIndexes(table, names);
        cache.set(table, indexes);
      }
      return indexes;
    },
    rows: () => undefined,
    trigram: () => undefined,
  };
}

function liveSource(names: Names, tables: Map<PgTable, LiveTable>): IndexSource {
  return {
    names,
    indexes: (table) => tables.get(table)?.indexes ?? [],
    rows: (table) => tables.get(table)?.rows,
    trigram: (table) => tables.get(table)?.trigram,
  };
}

// ---------------------------------------------------------------------------
// What a request needs from an index
// ---------------------------------------------------------------------------

interface Step {
  id: string;
  /** The id of the plain column, used when the equality does not need `lower()`. */
  plainId: string;
  field: string;
  column: PgColumn;
  table: PgTable;
  /** The comparison is `lower(column)`, not the column itself. */
  lower: boolean;
  nullable: boolean;
  /** What the equality guarantees about every row, as a partial index condition would say it. */
  facts: string[];
}

interface SortStep extends Step {
  dir: "asc" | "desc";
  /** Appended by the engine so that cursors and pages are stable. */
  tieBreaker: boolean;
}

interface Need {
  table: PgTable;
  eq: Step[];
  sort: SortStep[];
  /** Every condition the scope guarantees, such as `deleted_at is null`. */
  facts: ReadonlySet<string>;
  /** Columns the scope requires to be null. PostgreSQL does not read `is null` as a constant when ordering. */
  nullIds: ReadonlySet<string>;
  /** Database names of the columns the scope has a condition on. */
  scopeColumns: ReadonlySet<string>;
}

type Verdict =
  | { kind: "served"; index: string }
  /** Serves the sort, but some scope equalities are not in the index and filter row by row. */
  | { kind: "filtered"; index: string; missing: string[] }
  /** A partial index that would serve it if the scope always included its condition. */
  | { kind: "partial"; index: string; condition: string }
  | { kind: "near"; index: string }
  | { kind: "none" };

interface MatchOptions {
  ignoreNulls?: boolean;
  plainEquality?: boolean;
  /** Count a partial index even if the scope does not imply its condition. */
  assumePartial?: boolean;
  /** Read `is null` columns as constants, to tell a near miss from a miss. */
  nullAsConstant?: boolean;
}

/** `deleted_at is null`, `deleted_at is not null` or `status = 'open'`: the column it is about. */
function predicateColumn(part: string) {
  return /^([a-z_][a-z0-9_]*) (?:is null|is not null|= .+)$/.exec(part)?.[1];
}

function contradicts(part: string, facts: ReadonlySet<string>) {
  const column = predicateColumn(part);
  if (!column || facts.has(part)) return false;
  const own = [...facts].filter((fact) => predicateColumn(fact) === column);
  if (part.endsWith(" is not null")) return own.some((fact) => fact.endsWith(" is null"));
  // `x is null` or `x = a` against a different fact about the same column
  return own.length > 0;
}

/**
 * A partial index can only be relied on for conditions the scope states. One about other
 * columns is for requests to satisfy, and one the scope contradicts can never be used.
 */
function classifyPartial(index: IndexInfo, need: Need) {
  const parts = index.predicate ? predicateParts(index.predicate) : undefined;
  if (!parts) return { kind: "ignore" as const, parts: [] };
  const columns = parts.map(predicateColumn);
  if (columns.some((column) => !column || !need.scopeColumns.has(column))) {
    return { kind: "ignore" as const, parts };
  }
  if (parts.every((part) => need.facts.has(part))) return { kind: "implied" as const, parts };
  if (parts.some((part) => contradicts(part, need.facts))) {
    return { kind: "ignore" as const, parts };
  }
  return { kind: "unverified" as const, parts };
}

const defaultNulls = (dir: "asc" | "desc") => (dir === "asc" ? "last" : "first");
const flip = <T extends string>(value: T, a: T, b: T) => (value === a ? b : a);

/**
 * How much of the need an index serves, reading it forward or backward: the sort steps in order,
 * and the scope equalities that are not among its leading columns.
 */
function servedSteps(need: Need, index: IndexInfo, options: MatchOptions) {
  if (index.method !== "btree" || !index.valid) return undefined;
  let covered = new Set<string>();
  let implied = !index.partial;
  if (index.partial) {
    const partial = classifyPartial(index, need);
    if (partial.kind === "ignore") return undefined;
    if (partial.kind === "unverified" && !options.assumePartial) return undefined;
    implied = partial.kind === "implied";
    covered = new Set(partial.parts);
  }
  const stepKey = (step: Step) => (options.plainEquality ? step.plainId : step.id);
  // The scope's equality columns are a set: the order the scope lists them in never matters.
  const wanted = new Map(
    need.eq
      .filter((step) => !need.nullIds.has(step.plainId))
      .filter((step) => !step.facts.some((fact) => implied && covered.has(fact)))
      .map((step) => [stepKey(step), step.field]),
  );
  // The index provides the order if a prefix of its columns is made of scope equalities
  // (any of them, in any order) and the sort columns follow it.
  let position = 0;
  while (position < index.keys.length) {
    const key = index.keys[position]!;
    if (wanted.has(key.id)) {
      wanted.delete(key.id);
    } else if (need.nullIds.has(key.id) && need.sort.length > 0) {
      // Ordering by what follows `is null` needs a sort: PostgreSQL does not see a constant.
      if (!options.nullAsConstant) return undefined;
    } else break;
    position += 1;
  }
  let forward = true;
  let backward = true;
  let served = 0;
  for (const step of need.sort) {
    const key = index.keys[position + served];
    if (!key || key.id !== step.id) break;
    const nulls = step.nullable && !options.ignoreNulls;
    const wantedNulls = defaultNulls(step.dir);
    forward &&= key.dir === step.dir && (!nulls || key.nulls === wantedNulls);
    backward &&=
      key.dir !== step.dir && (!nulls || flip(key.nulls, "first", "last") === wantedNulls);
    if (!forward && !backward) break;
    served += 1;
  }
  return {
    served,
    missing: [...wanted.values()],
    unverified: index.partial && !implied,
  };
}

function evaluate(need: Need, indexes: IndexInfo[], options: MatchOptions = {}): Verdict {
  let filtered: Verdict | undefined;
  let near: string | undefined;
  for (const index of indexes) {
    const match = servedSteps(need, index, options);
    if (!match) continue;
    if (match.served === need.sort.length) {
      if (match.missing.length === 0) return { kind: "served", index: index.name };
      filtered ??= { kind: "filtered", index: index.name, missing: match.missing };
    } else if (match.served === need.sort.length - 1 && need.sort.at(-1)?.tieBreaker) {
      near ??= index.name;
    }
  }
  if (filtered) return filtered;
  return near ? { kind: "near", index: near } : { kind: "none" };
}

/** `evaluate`, then, when nothing serves the need, the partial indexes that might. */
function assess(need: Need, indexes: IndexInfo[]): Verdict {
  const verdict = evaluate(need, indexes);
  if (verdict.kind !== "none") return verdict;
  for (const index of indexes) {
    if (!index.partial) continue;
    const match = servedSteps(need, index, { assumePartial: true });
    if (match && match.served === need.sort.length && match.unverified) {
      return { kind: "partial", index: index.name, condition: index.predicate ?? "a condition" };
    }
  }
  return verdict;
}

/** Unique keys whose columns cannot be null: a unique index lets rows with a null column tie. */
function uniqueKeys(indexes: IndexInfo[], notNull: ReadonlySet<string>) {
  return indexes
    .filter((index) => index.unique && !index.partial && index.valid)
    .map((index) => index.keys.map((key) => key.id))
    .filter((ids) => ids.length > 0 && ids.every((id) => notNull.has(id)));
}

/** Cut the sort where the columns so far are unique: nothing after that can tie. */
function reduceNeed(need: Need, indexes: IndexInfo[], notNull: ReadonlySet<string>): Need {
  const unique = uniqueKeys(indexes, notNull);
  const covered = new Set(need.eq.map((step) => step.id));
  const holds = () => unique.find((key) => key.every((id) => covered.has(id)));
  const single = holds();
  if (single) {
    return { ...need, eq: need.eq.filter((step) => single.includes(step.id)), sort: [] };
  }
  for (const [position, step] of need.sort.entries()) {
    covered.add(step.id);
    if (holds()) return { ...need, sort: need.sort.slice(0, position + 1) };
  }
  return need;
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

function columnKey(table: PgTable, column: PgColumn) {
  return Object.entries(getColumns(table)).find(([, candidate]) => candidate === column)?.[0];
}

function buildFix(source: IndexSource, need: Need): { drizzle: string; sql: string } {
  const { names } = source;
  const { name: tableName } = names.table(need.table);
  const labels: string[] = [];
  const drizzle: string[] = [];
  const statements: string[] = [];
  const conditions: Array<{ drizzle: string; sql: string }> = [];
  for (const step of [...need.eq, ...need.sort]) {
    const dbName = names.column(step.column);
    // `is null` cannot lead an index that orders: say it as a partial index condition instead.
    if (need.nullIds.has(step.plainId) && !("dir" in step)) {
      const key = columnKey(need.table, step.column) ?? step.column.name;
      conditions.push({
        drizzle: `\${t.${key}} is null`,
        sql: `${quoteIdentifier(dbName)} is null`,
      });
      continue;
    }
    const key = columnKey(need.table, step.column) ?? step.column.name;
    const dir = "dir" in step ? (step as SortStep).dir : "asc";
    labels.push(step.lower ? `lower_${dbName}` : dbName);
    const reference = `t.${key}`;
    if (step.lower) {
      drizzle.push(`sql\`lower(\${${reference}})\``);
      statements.push(`lower(${quoteIdentifier(dbName)})`);
      continue;
    }
    drizzle.push(
      dir === "desc" ? `${reference}.desc()${step.nullable ? ".nullsFirst()" : ""}` : reference,
    );
    statements.push(`${quoteIdentifier(dbName)}${dir === "desc" ? " desc" : ""}`);
  }
  const indexName = `${tableName}_${labels.join("_")}${conditions.length > 0 ? "_partial" : ""}_idx`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .slice(0, 63);
  return {
    drizzle: `index("${indexName}").on(${drizzle.join(", ")})${conditions.length > 0 ? `.where(sql\`${conditions.map((c) => c.drizzle).join(" and ")}\`)` : ""}`,
    sql: `create index ${quoteIdentifier(indexName)} on ${qualifiedTable(source.names, need.table)} (${statements.join(", ")})${conditions.length > 0 ? ` where ${conditions.map((c) => c.sql).join(" and ")}` : ""};`,
  };
}

function mergeFixes(all: Array<{ drizzle: string; sql: string }>) {
  // Two fields can ask for the same index: a second `create index` of it would fail.
  const fixes = [...new Map(all.map((fix) => [fix.sql, fix])).values()];
  if (fixes.length === 0) return undefined;
  return {
    drizzle: fixes.map((fix) => fix.drizzle).join("\n"),
    sql: fixes.map((fix) => fix.sql).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Reading the resource
// ---------------------------------------------------------------------------

function isTextEntry(entry: FieldRegistryEntry) {
  if (entry.virtual) return entry.virtual.kind === "text";
  const type = (entry.column as { columnType?: string } | undefined)?.columnType;
  return type === "PgVarchar" || type === "PgText" || type === "PgChar" || type === "PgCitext";
}

function placeholderContext(): any {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_, property) =>
      property === Symbol.toPrimitive
        ? () => "sample"
        : property === "then"
          ? undefined
          : placeholderContext(),
    apply: () => placeholderContext(),
  });
}

interface ScopeRead {
  /** Equality filters on the resource's own columns, in the order the scope lists them. */
  equalities: string[];
  /** Every field the scope reads. */
  fields: string[];
  /** Every condition, and whether the scope needs all of them at once (no `or` above it). */
  conditions: Array<{ field: string; operator: string; value: unknown; conjunctive: boolean }>;
}

function readScope(target: IndexCheckTarget, options: CheckIndexesOptions): ScopeRead {
  if (!target.scope) return { equalities: [], fields: [], conditions: [] };
  let input: QueryFilterInput;
  try {
    input = target.scope(
      createQueryFilterBuilder<string>(),
      options.context ?? placeholderContext(),
    );
  } catch (error) {
    throw new Error(
      `checkIndexes could not read the scope of resource "${target.key}": ${
        error instanceof Error ? error.message : String(error)
      }. Pass { context } with sample values.`,
      { cause: error },
    );
  }
  const equalities: string[] = [];
  const fields: string[] = [];
  const conditions: ScopeRead["conditions"] = [];
  function walk(node: QueryFilterNode, conjunctive: boolean) {
    if (node.type === "group") {
      for (const child of node.children) walk(child, conjunctive && node.combinator === "and");
      return;
    }
    if (!fields.includes(node.key)) fields.push(node.key);
    conditions.push({ field: node.key, operator: node.operator, value: node.value, conjunctive });
    if (
      conjunctive &&
      node.operator === "is" &&
      !Array.isArray(node.value) &&
      !equalities.includes(node.key)
    ) {
      equalities.push(node.key);
    }
  }
  const roots = Array.isArray(input) ? input : input ? [input] : [];
  for (const node of roots) walk(node, true);
  return { equalities, fields, conditions };
}

/** The outcome of the default sort check. */
interface DefaultSortInfo {
  label: string;
  scope: string;
  fields: string[];
  /** The index that serves it on paper, when it is served. */
  servedBy?: string;
  /** The finding raised, when it is not served. */
  finding?: IndexFinding;
  fix?: { drizzle: string; sql: string };
}

interface Analysis {
  target: IndexCheckTarget;
  source: IndexSource;
  options: CheckIndexesOptions;
  indexes: IndexInfo[];
  eq: Step[];
  scope: ScopeRead;
  /** What the default sort check concluded, for EXPLAIN to confirm. */
  defaultSort?: DefaultSortInfo;
  /** Conditions the scope guarantees on every row, as a partial index would state them. */
  facts: Set<string>;
  /** Columns that can never be null, as index key ids. */
  notNull: Set<string>;
  /** Columns the scope requires to be null, as index key ids. */
  nullIds: Set<string>;
  /** Database names of the columns the scope has a condition on. */
  scopeColumns: Set<string>;
  findings: IndexFinding[];
}

function makeStep(
  analysis: Pick<Analysis, "target" | "source">,
  field: string,
  entry: FieldRegistryEntry,
  lowerWhenText: boolean,
  facts: string[] = [],
): Step | undefined {
  if (entry.source !== "root" || entry.virtual || !is(entry.column, PgColumn)) return undefined;
  const column = entry.column as PgColumn;
  const name = analysis.source.names.column(column);
  const lower = lowerWhenText && isTextEntry(entry) && !analysis.target.caseSensitive.has(field);
  return {
    id: lower ? expressionId(`lower(${name})`) : columnId(name),
    plainId: columnId(name),
    field,
    column,
    table: analysis.target.table,
    lower,
    nullable: !column.notNull,
    facts,
  };
}

function sqlLiteral(value: unknown) {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** What each scope condition says about every row, in the words of a partial index condition. */
function scopeFacts(analysis: Pick<Analysis, "target" | "source" | "scope">) {
  const byField = new Map<string, string[]>();
  const columns = new Set<string>();
  for (const condition of analysis.scope.conditions) {
    const entry = analysis.target.trustedFields.get(condition.field);
    if (!entry || entry.source !== "root" || entry.virtual || !is(entry.column, PgColumn)) continue;
    const column = entry.column as PgColumn;
    const name = analysis.source.names.column(column);
    columns.add(name);
    if (!condition.conjunctive) continue;
    const text = isTextEntry(entry);
    const exact = !text || analysis.target.caseSensitive.has(condition.field);
    let fact: string | undefined;
    if (condition.operator === "is" && !Array.isArray(condition.value)) {
      if (condition.value === null) fact = `${name} is null`;
      else if (exact && sqlLiteral(condition.value) !== undefined)
        fact = `${name} = ${sqlLiteral(condition.value)}`;
    } else if (condition.operator === "isEmpty" && !text && !(column as any).dimensions) {
      fact = `${name} is null`;
    }
    if (fact) byField.set(condition.field, [...(byField.get(condition.field) ?? []), fact]);
  }
  return { byField, columns };
}

function describeSort(sort: readonly { field: string; dir: "asc" | "desc" }[]) {
  return sort.map((step) => `${step.field} ${step.dir}`).join(", ");
}

function listFields(fields: readonly string[], limit = 6) {
  return fields.length <= limit
    ? fields.join(", ")
    : `${fields.slice(0, limit).join(", ")} and ${fields.length - limit} more`;
}

function scopeSuffix(analysis: Analysis) {
  return analysis.eq.length > 0
    ? ` under scope ${analysis.eq.map((step) => step.field).join(", ")}`
    : "";
}

function add(
  analysis: Analysis,
  level: IndexFindingLevel,
  rule: IndexFindingRule,
  message: string,
  fields: string[],
  fix?: { drizzle: string; sql: string },
): IndexFinding {
  const finding: IndexFinding = {
    resource: analysis.target.key,
    level,
    rule,
    message,
    fields,
    ...(fix ? { fix } : {}),
  };
  analysis.findings.push(finding);
  return finding;
}

function sortSteps(
  analysis: Analysis,
  rules: readonly { key: string; dir: "asc" | "desc" }[],
): { steps: SortStep[]; through: string[]; unknown: boolean } {
  const steps: SortStep[] = [];
  const through: string[] = [];
  let unknown = false;
  const requested = rules.length > 0 ? [...rules] : [];
  const withTieBreaker =
    requested.some((rule) => rule.key === "id") || !analysis.target.trustedFields.has("id")
      ? requested.map((rule) => ({ ...rule, tieBreaker: false }))
      : [
          ...requested.map((rule) => ({ ...rule, tieBreaker: false })),
          { key: "id", dir: requested.at(-1)?.dir ?? ("asc" as const), tieBreaker: true },
        ];
  for (const rule of withTieBreaker) {
    const entry = analysis.target.trustedFields.get(rule.key);
    if (!entry) {
      unknown = true;
      continue;
    }
    if (entry.source === "relation") {
      through.push(rule.key);
      continue;
    }
    const step = makeStep(analysis, rule.key, entry, false);
    if (!step) {
      unknown = true;
      continue;
    }
    steps.push({ ...step, dir: rule.dir, tieBreaker: rule.tieBreaker });
  }
  return { steps, through, unknown };
}

function needFor(analysis: Analysis, sort: SortStep[]): Need {
  const equalityIds = new Set<string>();
  const eq = analysis.eq.filter((step) => !equalityIds.has(step.id) && equalityIds.add(step.id));
  const covered = new Set(eq.map((step) => step.column));
  // A scope equality on a value, not on null, makes the column non-null for every row it matches.
  const notNull = new Set([
    ...analysis.notNull,
    ...eq.filter((step) => !analysis.nullIds.has(step.plainId)).map((step) => step.plainId),
  ]);
  return reduceNeed(
    {
      table: analysis.target.table,
      eq,
      sort: sort.filter((step) => !covered.has(step.column)),
      facts: analysis.facts,
      nullIds: analysis.nullIds,
      scopeColumns: analysis.scopeColumns,
    },
    analysis.indexes,
    notNull,
  );
}

/** A sort and its reverse read the same index: compare them as one. */
function signature(need: Need) {
  const first = need.sort[0]?.dir;
  return [
    ...need.eq.map((step) => step.id).sort(),
    ...need.sort.map((step) => `${step.id}:${step.dir === first ? "a" : "b"}`),
  ].join("|");
}

function mixes(need: Need) {
  return new Set(need.sort.map((step) => step.dir)).size > 1;
}

function hintsFor(need: Need, indexes: IndexInfo[]) {
  const hints: string[] = [];
  if (need.eq.some((step) => step.lower)) {
    const plain = evaluate(need, indexes, { plainEquality: true });
    if (plain.kind !== "none") {
      const fields = need.eq.filter((step) => step.lower).map((step) => step.field);
      hints.push(
        `index ${plain.index} has the columns but the scope compares lower(${fields.join(", ")}) because text filters ignore case: add ${fields.map((field) => `"${field}"`).join(", ")} to filters.caseSensitive`,
      );
    }
  }
  if (need.nullIds.size > 0) {
    const constant = evaluate(need, indexes, { nullAsConstant: true });
    if (constant.kind === "served" || constant.kind === "filtered") {
      hints.push(
        `index ${constant.index} has the columns, but PostgreSQL does not read "is null" as a constant when ordering, so a null column before the sort columns forces a sort: use a partial index with the null condition as its where`,
      );
    }
  }
  if (need.sort.some((step) => step.nullable)) {
    const loose = evaluate(need, indexes, { ignoreNulls: true });
    if (loose.kind === "served") {
      hints.push(
        `index ${loose.index} has the columns but puts nulls last on a descending column: PostgreSQL sorts nulls first, so use .desc().nullsFirst()`,
      );
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkDefaultSort(analysis: Analysis): Need | undefined {
  const { target } = analysis;
  const { steps, through, unknown } = sortSteps(analysis, target.sortDefaults);
  if (through.length > 0) {
    add(
      analysis,
      "error",
      "relation-sort",
      `default sort ${through.join(", ")} joins every row of ${target.key} first: sort on a column of ${target.key} instead, or copy ${listFields(through.map((field) => field.split(".").at(-1)!))} onto ${target.key}`,
      through,
    );
    return undefined;
  }
  if (unknown) return undefined;
  const need = needFor(analysis, steps);
  const verdict = assess(need, analysis.indexes);
  const label = describeSort(steps);
  const fields = steps.map((step) => step.field);
  if (verdict.kind === "served") {
    analysis.defaultSort = {
      label,
      scope: scopeSuffix(analysis),
      fields,
      servedBy: verdict.index,
      fix: buildFix(analysis.source, need),
    };
    return need;
  }
  const fix = buildFix(analysis.source, need);
  let finding: IndexFinding;
  const hints = hintsFor(need, analysis.indexes);
  const hint = hints.length > 0 ? ` (${hints.join("; ")})` : "";
  if (verdict.kind === "filtered") {
    finding = add(
      analysis,
      "warn",
      "default-sort-unindexed",
      `default sort ${label}${scopeSuffix(analysis)} is served by index ${verdict.index}, but ${verdict.missing.join(", ")} ${verdict.missing.length === 1 ? "is" : "are"} not in it: ${verdict.missing.join(", ")} filters row by row, and PostgreSQL may still prefer a full scan when the leading column matches most rows. Add ${verdict.missing.length === 1 ? "it" : "them"} to the index only if that filter is selective`,
      fields,
    );
  } else if (verdict.kind === "partial") {
    finding = add(
      analysis,
      "warn",
      "default-sort-unindexed",
      `default sort ${label}${scopeSuffix(analysis)} is served by index ${verdict.index} only when every query meets its condition (${verdict.condition}), and the scope does not always say so: checkIndexes cannot confirm the index is used`,
      fields,
      fix,
    );
  } else if (mixes(need)) {
    finding = add(
      analysis,
      "warn",
      "mixed-direction-sort",
      `default sort ${label}${scopeSuffix(analysis)} mixes directions: no index serves it${hint}`,
      fields,
      fix,
    );
  } else if (verdict.kind === "near") {
    finding = add(
      analysis,
      "warn",
      "default-sort-unindexed",
      `default sort ${label}${scopeSuffix(analysis)} is almost served by index ${verdict.index}, which lacks the id tie-breaker that pages and cursors add: append id to it${hint}`,
      fields,
      fix,
    );
  } else {
    finding = add(
      analysis,
      "error",
      "default-sort-unindexed",
      `default sort ${label}${scopeSuffix(analysis)} has no index${hint}`,
      fields,
      fix,
    );
  }
  analysis.defaultSort = { label, scope: scopeSuffix(analysis), fields, finding, fix };
  return need;
}

function checkSorts(analysis: Analysis, defaultNeed: Need | undefined) {
  const { target } = analysis;
  const skip = defaultNeed ? signature(defaultNeed) : undefined;
  const missing: string[] = [];
  const fixes: Array<{ drizzle: string; sql: string }> = [];
  const relations = new Map<string, string[]>();
  for (const [field, entry] of target.fields) {
    if (!entry.sortable || entry.virtual) continue;
    if (entry.source === "relation") {
      const path = entry.relationPath.at(-1)?.path ?? field;
      relations.set(path, [...(relations.get(path) ?? []), field]);
      continue;
    }
    // A column the scope fixes by equality has one value: nothing to sort.
    if (analysis.eq.some((step) => step.column === entry.column)) continue;
    const { steps } = sortSteps(analysis, [{ key: field, dir: "asc" }]);
    if (steps.length === 0 || steps[0]!.field !== field) continue;
    const need = needFor(analysis, steps);
    if (skip !== undefined && signature(need) === skip) continue;
    // Filtering a little row by row, or an index only the scope can confirm, is not "no index".
    if (["served", "filtered", "partial"].includes(assess(need, analysis.indexes).kind)) continue;
    missing.push(field);
    fixes.push(buildFix(analysis.source, need));
  }
  if (missing.length > 0) {
    add(
      analysis,
      "warn",
      "sort-unindexed",
      `sorting by ${listFields(missing)} has no index${scopeSuffix(analysis)}: each page reads and sorts every matching row. Index it, or add it to sort.disabled`,
      missing,
      mergeFixes(fixes),
    );
  }
  for (const [path, fields] of relations) {
    const columns = fields.map((field) => field.slice(path.length + 1));
    add(
      analysis,
      "warn",
      "relation-sort",
      `sort ${listFields(fields)} joins every row of ${target.key} first: disable it or copy ${listFields(columns)} onto ${target.key}`,
      fields,
    );
  }
}

function checkScope(analysis: Analysis) {
  const through = analysis.scope.fields.filter(
    (field) => analysis.target.trustedFields.get(field)?.source === "relation",
  );
  if (through.length === 0) return;
  const columns = through.map((field) => field.split(".").at(-1)!);
  add(
    analysis,
    "warn",
    "scope-through-relation",
    `scope ${listFields(through)} goes through a join: put ${listFields(columns)} on ${analysis.target.key}`,
    through,
  );
}

function leadingColumns(index: IndexInfo, ids: ReadonlySet<string>) {
  if (index.method !== "btree" || index.partial || !index.valid) return false;
  return (
    index.keys.slice(0, ids.size).every((key) => ids.has(key.id)) && index.keys.length >= ids.size
  );
}

function manyFixes(analysis: Analysis, steps: readonly FieldRegistryRelationStep[]) {
  const fixes: Array<{ drizzle: string; sql: string }> = [];
  for (const step of steps) {
    if (step.relationType !== "many") continue;
    const table = analysis.target.schema[step.targetTableName];
    if (!is(table, PgTable)) continue;
    const columns = step.targetColumns.filter((column): column is PgColumn => is(column, PgColumn));
    if (columns.length === 0) continue;
    const ids = new Set(columns.map((column) => columnId(analysis.source.names.column(column))));
    if (analysis.source.indexes(table).some((index) => leadingColumns(index, ids))) continue;
    fixes.push(
      buildFix(analysis.source, {
        table,
        eq: [],
        facts: new Set<string>(),
        nullIds: new Set<string>(),
        scopeColumns: new Set<string>(),
        sort: columns.map((column) => ({
          id: columnId(analysis.source.names.column(column)),
          plainId: columnId(analysis.source.names.column(column)),
          field: column.name,
          column,
          table,
          lower: false,
          nullable: !column.notNull,
          facts: [],
          dir: "asc",
          tieBreaker: false,
        })),
      }),
    );
  }
  return fixes;
}

function checkFacets(analysis: Analysis) {
  const { target } = analysis;
  if (target.customFacets) return;
  if (!target.facets.explicit) {
    const total = target.fields.size;
    const many = [...target.fields.values()].filter((entry) => entry.isManyPath).length;
    add(
      analysis,
      "info",
      "open-surface",
      `facets.allowed not set: all ${total} fields can be requested as facets${many > 0 ? `, ${many} of them through to-many relations` : ""}`,
      [],
    );
    return;
  }
  for (const field of target.facets.allowed) {
    const entry = target.fields.get(field);
    if (!entry?.isManyPath) continue;
    const many = entry.relationPath.find((step) => step.relationType === "many")!;
    const fixes = manyFixes(analysis, entry.relationPath);
    add(
      analysis,
      "warn",
      "many-to-many-facet",
      `facet ${field} counts through the to-many relation ${many.path}: every facet request joins all its rows${fixes.length > 0 ? ", and the join column has no index" : ""}`,
      [field],
      mergeFixes(fixes),
    );
  }
}

function checkSearch(analysis: Analysis) {
  const { target } = analysis;
  if (!target.search.explicit) {
    const total = target.fields.size;
    const notText = [...target.fields.values()].filter((entry) => !isTextEntry(entry)).length;
    add(
      analysis,
      "info",
      "open-surface",
      `search.allowed not set: all ${total} fields are searchable${notText > 0 ? `, including ${notText} that are not text` : ""}`,
      [],
    );
    return;
  }
  const numbers = target.search.allowed.filter((field) => {
    const entry = target.fields.get(field);
    return entry !== undefined && !isTextEntry(entry);
  });
  if (numbers.length > 0) {
    add(
      analysis,
      "info",
      "search-numbers",
      `search field ${listFields(numbers)} ${numbers.length === 1 ? "is" : "are"} not text: ${numbers.length === 1 ? "it is" : "they are"} cast to text and compared row by row, and no index can help`,
      numbers,
    );
  }
}

function checkLiveSearch(analysis: Analysis) {
  const { target, source } = analysis;
  const threshold = analysis.options.largeTable?.search ?? 100_000;
  const byTable = new Map<PgTable, { fields: string[]; names: string[]; table: string }>();
  for (const field of target.search.defaults) {
    const entry = target.fields.get(field);
    if (!entry || entry.virtual || entry.isManyPath || !isTextEntry(entry)) continue;
    const column = entry.column;
    const table = target.schema[entry.tableName];
    if (!is(column, PgColumn) || !is(table, PgTable)) continue;
    const trigram = source.trigram(table);
    const rows = source.rows(table);
    if (!trigram || rows === undefined || rows < threshold) continue;
    const name = source.names.column(column);
    if (trigram.has(name)) continue;
    const group = byTable.get(table) ?? { fields: [], names: [], table: entry.tableName };
    group.fields.push(field);
    group.names.push(name);
    byTable.set(table, group);
  }
  for (const [table, group] of byTable) {
    const qualified = qualifiedTable(source.names, table);
    const { name } = source.names.table(table);
    const keys = new Map(
      Object.entries(getColumns(table)).map(([key, column]) => [
        source.names.column(column as PgColumn),
        key,
      ]),
    );
    const drizzle = group.names.map(
      (column) =>
        `index("${`${name}_${column}_trgm_idx`.slice(0, 63)}").using("gin", sql\`lower(\${t.${keys.get(column) ?? column}}) gin_trgm_ops\`)`,
    );
    const statements = group.names.map(
      (column) =>
        `create index ${quoteIdentifier(`${name}_${column}_trgm_idx`.slice(0, 63))} on ${qualified} using gin (lower(${quoteIdentifier(column)}) gin_trgm_ops);`,
    );
    const rows = Math.round(source.rows(table) ?? 0);
    add(
      analysis,
      "warn",
      "search-unindexed",
      `searching ${listFields(group.fields)} has no trigram index and ${group.table} has about ${formatCount(rows)} rows: each search reads all of them`,
      group.fields,
      {
        drizzle: drizzle.join("\n"),
        sql: ["create extension if not exists pg_trgm;", ...statements].join("\n"),
      },
    );
  }
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function checkLiveCount(analysis: Analysis) {
  const { target, source } = analysis;
  const mode = target.defaultPagination?.mode ?? "offset";
  const count = target.defaultPagination?.count ?? (mode === "offset" ? "exact" : "none");
  if (count !== "exact") return;
  const rows = source.rows(target.table);
  if (rows === undefined || rows < (analysis.options.largeTable?.count ?? 1_000_000)) return;
  add(
    analysis,
    "info",
    "exact-count-large-table",
    `the default count is exact and ${target.key} has about ${formatCount(Math.round(rows))} rows: every page request counts every matching row. Set defaults.pagination.count to "none" if the total is not needed`,
    [],
  );
}

/** The nodes of the plan PostgreSQL gives the engine's page query. */
export interface PagePlan {
  nodes: Array<{ type: string; rows: number; index?: string }>;
}

function flattenPlan(node: any): PagePlan["nodes"] {
  return [
    { type: String(node["Node Type"]), rows: Number(node["Plan Rows"]), index: node["Index Name"] },
    ...((node.Plans ?? []) as any[]).flatMap((child) => flattenPlan(child)),
  ];
}

/**
 * Settle the default sort verdict with what PostgreSQL does. A sort over more than one row
 * means the order is not provided by an index, whatever the matcher believes, and no sort at
 * all means it is. An incremental sort (the index gives the leading columns) leaves a
 * near-miss verdict as it is.
 */
export function confirmDefaultSort(
  resource: string,
  info: DefaultSortInfo,
  findings: IndexFinding[],
  plan: PagePlan,
) {
  const sorts = plan.nodes.some((node) => node.type === "Sort" && node.rows > 1);
  const incremental = plan.nodes.some((node) => node.type === "Incremental Sort" && node.rows > 1);
  const scanned = plan.nodes.find((node) => node.index)?.index;
  const { finding } = info;
  if (!finding) {
    if (!sorts) return;
    findings.push({
      resource,
      level: "error",
      rule: "default-sort-unindexed",
      message: `default sort ${info.label}${info.scope} looks served by index ${info.servedBy}, but PostgreSQL sorts every matching row instead of using it. Confirmed by EXPLAIN`,
      fields: info.fields,
      ...(info.fix ? { fix: info.fix } : {}),
    });
    return;
  }
  if (finding.rule !== "default-sort-unindexed" && finding.rule !== "mixed-direction-sort") return;
  if (sorts) {
    if (finding.rule === "default-sort-unindexed") finding.level = "error";
    finding.message += ". Confirmed by EXPLAIN: PostgreSQL sorts every matching row";
  } else if (incremental) {
    finding.message += ". Confirmed by EXPLAIN: PostgreSQL uses an incremental sort";
  } else if (finding.level === "error") {
    finding.level = "warn";
    finding.message = `default sort ${info.label}${info.scope} has no index with its columns, but PostgreSQL reads ${scanned ? `index ${scanned}` : "a scan"} in order and filters row by row, which is fine while the scope matches a good share of the table. Confirmed by EXPLAIN`;
  } else {
    finding.message += ". Confirmed by EXPLAIN: PostgreSQL reads an index in order, with no sort";
  }
}

async function readPagePlan(
  target: IndexCheckTarget,
  database: PgAsyncDatabase<any, any>,
  options: CheckIndexesOptions,
): Promise<PagePlan | undefined> {
  if (target.customQuery || !target.queryPage) return undefined;
  // A stand-in for the database: the page query goes to the hook, which explains it.
  const probe = Object.create(database) as QueryEngineDb;
  let plan: PagePlan | undefined;
  pageQueryHooks.set(probe, async (query) => {
    const rows = await database.execute<{ "QUERY PLAN": unknown }>(
      sql`explain (format json) ${query as SQL}`,
      "objects",
    );
    const raw = rows[0]?.["QUERY PLAN"];
    const plans = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: unknown }>;
    plan = { nodes: flattenPlan(plans[0]!.Plan) };
    return [];
  });
  try {
    await target.queryPage(probe, options.context ?? placeholderContext());
  } catch {
    // A placeholder context cannot always be sent to PostgreSQL: the matcher's verdict stands.
    return undefined;
  } finally {
    pageQueryHooks.delete(probe);
  }
  return plan;
}

const levelOrder: Record<IndexFindingLevel, number> = { error: 0, warn: 1, info: 2 };

function analyze(
  target: IndexCheckTarget,
  source: IndexSource,
  options: CheckIndexesOptions,
  live: boolean,
  plan?: PagePlan,
): IndexFinding[] {
  const indexes = source.indexes(target.table);
  const analysis: Analysis = {
    target,
    source,
    options,
    indexes,
    eq: [],
    scope: { equalities: [], fields: [], conditions: [] },
    facts: new Set<string>(),
    notNull: new Set(
      Object.values(getColumns(target.table) as Record<string, PgColumn>)
        .filter((column) => column.notNull || column.primary)
        .map((column) => columnId(source.names.column(column))),
    ),
    nullIds: new Set<string>(),
    scopeColumns: new Set<string>(),
    findings: [],
  };
  if (!target.customQuery) {
    analysis.scope = readScope(target, options);
    const { byField, columns } = scopeFacts(analysis);
    analysis.facts = new Set([...byField.values()].flat());
    analysis.scopeColumns = columns;
    analysis.nullIds = new Set(
      [...analysis.facts]
        .filter((fact) => fact.endsWith(" is null"))
        .map((fact) => columnId(fact.slice(0, -" is null".length))),
    );
    analysis.eq = analysis.scope.equalities.flatMap((field) => {
      const entry = target.trustedFields.get(field);
      const step = entry ? makeStep(analysis, field, entry, true, byField.get(field)) : undefined;
      return step ? [step] : [];
    });
    const defaultNeed = checkDefaultSort(analysis);
    if (plan && analysis.defaultSort) {
      confirmDefaultSort(target.key, analysis.defaultSort, analysis.findings, plan);
    }
    checkSorts(analysis, defaultNeed);
    checkScope(analysis);
  }
  checkFacets(analysis);
  checkSearch(analysis);
  if (live) {
    checkLiveSearch(analysis);
    checkLiveCount(analysis);
  }
  return analysis.findings
    .map((finding, position) => ({ finding, position }))
    .sort(
      (a, b) =>
        levelOrder[a.finding.level] - levelOrder[b.finding.level] || a.position - b.position,
    )
    .map(({ finding }) => finding);
}

function tablesOf(target: IndexCheckTarget) {
  const tables = new Set<PgTable>([target.table]);
  for (const entry of target.trustedFields.values()) {
    for (const step of entry.relationPath) {
      for (const name of [step.sourceTableName, step.targetTableName]) {
        const table = target.schema[name];
        if (is(table, PgTable)) tables.add(table);
      }
    }
  }
  return tables;
}

/**
 * The resources of an engine, held weakly: a resource defined per request or per tenant and then
 * dropped is collected, and no longer appears in `engine.checkIndexes()`. The dead references
 * themselves are only removed when `targets()` runs, that is on the next `checkIndexes()` call.
 */
export function createIndexCheckRegistry() {
  const refs = new Set<WeakRef<object>>();
  const targets = new WeakMap<object, IndexCheckTarget>();
  return {
    add(owner: object, target: IndexCheckTarget) {
      targets.set(owner, target);
      refs.add(new WeakRef(owner));
    },
    targets(): IndexCheckTarget[] {
      const alive: IndexCheckTarget[] = [];
      for (const ref of refs) {
        const owner = ref.deref();
        const target = owner ? targets.get(owner) : undefined;
        if (target) alive.push(target);
        else refs.delete(ref);
      }
      return alive;
    },
  };
}

/** Resources defined twice with the same definition would report every finding twice. */
function withoutRepeats(findings: IndexFinding[]) {
  return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
}

export function runIndexChecks(
  targets: readonly IndexCheckTarget[],
  options: CheckIndexesOptions & { live: true },
): Promise<IndexFinding[]>;
export function runIndexChecks(
  targets: readonly IndexCheckTarget[],
  options?: CheckIndexesOptions & { live?: false },
): IndexFinding[];
export function runIndexChecks(
  targets: readonly IndexCheckTarget[],
  options?: CheckIndexesOptions,
): IndexFinding[] | Promise<IndexFinding[]>;
export function runIndexChecks(
  targets: readonly IndexCheckTarget[],
  options: CheckIndexesOptions = {},
): IndexFinding[] | Promise<IndexFinding[]> {
  if (!options.live) {
    return withoutRepeats(
      targets.flatMap((target) => analyze(target, schemaSource(target.db), options, false)),
    );
  }
  return (async () => {
    const results: IndexFinding[] = [];
    // Resources often share tables: read each table once per call.
    const loading = new Map<object, Map<PgTable, Promise<LiveTable>>>();
    for (const target of targets) {
      const database = options.db ?? target.db;
      if (!isPostgresDatabase(database)) {
        throw new Error("checkIndexes({ live: true }) needs a PostgreSQL database");
      }
      const names = createNames(database);
      const cache = loading.get(database) ?? new Map<PgTable, Promise<LiveTable>>();
      loading.set(database, cache);
      const loaded = await Promise.all(
        [...tablesOf(target)].map(async (table) => {
          let pending = cache.get(table);
          if (!pending) {
            pending = loadLiveTable(database, names, table);
            cache.set(table, pending);
          }
          return [table, await pending] as const;
        }),
      );
      const plan = await readPagePlan(target, database, options);
      results.push(...analyze(target, liveSource(names, new Map(loaded)), options, true, plan));
    }
    return withoutRepeats(results);
  })();
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

/**
 * Format findings for a terminal: one block per finding, with the Drizzle index that fixes it
 * under the message.
 */
export function formatIndexFindings(findings: readonly IndexFinding[]): string {
  if (findings.length === 0) return "No index findings.";
  const width = Math.max(...findings.map((finding) => finding.resource.length));
  return findings
    .map((finding) => {
      const head = `${finding.level.padEnd(5)}  ${finding.resource.padEnd(width)}  `;
      const lines = [`${head}${finding.message}`];
      for (const line of finding.fix?.drizzle.split("\n") ?? []) {
        lines.push(`${" ".repeat(head.length)}${line}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
