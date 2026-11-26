import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { createQueryEngine } from "../index.js";
import type { QueryEvent, QueryRequestInput } from "../index.js";

/**
 * A PostgreSQL schema with `orders` (the big table) and `customers`, shared by the `onQuery` and
 * `explain` tests. Columns are chosen so each warning has a request that triggers it:
 *
 * - `a` and `b` are both `id % 3`, `c` and `d` both `id % 20`: PostgreSQL multiplies their
 *   selectivities as if they were independent, so `a = 0 and b = 1` looks common and is empty,
 *   and `c = 3 and d = 3` looks rare and is not.
 * - `amount` is nearly unique and has no index.
 * - `created_at` increases with `id`; the only index on `orders` besides the key is the sort index.
 */
export function createObserveFixture(options: {
  rows: number;
  onQuery?: (event: QueryEvent) => void;
}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  const namespace = pgSchema(`resource_observe_${randomUUID().replaceAll("-", "")}`);
  const customers = namespace.table("customers", {
    id: integer().primaryKey(),
    name: text().notNull(),
    country: text().notNull(),
  });
  const orders = namespace.table("orders", {
    id: integer().primaryKey(),
    reference: text().notNull(),
    status: text().notNull(),
    region: text().notNull(),
    customerId: integer("customer_id").notNull(),
    amount: integer().notNull(),
    createdAt: timestamp("created_at").notNull(),
    a: integer().notNull(),
    b: integer().notNull(),
    c: integer().notNull(),
    d: integer().notNull(),
  });
  const schema = { customers, orders };
  const relations = defineRelations(schema, (r) => ({
    orders: { customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id }) },
  }));
  const client = new Pool({ connectionString, max: 6 });
  const statements: string[] = [];
  const db = drizzle({
    client,
    relations,
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  const events: QueryEvent[] = [];
  const engine = createQueryEngine({
    db,
    schema,
    relations,
    onQuery: (event) => {
      events.push(event);
      return options.onQuery?.(event);
    },
  });
  const ordersResource = engine.defineResource("orders", {
    relations: { customer: true },
    summary: (fields) => ({ total: sql<number>`sum(${fields.amount})`.mapWith(Number) }),
    query: {
      pagination: { modes: ["offset", "cursor"] },
      search: { allowed: ["reference", "customer.name"] },
      facets: { allowed: ["status", "region", "customer.country"] },
    },
  });
  /** Same table, no cursor mode, scoped: for shapes and for the "allow cursor" advice. */
  const scopedResource = engine.withContext<{ region: string }>().defineResource("orders", {
    query: {
      pagination: { modes: ["offset"] },
      scope: (filters, context) => filters.is("region", context.region),
    },
  });

  async function setup() {
    // Test files run in parallel and `create extension if not exists` still races: take a lock.
    const installer = await client.connect();
    try {
      await installer.query("select pg_advisory_lock(87654321)");
      await installer.query("create extension if not exists pg_trgm");
    } finally {
      await installer.query("select pg_advisory_unlock(87654321)").catch(() => undefined);
      installer.release();
    }
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(sql`create table ${customers} (
      id integer primary key, name text not null, country text not null
    )`);
    await db.execute(sql`create table ${orders} (
      id integer primary key, reference text not null, status text not null, region text not null,
      customer_id integer not null, amount integer not null, created_at timestamp not null,
      a integer not null, b integer not null, c integer not null, d integer not null
    )`);
    await db.execute(sql`
      insert into ${customers} (id, name, country)
      select n, 'customer ' || n, (array['FR', 'DE', 'US', 'JP'])[1 + n % 4]
      from generate_series(1, 1000) as n
    `);
    await db.execute(sql`
      insert into ${orders}
        (id, reference, status, region, customer_id, amount, created_at, a, b, c, d)
      select n, 'ref-' || n, (array['new', 'paid', 'shipped', 'cancelled'])[1 + n % 4],
        (array['eu', 'us', 'apac'])[1 + n % 3], 1 + n % 1000, (n::bigint * 7919 % 1000003)::int,
        timestamp '2026-01-01' + n * interval '1 second', n % 3, n % 3, n % 20, n % 20
      from generate_series(1, ${options.rows}::int) as n
    `);
    await db.execute(sql`create index on ${orders} (created_at desc, id desc)`);
    await db.execute(sql`create index on ${orders} using gin (lower(reference) gin_trgm_ops)`);
    await db.execute(sql`create index on ${customers} using gin (lower(name) gin_trgm_ops)`);
    await db.execute(sql`analyze ${orders}`);
    await db.execute(sql`analyze ${customers}`);
  }

  async function teardown() {
    await db.execute(sql`drop schema ${sql.identifier(namespace.schemaName)} cascade`);
    await client.end();
  }

  return {
    connectionString,
    client,
    db,
    engine,
    events,
    statements,
    ordersResource,
    scopedResource,
    orders,
    schema,
    schemaName: namespace.schemaName,
    relationsGraph: relations,
    setup,
    teardown,
  };
}

export function pageRequest(extra: Partial<QueryRequestInput> = {}): QueryRequestInput {
  return {
    pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "exact" },
    sorting: [{ key: "createdAt", dir: "desc" }],
    filters: [],
    search: { value: "", fields: [] },
    ...extra,
  };
}
