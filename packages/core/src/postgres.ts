import { is, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgAsyncDatabase, PgAsyncTransaction } from "drizzle-orm/pg-core/async";
import { PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { StatementObserver } from "./observe.js";
import type { QueryEngineDb, QueryRequest } from "./types.js";

const searchIndexes = new WeakMap<object, WeakMap<PgTable, Promise<Set<string>>>>();
const tableRows = new WeakMap<
  object,
  WeakMap<PgTable, { at: number; rows: Promise<number | undefined> }>
>();
/** How long a table's row estimate is reused before the catalog is read again. */
const tableRowsTtl = 5 * 60_000;
const dialect = new PgDialect();

/** What a planning statement reports to `onQuery`. */
export interface PlanningObserver {
  observer: StatementObserver;
  request?: QueryRequest;
}

export async function estimatePostgresQuery(
  database: QueryEngineDb,
  query: SQL,
  metric: "Total Cost" | "Plan Rows" = "Total Cost",
  observing?: PlanningObserver,
) {
  if (!isPostgresDatabase(database)) return undefined;
  /* an estimate only picks between equivalent plans, so any failure keeps the ordinary one */
  try {
    const explained = sql`explain (format json) ${query}`;
    const execution = database.execute<{ "QUERY PLAN": unknown }>(explained, "objects");
    const rows = await (observing
      ? observing.observer.raw("plan", observing.request, explained, execution)
      : execution);
    const raw = rows[0]?.["QUERY PLAN"];
    const plans = (typeof raw === "string" ? JSON.parse(raw) : raw) as
      | Array<{ Plan?: Record<string, unknown> }>
      | undefined;
    const value = Array.isArray(plans) ? plans[0]?.Plan?.[metric] : undefined;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function searchCatalog(table: PgTable) {
  const name = dialect.sqlToQuery(sql`${table}`).sql;
  return sql`
    select distinct attribute.attname as column
    from pg_catalog.pg_index as index
    join pg_catalog.pg_class as relation on relation.oid = index.indrelid
    join pg_catalog.pg_attribute as attribute on attribute.attrelid = relation.oid
    join pg_catalog.pg_opclass as operator on operator.oid = index.indclass[0]
    join pg_catalog.pg_depend as dependency
      on dependency.classid = 'pg_catalog.pg_opclass'::regclass
      and dependency.objid = operator.oid and dependency.deptype = 'e'
    join pg_catalog.pg_extension as extension on extension.oid = dependency.refobjid
    where relation.oid = to_regclass(${name})
      and not relation.relrowsecurity
      and extension.extname = 'pg_trgm'
      and operator.opcname in ('gin_trgm_ops', 'gist_trgm_ops')
      and index.indisvalid and index.indisready and index.indpred is null
      and index.indnkeyatts = 1 and attribute.attnum > 0 and not attribute.attisdropped
      and pg_get_expr(index.indexprs, index.indrelid) in (
        format('lower(%I)', attribute.attname),
        format('lower((%I)::text)', attribute.attname)
      )
  `;
}

/** Read the columns of a table that have a `lower(column)` trigram index, bypassing the cache. */
export async function listPostgresSearchColumns(database: QueryEngineDb, table: PgTable) {
  if (!isPostgresDatabase(database)) return new Set<string>();
  const rows = await database.execute<{ column: string }>(searchCatalog(table), "objects");
  return new Set(rows.map((row) => row.column));
}

export async function probePostgresSearch(
  database: QueryEngineDb,
  table: PgTable,
  observing?: PlanningObserver,
) {
  if (!isPostgresDatabase(database)) return new Set<string>();
  let tables = searchIndexes.get(database);
  if (!tables) {
    tables = new WeakMap();
    searchIndexes.set(database, tables);
  }
  const cached = tables.get(table);
  if (cached) return cached;
  const catalog = searchCatalog(table);
  const execution = database.execute<{ column: string }>(catalog, "objects");
  const pending = Promise.resolve(
    observing ? observing.observer.raw("plan", observing.request, catalog, execution) : execution,
  )
    .then((rows) => new Set(rows.map((row) => row.column)))
    .catch((error: unknown) => {
      tables.delete(table);
      throw error;
    });
  tables.set(table, pending);
  return pending;
}

/**
 * `pg_class.reltuples` of a table: the row count PostgreSQL last recorded with `ANALYZE` or
 * `VACUUM`. It reads one catalog row and never the table. Cached per database and table for a few
 * minutes, so a table that grows is noticed. `undefined` when PostgreSQL has no estimate (a table
 * never analyzed, a view) or the catalog cannot be read.
 */
export async function estimatePostgresTableRows(
  database: QueryEngineDb,
  table: PgTable,
  observing?: PlanningObserver,
  /** What the estimate is cached under: the engine's database, so transactions share it. */
  cacheKey: object = database,
): Promise<number | undefined> {
  if (!isPostgresDatabase(database)) return undefined;
  let tables = tableRows.get(cacheKey);
  if (!tables) {
    tables = new WeakMap();
    tableRows.set(cacheKey, tables);
  }
  const cached = tables.get(table);
  if (cached && Date.now() - cached.at < tableRowsTtl) return cached.rows;
  const name = dialect.sqlToQuery(sql`${table}`).sql;
  const catalog = sql`select reltuples::float8 as rows from pg_catalog.pg_class where oid = to_regclass(${name})`;
  const execution = database.execute<{ rows: unknown }>(catalog, "objects");
  const pending = Promise.resolve(
    observing ? observing.observer.raw("plan", observing.request, catalog, execution) : execution,
  )
    .then((rows) => {
      const value = Number(rows[0]?.rows);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    })
    .catch(() => {
      // An estimate only picks between equivalent plans.
      tables.delete(table);
      return undefined;
    });
  tables.set(table, { at: Date.now(), rows: pending });
  return pending;
}

export function isPostgresDatabase(database: QueryEngineDb) {
  return is(database, PgAsyncDatabase);
}

export async function withScanDatabase<TResult>(
  database: QueryEngineDb,
  consume: (database: QueryEngineDb) => Promise<TResult>,
): Promise<TResult> {
  if (!isPostgresDatabase(database)) return consume(database);
  if (is(database, PgAsyncTransaction)) {
    const [settings] = await database.execute(
      sql`select current_setting('transaction_isolation') as isolation`,
      "objects",
    );
    if (settings?.isolation !== "repeatable read" && settings?.isolation !== "serializable") {
      throw new Error("A scan requires a repeatable-read or serializable transaction");
    }
    return consume(database);
  }
  return database.transaction((transaction) => consume(transaction), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function scanPostgresCursor<TResult>(
  options: {
    db: QueryEngineDb;
    query: SQL;
    batchSize: number;
    signal?: AbortSignal;
    observing?: PlanningObserver;
  },
  consume: (batches: AsyncIterable<Record<string, unknown>[]>) => Promise<TResult>,
): Promise<TResult> {
  const database = options.db;
  if (!is(database, PgAsyncTransaction)) {
    throw new Error("A PostgreSQL cursor requires a transaction");
  }
  const transaction = database;
  options.signal?.throwIfAborted();
  const name = sql.identifier(`resource_scan_${crypto.randomUUID().replaceAll("-", "")}`);
  const { observing } = options;
  /** A scan reports its cursor statements as `scan`: declare, each fetch, close. */
  function execute<TRows = unknown>(statement: SQL, mapping?: "objects"): PromiseLike<TRows> {
    const execution = (
      mapping ? transaction.execute(statement, mapping) : transaction.execute(statement)
    ) as PromiseLike<TRows>;
    return observing
      ? observing.observer.raw("scan", observing.request, statement, execution)
      : execution;
  }
  await execute(sql`declare ${name} no scroll cursor for ${options.query}`);
  let active = true;
  let failed = false;
  async function* read() {
    while (true) {
      if (!active) throw new Error("Scan batches cannot be read outside the scan callback");
      options.signal?.throwIfAborted();
      const rows = await execute<Record<string, unknown>[]>(
        sql`fetch forward ${sql.raw(String(options.batchSize))} from ${name}`,
        "objects",
      );
      options.signal?.throwIfAborted();
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < options.batchSize) return;
    }
  }
  const batches = read();
  try {
    return await consume(batches);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    active = false;
    await batches.return();
    const closing = Promise.resolve(execute(sql`close ${name}`));
    if (failed) await closing.catch(() => undefined);
    else await closing;
  }
}

/** SQLSTATE `query_canceled`: raised for a statement timeout and for any other cancel. */
export function isQueryCanceled(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === "57014") return true;
    current = record.cause;
  }
  return false;
}

/**
 * Whether a canceled statement was cancelled by the timeout we set. The error message is
 * translated by the server's `lc_messages`, so it cannot tell a timeout from a user cancel
 * (`pg_cancel_backend`). The elapsed time can: a statement our timeout cancelled has run for at
 * least the timeout, less a small margin for clocks and scheduling.
 */
export function isOurTimeout(error: unknown, elapsedMilliseconds: number, timeout: number) {
  return isQueryCanceled(error) && elapsedMilliseconds >= timeout - Math.min(5, timeout * 0.1);
}

// Transactions the engine opened for a timed stage. Nothing but the engine runs on them.
const ownedTransactions = new WeakSet<object>();

/**
 * A transaction the caller passed in (`db: tx`). Statements on its connection can overlap in
 * time, so a `statement_timeout` set for one stage would apply to every other statement running
 * at the same moment and could abort the caller's transaction. The engine therefore sets no
 * timeouts there.
 */
export function isCallerTransaction(database: QueryEngineDb) {
  return is(database, PgAsyncTransaction) && !ownedTransactions.has(database);
}

/**
 * Run `run` with `statement_timeout` set for its statements only, in a transaction the engine
 * owns. With `capToCurrent` the timeout is the smaller of `milliseconds` and the setting already
 * in force. A statement that exceeds the timeout resolves to `{ timedOut: true }`; any other
 * error, including a cancel that came from somewhere else, is thrown. In a caller's transaction
 * and on other databases `run` executes without a timeout.
 */
export async function withStatementTimeout<TResult>(
  database: QueryEngineDb,
  milliseconds: number | undefined,
  run: (database: QueryEngineDb) => Promise<TResult>,
  options: { capToCurrent?: boolean } = {},
): Promise<{ timedOut: false; value: TResult } | { timedOut: true }> {
  if (
    milliseconds === undefined ||
    !isPostgresDatabase(database) ||
    isCallerTransaction(database)
  ) {
    return { timedOut: false, value: await run(database) };
  }
  const nested = is(database, PgAsyncTransaction);
  const started = performance.now();
  try {
    const value = await (database as any).transaction(async (transaction: any) => {
      ownedTransactions.add(transaction);
      let previous: string | undefined;
      if (nested) {
        const [row] = await transaction.execute(
          sql`select current_setting('statement_timeout') as value`,
          "objects",
        );
        previous = String(row?.value ?? "0");
      }
      const limit = String(Math.ceil(milliseconds));
      await transaction.execute(
        options.capToCurrent
          ? sql`select set_config('statement_timeout', least(${limit}::numeric, coalesce(nullif(extract(epoch from current_setting('statement_timeout')::interval) * 1000, 0), ${limit}::numeric))::bigint::text, true)`
          : sql`select set_config('statement_timeout', ${limit}, true)`,
      );
      const result = await run(transaction);
      // RELEASE SAVEPOINT keeps a SET LOCAL until the enclosing transaction ends.
      if (previous !== undefined) {
        await transaction.execute(sql`select set_config('statement_timeout', ${previous}, true)`);
      }
      return result;
    });
    return { timedOut: false, value };
  } catch (error) {
    if (isOurTimeout(error, performance.now() - started, milliseconds)) return { timedOut: true };
    throw error;
  }
}
