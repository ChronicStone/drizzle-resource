import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { count, defineRelations, eq, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, numeric, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createQueryEngine } from "../packages/core/index.ts";
import type { QueryRequestInput } from "../packages/core/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("TEST_DATABASE_URL must point to an isolated local database");
const rows = Number(process.env.BENCH_ROWS ?? 200_000);
const iterations = Number(process.env.BENCH_ITERATIONS ?? 10);
assert(Number.isSafeInteger(rows) && rows > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const namespace = pgSchema(`summary_bench_${randomUUID().replaceAll("-", "")}`);
const accounts = namespace.table("accounts", {
  id: integer().primaryKey(),
  tenant: integer().notNull(),
  amount: numeric().notNull(),
  privateNotes: text().notNull(),
});
const schema = { accounts };
const relations = defineRelations(schema);
const pool = new Pool({ connectionString });
let statements = 0;
const db = drizzle({
  client: pool,
  relations,
  logger: {
    logQuery() {
      statements++;
    },
  },
});
const resource = createQueryEngine({
  db,
  schema,
  relations,
  models: { accounts: { private: ["privateNotes"], hidden: ["tenant"] } },
})
  .withContext<{ tenant: number }>()
  .defineResource("accounts", {
    views: { list: { select: { id: true, amount: true } } },
    query: { scope: (f, context) => f.is("tenant", context.tenant) },
    summary: (account) => ({ rows: count(), amount: sum(account.amount) }),
  });
const request: QueryRequestInput = {
  pagination: { pageIndex: 1, pageSize: 50, count: "exact" },
  filters: [],
  sorting: [],
  search: { value: "", fields: [] },
};
const context = { tenant: 1 };
const raw = async () =>
  (
    await db
      .select({ rows: count(), amount: sum(accounts.amount) })
      .from(accounts)
      .where(eq(accounts.tenant, context.tenant))
  )[0]!;
const aggregate = () => resource.querySummary({ request, context });
const page = () => resource.query({ request, context, view: "list", summary: true });

try {
  await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
  await db.execute(
    sql`create table ${accounts} (id integer primary key, tenant integer not null, amount numeric not null, "privateNotes" text not null)`,
  );
  await db.execute(
    sql`insert into ${accounts} select i, i % 2, (i % 10000)::numeric / 100, repeat('private', 30) from generate_series(1, ${rows}::integer) i`,
  );
  await db.execute(sql`analyze ${accounts}`);
  const expected = await raw();
  assert.deepEqual(await aggregate(), expected);
  statements = 0;
  await aggregate();
  assert.equal(statements, 1, "A standalone summary must execute one statement");
  statements = 0;
  const result = await page();
  assert.deepEqual(result.summary, expected);
  assert.equal(result.pageInfo.rowCount, expected.rows);
  assert.equal(statements, 3, "A summary page must reuse its count: aggregate, IDs, hydration");
  assert(result.rows.every((row) => Object.keys(row).sort().join(",") === "amount,id"));
  const scenarios = { raw, aggregate, page };
  const timings: Record<keyof typeof scenarios, number[]> = { raw: [], aggregate: [], page: [] };
  for (let i = 0; i < iterations + 3; i++) {
    // Alternate order and exclude warmup runs to reduce cache/order bias.
    const names = Object.keys(scenarios) as Array<keyof typeof scenarios>;
    if (i % 2) names.reverse();
    for (const name of names) {
      const start = performance.now();
      await scenarios[name]();
      if (i >= 3) timings[name].push(performance.now() - start);
    }
  }
  console.log(
    JSON.stringify(
      {
        rows,
        matchingRows: expected.rows,
        iterations,
        statementCounts: { aggregate: 1, page: 3 },
        medianMs: Object.fromEntries(
          Object.entries(timings).map(([name, values]) => {
            values.sort((a, b) => a - b);
            const middle = Math.floor(values.length / 2);
            const median =
              values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
            return [name, Number(median.toFixed(2))];
          }),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
  } finally {
    await pool.end();
  }
}
