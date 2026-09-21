import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
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
    reference: text().notNull(),
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
    query: {
      pagination: { modes: ["offset", "cursor"] },
      facets: { allowed: ["year", "month", "billed", "account.name", "account.type"] },
    },
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
    name: "page-and-shared-count-facets",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.query({ request: { ...request, facets: rootFacets } }),
  },
  {
    name: "relation-sorted-count",
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryIds({
        request: { ...request, sorting: [{ key: "account.name", dir: "asc" }] },
      }),
  },
  ...["Ref 199999", "account 19999", "account", "ref"].map((value) => ({
    name: `cross-table-search-${value.replaceAll(" ", "-")}`,
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryIds({
        request: { ...request, search: { value, fields: ["reference", "account.name"] } },
      }),
  })),
  ...["account 19999", "ref"].map((value) => ({
    name: `countless-cross-table-search-${value.replaceAll(" ", "-")}`,
    execute: (resource: ReturnType<typeof makeResource>) =>
      resource.queryIds({
        request: {
          ...request,
          pagination: { ...request.pagination, count: "none" },
          search: { value, fields: ["reference", "account.name"] },
        },
      }),
  })),
  ...["19999", "account", "not-here"].flatMap((value) =>
    (["none", "exact", "facets"] as const).map((mode) => ({
      name: `wide-search-${value}-${mode}`,
      execute: (resource: ReturnType<typeof makeResource>) =>
        resource.query({
          request: {
            ...request,
            pagination: { ...request.pagination, count: mode === "none" ? "none" : "exact" },
            search: {
              value,
              fields: [
                "id",
                "accountId",
                "year",
                "month",
                "billed",
                "reference",
                "account.id",
                "account.name",
                "account.type",
              ],
            },
            ...(mode === "facets" ? { facets: allFacets } : {}),
          },
        }),
    })),
  ),
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
        facets: [...(result.facets ?? [])].sort((left, right) => left.key.localeCompare(right.key)),
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
    month integer not null, billed boolean not null, reference text not null
  )`);
  await db.execute(
    sql`insert into ${accounts} select n, 'Account ' || n, 'Type ' || (n % 4) from generate_series(1, 20000) n`,
  );
  await db.execute(sql`insert into ${consumption}
    select n, (n % 20000) + 1, 2020 + (n % 7), (n % 12) + 1, n % 2 = 0, 'Ref ' || n
    from generate_series(1, ${rows}::integer) n`);
  await db.execute(sql`create index on ${consumption} (year, month, id)`);
  await db.execute(sql`create index on ${consumption} ("accountId")`);
  await db.execute(sql`create extension if not exists pg_trgm`);
  await db.execute(sql`create index on ${consumption} using gin (lower(reference) gin_trgm_ops)`);
  await db.execute(sql`create index on ${accounts} using gin (lower(name) gin_trgm_ops)`);
  await db.execute(sql`vacuum analyze ${consumption}`);
  await db.execute(sql`vacuum analyze ${accounts}`);
  const environment = await db.execute(
    sql`select version(), current_setting('work_mem') as work_mem`,
  );
  for (const scenario of scenarios) {
    if (process.env.BENCH_SCENARIO && !scenario.name.includes(process.env.BENCH_SCENARIO)) continue;
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
  const scans = [];
  if (process.env.BENCH_SCAN === "1") {
    const batchSize = 1000;
    const scanIterations = Number(process.env.BENCH_SCAN_ITERATIONS ?? 3);
    assert(Number.isSafeInteger(scanIterations) && scanIterations > 0);
    for (const sorting of [request.sorting, [{ key: "account.name", dir: "asc" as const }]]) {
      const results = [];
      for (let iteration = 0; iteration < scanIterations; iteration += 1) {
        const variants = ["baseline-pages", "optimized-pages", "scan"] as const;
        for (const variant of iteration % 2 === 0 ? variants : variants.toReversed()) {
          const digest = createHash("sha256");
          let rowCount = 0;
          let maxBatchSize = 0;
          function consumeRows(
            batch: Awaited<ReturnType<typeof resources.optimized.query>>["rows"],
          ) {
            rowCount += batch.length;
            maxBatchSize = Math.max(maxBatchSize, batch.length);
            for (const row of batch) digest.update(JSON.stringify(row));
          }
          statementCount = 0;
          const cpuStart = process.cpuUsage();
          const start = performance.now();
          if (variant === "scan") {
            await resources.optimized.scan(
              { request: { ...request, sorting }, batchSize, count: "exact" },
              async (batches) => {
                for await (const batch of batches) {
                  assert.equal(batch.totalRows, rows);
                  consumeRows(batch.rows);
                }
              },
            );
          } else {
            const resource =
              variant === "baseline-pages" ? resources.baseline : resources.optimized;
            await db.transaction(
              async (transaction) => {
                let cursor: string | null = null;
                do {
                  const page: Awaited<ReturnType<typeof resource.query>> = await resource.query({
                    db: transaction,
                    execution: { maxPageSize: batchSize },
                    request: {
                      ...request,
                      sorting,
                      pagination: {
                        mode: "cursor",
                        pageSize: batchSize,
                        cursor,
                        count: cursor ? "none" : "exact",
                      },
                    },
                  });
                  consumeRows(page.rows);
                  assert.equal(page.pageInfo.mode, "cursor");
                  if (page.pageInfo.mode !== "cursor") throw new Error("Expected cursor metadata");
                  cursor = page.pageInfo.nextCursor;
                } while (cursor);
              },
              { isolationLevel: "repeatable read", accessMode: "read only" },
            );
          }
          const result = {
            iteration,
            variant,
            durationMs: performance.now() - start,
            clientCpuMs:
              Object.values(process.cpuUsage(cpuStart)).reduce((sum, value) => sum + value, 0) /
              1000,
            statements: statementCount,
            rowCount,
            maxBatchSize,
            digest: digest.digest("hex"),
          };
          assert.equal(rowCount, rows);
          assert(maxBatchSize <= batchSize);
          if (results.length) assert.equal(result.digest, results[0]!.digest);
          results.push(result);
          console.error(JSON.stringify({ sorting, ...result }));
        }
      }
      scans.push({ sorting, results });
    }
  }
  const output = JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      baseline: process.env.BENCH_BASELINE_LABEL ?? "provided module",
      rows,
      iterations,
      environment: environment.rows[0],
      measurements,
      scans,
    },
    null,
    2,
  );
  if (process.env.BENCH_OUTPUT) await writeFile(process.env.BENCH_OUTPUT, `${output}\n`);
  console.log(output);
} finally {
  await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
  await pool.end();
}
