import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, index, integer, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createQueryEngine } from "../packages/core/index.ts";
import type { QueryRequestInput } from "../packages/core/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("TEST_DATABASE_URL is required; use an isolated local database");
const baselineModule = process.env.BENCH_BASELINE_MODULE;
if (!baselineModule)
  throw new Error("BENCH_BASELINE_MODULE must point to the baseline package entrypoint");
const baseline = (await import(pathToFileURL(resolve(baselineModule)).href)) as {
  createQueryEngine: typeof createQueryEngine;
};
const rows = Number(process.env.BENCH_ROWS ?? 200_000);
const iterations = Number(process.env.BENCH_ITERATIONS ?? 10);
assert(Number.isSafeInteger(rows) && rows > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const namespace = pgSchema(`resource_bench_${randomUUID().replaceAll("-", "")}`);
const accounts = namespace.table("accounts", {
  id: integer().primaryKey(),
  name: text().notNull(),
  type: text().notNull(),
});
const consumption = namespace.table(
  "consumption",
  {
    id: integer().primaryKey(),
    accountId: integer().notNull(),
    year: integer().notNull(),
    month: integer().notNull(),
    billed: boolean().notNull(),
  },
  (table) => [index().on(table.year, table.month, table.id), index().on(table.accountId)],
);
const schema = { accounts, consumption };
const relations = defineRelations(schema, (r) => ({
  consumption: { account: r.one.accounts({ from: r.consumption.accountId, to: r.accounts.id }) },
}));
const pool = new Pool({ connectionString, max: 10 });
let statementCount = 0;
const db = drizzle({
  client: pool,
  relations,
  logger: {
    logQuery() {
      statementCount += 1;
    },
  },
});
function makeResource(factory: typeof createQueryEngine) {
  return factory({ db, schema, relations }).defineResource("consumption", {
    relations: { account: true },
    query: { facets: { allowed: ["year", "month", "billed", "account.name", "account.type"] } },
  });
}
const resources = {
  baseline: makeResource(baseline.createQueryEngine),
  optimized: makeResource(createQueryEngine),
};
const request: QueryRequestInput = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count: "exact" },
  filters: [],
  search: { value: "", fields: [] },
  sorting: [
    { key: "year", dir: "desc" },
    { key: "month", dir: "desc" },
  ],
};
const rootFacets = (["year", "month", "billed"] as const).map((key) => ({ key, limit: 50 }));
const allFacets = [
  ...rootFacets,
  { key: "account.name" as const, limit: 50 },
  { key: "account.type" as const, limit: 50 },
];
const scenarios = [
  {
    name: "page-without-count",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryIds({
        request: { ...request, pagination: { ...request.pagination, count: "none" } },
      }),
  },
  {
    name: "page-exact-count",
    execute: (resource: ReturnType<typeof makeResource>) => resource.queryIds({ request }),
  },
  {
    name: "relation-search-page",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryIds({
        request: { ...request, search: { value: "account 1", fields: ["account.name"] } },
      }),
  },
  {
    name: "three-root-facets",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryFacets({ request, facets: rootFacets }),
  },
  {
    name: "five-mixed-facets",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryFacets({ request, facets: allFacets }),
  },
  {
    name: "filtered-exclude-self-facets",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryFacets({
        request: {
          ...request,
          filters: [{ type: "condition", key: "billed", operator: "is", value: true }],
        },
        facets: allFacets,
      }),
  },
];
const measurements = [];
function canonicalResult(result: Awaited<ReturnType<(typeof scenarios)[number]["execute"]>>) {
  return "facets" in result
    ? {
        ...result,
        facets: [...result.facets].sort((left, right) => left.key.localeCompare(right.key)),
      }
    : result;
}
try {
  await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
  await db.execute(
    sql`create table ${accounts} (id integer primary key, name text not null, type text not null)`,
  );
  await db.execute(sql`create table ${consumption} (
    id integer primary key, "accountId" integer not null, year integer not null,
    month integer not null, billed boolean not null
  )`);
  await db.execute(
    sql`insert into ${accounts} select n, 'Account ' || n, 'Type ' || (n % 4) from generate_series(1, 20000) n`,
  );
  await db.execute(sql`insert into ${consumption}
    select n, (n % 20000) + 1, 2020 + (n % 7), (n % 12) + 1, n % 2 = 0
    from generate_series(1, ${rows}::integer) n`);
  await db.execute(sql`create index on ${consumption} (year, month, id)`);
  await db.execute(sql`create index on ${consumption} ("accountId")`);
  await db.execute(sql`vacuum analyze ${consumption}`);
  await db.execute(sql`vacuum analyze ${accounts}`);
  const environment = await db.execute(
    sql`select version(), current_setting('work_mem') as work_mem`,
  );
  for (const scenario of scenarios) {
    const expected = await scenario.execute(resources.baseline);
    assert.deepEqual(
      canonicalResult(await scenario.execute(resources.optimized)),
      canonicalResult(expected),
      scenario.name,
    );
    const durations = { baseline: [] as number[], optimized: [] as number[] };
    const statements = { baseline: 0, optimized: 0 };
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const variant of iteration % 2 === 0
        ? (["baseline", "optimized"] as const)
        : (["optimized", "baseline"] as const)) {
        statementCount = 0;
        const start = performance.now();
        await scenario.execute(resources[variant]);
        durations[variant].push(performance.now() - start);
        statements[variant] += statementCount;
      }
    }
    const result = {
      scenario: scenario.name,
      variants: Object.fromEntries(
        Object.entries(durations).map(([name, samples]) => {
          samples.sort((a, b) => a - b);
          return [
            name,
            {
              medianMs: samples[Math.floor(samples.length / 2)],
              maxMs: samples.at(-1),
              statementsPerRequest: statements[name as keyof typeof statements] / iterations,
            },
          ];
        }),
      ),
    };
    measurements.push(result);
    console.error(JSON.stringify(result));
  }
  console.log(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        rows,
        iterations,
        environment: environment.rows[0],
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
  await pool.end();
}
