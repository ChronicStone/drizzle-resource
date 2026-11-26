import { is, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgAsyncDatabase, PgAsyncTransaction } from "drizzle-orm/pg-core/async";
import { PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { QueryEngineDb } from "./types.js";

const searchIndexes = new WeakMap<object, WeakMap<PgTable, Promise<Set<string>>>>();
const dialect = new PgDialect();

export async function estimatePostgresQuery(
  database: QueryEngineDb,
  query: SQL,
  metric: "Total Cost" | "Plan Rows" = "Total Cost",
) {
  if (!isPostgresDatabase(database)) return undefined;
  /* an estimate only picks between equivalent plans, so any failure keeps the ordinary one */
  try {
    const rows = await database.execute<{ "QUERY PLAN": unknown }>(
      sql`explain (format json) ${query}`,
      "objects",
    );
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

export async function probePostgresSearch(database: QueryEngineDb, table: PgTable) {
  if (!isPostgresDatabase(database)) return new Set<string>();
  let tables = searchIndexes.get(database);
  if (!tables) {
    tables = new WeakMap();
    searchIndexes.set(database, tables);
  }
  const cached = tables.get(table);
  if (cached) return cached;
  const name = dialect.sqlToQuery(sql`${table}`).sql;
  const pending = database
    .execute<{ column: string }>(
      sql`
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
  `,
      "objects",
    )
    .then((rows) => new Set(rows.map((row) => row.column)))
    .catch((error: unknown) => {
      tables.delete(table);
      throw error;
    });
  tables.set(table, pending);
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
  await database.execute(sql`declare ${name} no scroll cursor for ${options.query}`);
  let active = true;
  let failed = false;
  async function* read() {
    while (true) {
      if (!active) throw new Error("Scan batches cannot be read outside the scan callback");
      options.signal?.throwIfAborted();
      const rows = await transaction.execute(
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
    const closing = database.execute(sql`close ${name}`);
    if (failed) await closing.catch(() => undefined);
    else await closing;
  }
}

/** True for PostgreSQL's "canceling statement due to statement timeout", not for any cancel. */
export function isStatementTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      record.code === "57014" &&
      typeof record.message === "string" &&
      /statement timeout/i.test(record.message)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

// A transaction runs one statement at a time, and Drizzle names every sibling savepoint `sp1`.
// Timed statements inside a caller's transaction therefore wait for each other.
const transactionQueues = new WeakMap<object, Promise<unknown>>();

async function runTimed<TResult>(
  database: QueryEngineDb,
  milliseconds: number,
  run: (database: QueryEngineDb) => Promise<TResult>,
): Promise<TResult> {
  const nested = is(database, PgAsyncTransaction);
  return (database as any).transaction(async (transaction: any) => {
    let previous: string | undefined;
    if (nested) {
      const [row] = await transaction.execute(
        sql`select current_setting('statement_timeout') as value`,
        "objects",
      );
      previous = String(row?.value ?? "0");
    }
    await transaction.execute(
      sql`select set_config('statement_timeout', ${String(Math.ceil(milliseconds))}, true)`,
    );
    const result = await run(transaction);
    // RELEASE SAVEPOINT keeps a SET LOCAL until the caller's transaction ends.
    if (previous !== undefined) {
      await transaction.execute(sql`select set_config('statement_timeout', ${previous}, true)`);
    }
    return result;
  });
}

/**
 * Run `run` with `statement_timeout` set for its statements only. On a pooled connection the
 * setting lives in a transaction of its own. Inside a caller's transaction it lives in a savepoint
 * that is rolled back on a timeout, so the caller's transaction is never aborted, and the previous
 * value is restored on success. A statement that exceeds the timeout resolves to
 * `{ timedOut: true }`; any other error is thrown. Other databases run without a timeout.
 */
export async function withStatementTimeout<TResult>(
  database: QueryEngineDb,
  milliseconds: number | undefined,
  run: (database: QueryEngineDb) => Promise<TResult>,
): Promise<{ timedOut: false; value: TResult } | { timedOut: true }> {
  if (milliseconds === undefined || !isPostgresDatabase(database)) {
    return { timedOut: false, value: await run(database) };
  }
  const attempt = async (): Promise<{ timedOut: false; value: TResult } | { timedOut: true }> => {
    try {
      return { timedOut: false, value: await runTimed(database, milliseconds, run) };
    } catch (error) {
      if (isStatementTimeout(error)) return { timedOut: true };
      throw error;
    }
  };
  if (!is(database, PgAsyncTransaction)) return attempt();
  const previous = transactionQueues.get(database) ?? Promise.resolve();
  const next = previous.then(attempt, attempt);
  transactionQueues.set(
    database,
    next.catch(() => undefined),
  );
  return next;
}

/** Whether statements on this database share one connection and cannot overlap. */
export function isTransactionDatabase(database: QueryEngineDb) {
  return is(database, PgAsyncTransaction);
}
