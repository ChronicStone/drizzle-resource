// Prints `formatExplain` for the requests shown in docs/content/6.reference/7.explain.md, on the
// benchmark schema. Paste the output into the page as it is.
//
//   TEST_DATABASE_URL=postgres://... bun tools/explain-samples.ts
import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, index, integer, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createQueryEngine, formatExplain } from "../packages/core/index.ts";
import type { QueryRequestInput } from "../packages/core/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required; use an isolated database");
const rows = Number(process.env.SAMPLE_ROWS ?? 1_000_000);
const namespace = pgSchema(`resource_samples_${randomUUID().replaceAll("-", "")}`);
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
const pool = new Pool({ connectionString, max: 4 });
const db = drizzle({ client: pool, relations });

try {
  await db.execute(sql`create extension if not exists pg_trgm`);
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
  await db.execute(sql`create index on ${consumption} using gin (lower(reference) gin_trgm_ops)`);
  await db.execute(sql`create index on ${accounts} using gin (lower(name) gin_trgm_ops)`);
  await db.execute(sql`analyze ${consumption}`);
  await db.execute(sql`analyze ${accounts}`);
  const resource = createQueryEngine({ db, schema, relations }).defineResource("consumption", {
    relations: { account: true },
    query: {
      pagination: { modes: ["offset", "cursor"] },
      facets: { allowed: ["year", "month", "billed", "account.name", "account.type"] },
    },
  });
  const base = {
    sorting: [
      { key: "year", dir: "desc" },
      { key: "month", dir: "desc" },
    ],
    filters: [],
    search: { value: "", fields: [] },
  } as const;
  const samples: QueryRequestInput[] = [
    {
      ...base,
      pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count: "exact" },
      facets: [
        { key: "year", limit: 50 },
        { key: "month", limit: 50 },
        { key: "billed", limit: 50 },
      ],
    },
    { ...base, pagination: { mode: "offset", pageIndex: 15_000, pageSize: 50, count: "none" } },
  ];
  for (const request of samples) {
    console.log(`${formatExplain(await resource.explain({ request, analyze: true }))}\n`);
  }
} finally {
  await db.execute(sql`drop schema ${sql.identifier(namespace.schemaName)} cascade`);
  await pool.end();
}
