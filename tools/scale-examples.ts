/**
 * Writes docs/app/data/scale-examples.json: the console output that the Scale pages of the docs
 * show for onQuery, explain() and checkIndexes(), captured from a real run.
 *
 *   TEST_DATABASE_URL=postgres://… bun tools/scale-examples.ts [--rows 1000000] [--keep] [--reuse]
 *
 * It creates a database named scale_examples next to TEST_DATABASE_URL's, fills it with the
 * benchmark's orders/customers tables (docs/scale-example.ts), runs the code the docs show, and
 * drops the database unless --keep is given (--reuse skips building it). Timings come from one
 * run on whatever machine runs this: they illustrate the tools, they are not benchmark results.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createQueryEngine, formatExplain, formatIndexFindings } from "../packages/core/index.ts";
import type { QueryEvent, QueryRequestInput } from "../packages/core/index.ts";
import {
  byCustomerRequest,
  deepRequest,
  listRequest,
  relationTenantRelations,
  relationTenantSchema,
  scaleRelations,
  scaleRelationsAfter,
  scaleSchema,
  scaleSchemaAfter,
  softDeleteRelations,
  softDeleteSchema,
  statusRelations,
  statusSchema,
  tenantRelations,
  tenantSchema,
} from "../docs/scale-example.ts";
import type { IndexFinding } from "../packages/core/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required; use an isolated database");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const rows = Number(flag("--rows") ?? 1_000_000);
const keep = args.includes("--keep");
const reuse = args.includes("--reuse");
const root = join(import.meta.dir, "..");
const outFile = flag("--out") ?? join(root, "docs/app/data/scale-examples.json");
const DATABASE = "scale_examples";

const admin = new Pool({ connectionString, max: 1 });
if (!reuse) {
  await admin.query(`drop database if exists ${DATABASE} with (force)`);
  await admin.query(`create database ${DATABASE}`);
}
const url = new URL(connectionString);
url.pathname = `/${DATABASE}`;
const pool = new Pool({ connectionString: url.toString(), max: 10 });
const run = (statement: string) => pool.query(statement);

// ---------- the dataset: the benchmark's formulas and out-of-the-box indexes ----------
if (reuse) {
  await run(`drop index if exists orders_customer_name_id_idx`);
  await run(`alter table orders drop column if exists "customerName"`);
} else {
  await run(`create extension if not exists pg_trgm`);
  await run(
    `create table customers (id integer primary key, name text not null, segment text not null)`,
  );
  await run(`create table orders (
    id integer primary key, "customerId" integer not null, "orgId" integer not null,
    status text not null, paid boolean not null, "createdAt" timestamptz not null,
    reference text not null)`);
  await run(`insert into customers
    select n, 'Customer ' || n, 'Segment ' || (n % 4) from generate_series(1, 20000) n`);
  await run(`insert into orders
    select n, (n % 20000) + 1, (n % 100) + 1,
      (array['pending','paid','shipped','delivered','cancelled'])[(n % 5) + 1],
      n % 2 = 0,
      timestamptz '2019-11-01 00:00:00+00' + interval '7 years' * ((n - 1)::double precision / ${rows}),
      'ORD-' || lpad(n::text, 8, '0')
    from generate_series(1, ${rows}) n`);
  await run(`create index orders_created_at_id_idx on orders ("createdAt", id)`);
  await run(`create index orders_customer_id_idx on orders ("customerId")`);
  await run(
    `create index orders_reference_search on orders using gin (lower(reference) gin_trgm_ops)`,
  );
  await run(`create index customers_name_search on customers using gin (lower(name) gin_trgm_ops)`);
  await run(`vacuum analyze orders`);
  await run(`vacuum analyze customers`);
}

// ---------- See: the snippet on /scale/optimize#see ----------
type ShapeStats = { statements: number; ms: number; slowest: QueryEvent };
const byShape = new Map<string, ShapeStats>();
const onQuery = (event: QueryEvent) => {
  const stats = byShape.get(event.shape) ?? { statements: 0, ms: 0, slowest: event };
  stats.statements += 1;
  stats.ms += event.ms;
  if (event.ms > stats.slowest.ms) stats.slowest = event;
  byShape.set(event.shape, stats);
};
const printSlowest = () =>
  [...byShape]
    .sort(([, a], [, b]) => b.ms - a.ms)
    .slice(0, 5)
    .map(
      ([shape, { ms, statements, slowest }]) =>
        `${Math.round(ms).toLocaleString("en-US").padStart(7)} ms  ${shape}\n` +
        `            ${statements} statements, slowest: ${slowest.stage} ${Math.round(slowest.ms)} ms`,
    )
    .join("\n");

const db = drizzle({ client: pool, relations: scaleRelations });
const engine = createQueryEngine({ db, schema: scaleSchema, relations: scaleRelations, onQuery });
const ordersResource = engine.defineResource("orders", {
  relations: { customer: true },
  query: {
    pagination: { modes: ["offset", "cursor"] },
    search: { allowed: ["reference", "customer.name"], defaults: ["reference", "customer.name"] },
    facets: { allowed: ["status", "paid", "customer.segment"] },
    sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
  },
});

async function traffic(
  resource: { query: (options: { request: QueryRequestInput }) => Promise<unknown> },
  requests: QueryRequestInput[],
) {
  for (const request of requests) await resource.query({ request }); // warm-up
  byShape.clear();
  for (let round = 0; round < 3; round++) {
    for (const request of requests) await resource.query({ request });
  }
}

await traffic(ordersResource, [listRequest, byCustomerRequest, deepRequest]);
const seeBefore = printSlowest();

// ---------- Explain ----------
const explainList = formatExplain(
  await ordersResource.explain({ request: listRequest, analyze: true }),
);
const explainByCustomer = formatExplain(
  await ordersResource.explain({ request: byCustomerRequest, analyze: true }),
);
const explainDeep = formatExplain(
  await ordersResource.explain({ request: deepRequest, analyze: true }),
);

// ---------- Fix: what checkIndexes says, then the copied column ----------
const checkStatic = formatIndexFindings(engine.checkIndexes());
const checkLive = formatIndexFindings(await engine.checkIndexes({ live: true }));

// ---------- Indexes page: one resource per case, the findings that matter for it ----------
// The resource definitions are the ones on /scale/indexes. Each output keeps the rules that the
// case is about, as that page says.
const relevant = (findings: IndexFinding[], ...rules: IndexFinding["rule"][]) =>
  formatIndexFindings(findings.filter((f) => rules.includes(f.rule)));
const mockEngine = (schema: any, relations: any) =>
  createQueryEngine({ db: drizzle.mock({ relations }) as any, schema, relations });
const tenantScope = (f: any, ctx: { orgId: number }) => f.and([f.is("orgId", ctx.orgId)]);
const createdAtDesc = { defaults: [{ key: "createdAt", dir: "desc" }] } as const;
const indexes = {
  idxTenant: relevant(
    mockEngine(scaleSchema, scaleRelations)
      .defineResource("orders", { query: { scope: tenantScope, sort: createdAtDesc } })
      .checkIndexes({ context: { orgId: 42 } }),
    "default-sort-unindexed",
  ),
  idxTenantLive: relevant(
    await engine
      .defineResource("orders", { query: { scope: tenantScope, sort: createdAtDesc } })
      .checkIndexes({ live: true, context: { orgId: 42 } }),
    "default-sort-unindexed",
  ),
  idxTenantFixed: relevant(
    mockEngine(tenantSchema, tenantRelations)
      .defineResource("orders", { query: { scope: tenantScope, sort: createdAtDesc } })
      .checkIndexes({ context: { orgId: 42 } }),
    "default-sort-unindexed",
  ),
  idxMixed: relevant(
    mockEngine(scaleSchema, scaleRelations)
      .defineResource("orders", {
        query: {
          sort: {
            defaults: [
              { key: "status", dir: "asc" },
              { key: "createdAt", dir: "desc" },
            ],
          },
        },
      })
      .checkIndexes(),
    "default-sort-unindexed",
    "mixed-direction-sort",
  ),
  idxRelationSort: relevant(
    mockEngine(scaleSchema, scaleRelations)
      .defineResource("orders", {
        relations: { customer: true },
        query: { sort: { defaults: [{ key: "customer.name", dir: "asc" }] } },
      })
      .checkIndexes(),
    "relation-sort",
  ),
  idxTextScope: relevant(
    mockEngine(statusSchema, statusRelations)
      .defineResource("orders", {
        query: { scope: (f: any) => f.and([f.is("status", "paid")]), sort: createdAtDesc },
      })
      .checkIndexes(),
    "default-sort-unindexed",
  ),
  idxSoftDelete: relevant(
    mockEngine(softDeleteSchema, softDeleteRelations)
      .defineResource("orders", {
        query: {
          scope: (f: any, ctx: { orgId: number }) =>
            f.and([f.is("orgId", ctx.orgId), f.isEmpty("deletedAt")]),
          sort: createdAtDesc,
        },
      })
      .checkIndexes({ context: { orgId: 42 } }),
    "default-sort-unindexed",
  ),
  idxRelationTenant: relevant(
    mockEngine(relationTenantSchema, relationTenantRelations)
      .defineResource("orders", {
        relations: { customer: true },
        query: {
          scope: (f: any, ctx: { orgId: number }) => f.and([f.is("customer.orgId", ctx.orgId)]),
          sort: createdAtDesc,
        },
      })
      .checkIndexes({ context: { orgId: 42 } }),
    "scope-through-relation",
  ),
  idxSearchLive: relevant(
    await engine
      .defineResource("orders", {
        relations: { customer: true },
        query: {
          search: { allowed: ["reference", "status"], defaults: ["reference", "status"] },
          sort: createdAtDesc,
        },
      })
      .checkIndexes({ live: true }),
    "search-unindexed",
  ),
  idxSmallTable: formatIndexFindings(
    (
      await engine
        .defineResource("customers", {
          query: { sort: { defaults: [{ key: "name", dir: "asc" }] } },
        })
        .checkIndexes({ live: true, largeTable: { explain: 50_000 } })
    ).filter((f) => f.rule === "default-sort-unindexed"),
  ),
};

await run(`alter table orders add column "customerName" text`);
await run(
  `update orders o set "customerName" = c.name from customers c where c.id = o."customerId"`,
);
await run(`alter table orders alter column "customerName" set not null`);
await run(`create index orders_customer_name_id_idx on orders ("customerName", id)`);
await run(`vacuum analyze orders`);

// ---------- Guard: the resource of /scale/optimize#guard ----------
const dbAfter = drizzle({ client: pool, relations: scaleRelationsAfter });
const engineAfter = createQueryEngine({
  db: dbAfter,
  schema: scaleSchemaAfter,
  relations: scaleRelationsAfter,
  onQuery,
});
const guarded = engineAfter.defineResource("orders", {
  relations: { customer: true },
  query: {
    pagination: { modes: ["offset", "cursor"], countCap: 10_000 },
    defaults: { pagination: { mode: "offset", count: "capped" } },
    search: { allowed: ["reference", "customer.name"], defaults: ["reference", "customer.name"] },
    facets: { allowed: ["status", "paid", "customer.segment"], whenCapped: "skip" },
    sort: { defaults: [{ key: "createdAt", dir: "desc" }], disabled: ["customer.name"] },
    validation: { maxPageIndex: 400 },
    timeouts: { count: 500, facets: 2_000 },
  },
});
const capped = { mode: "offset", pageIndex: 1, pageSize: 50, count: "capped" } as const;
const checkAfter = formatIndexFindings(await engineAfter.checkIndexes({ live: true }));
await traffic(guarded, [
  { ...listRequest, pagination: capped },
  { ...byCustomerRequest, pagination: capped, sorting: [{ key: "customerName", dir: "asc" }] },
  { ...deepRequest, pagination: { mode: "cursor", cursor: null, pageSize: 50 } },
]);
const seeAfter = printSlowest();

const guardedList = await guarded.query({ request: { ...listRequest, pagination: capped } });
const guardResponse = JSON.stringify(
  { pageInfo: guardedList.pageInfo, facets: guardedList.facets },
  null,
  2,
);
let deepError = "";
try {
  await guarded.query({ request: { ...deepRequest, pagination: { ...capped, pageIndex: 4_000 } } });
} catch (error) {
  deepError = (error as Error).message;
}

const version = (await run("show server_version")).rows[0].server_version as string;
await pool.end();
if (!keep) await admin.query(`drop database ${DATABASE} with (force)`);
await admin.end();

const out = {
  $comment:
    "Console output shown on the docs' Scale pages. Regenerate with `bun tools/scale-examples.ts`; do not edit by hand. One run, not a benchmark.",
  generatedAt: new Date().toISOString().slice(0, 10),
  engine: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
  postgres: version,
  rows,
  customers: 20_000,
  outputs: {
    seeBefore,
    explainList,
    explainByCustomer,
    explainDeep,
    checkStatic,
    checkLive,
    checkAfter,
    seeAfter,
    guardResponse,
    deepError,
    ...indexes,
  },
};
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${outFile}`);
for (const [name, text] of Object.entries(out.outputs)) console.log(`\n--- ${name}\n${text}`);
