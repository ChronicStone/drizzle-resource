import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, integer, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import type { QueryFacetRequest, QueryRequestInput } from "../index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const namespace = pgSchema(`resource_split_${randomUUID().replaceAll("-", "")}`);
const owners = namespace.table("owners", { id: integer().primaryKey(), name: text().notNull() });
const mkEvents = (name: string) =>
  namespace.table(name, {
    id: integer().primaryKey(),
    kind: text().notNull(),
    region: text().notNull(),
    flag: boolean().notNull(),
    org: integer().notNull(),
    ownerId: integer().notNull(),
  });
// `events` is big and analyzed, `fresh` is big and never analyzed, `tiny` is small and analyzed.
const events = mkEvents("events");
const fresh = mkEvents("fresh");
const tiny = mkEvents("tiny");
const schema = { owners, events, fresh, tiny };
const relations = defineRelations(schema, (r) => ({
  events: { owner: r.one.owners({ from: r.events.ownerId, to: r.owners.id }) },
  fresh: { owner: r.one.owners({ from: r.fresh.ownerId, to: r.owners.id }) },
  tiny: { owner: r.one.owners({ from: r.tiny.ownerId, to: r.owners.id }) },
}));

const client = new Pool({ connectionString, max: 8 });
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
// Statements on the wire at the same time, per connection and in all.
const overlap = {
  total: 0,
  peak: 0,
  perClient: new Map<object, { active: number; peak: number }>(),
};
client.on("connect", (connection) => {
  const query = connection.query.bind(connection) as (...args: unknown[]) => unknown;
  const own = { active: 0, peak: 0 };
  overlap.perClient.set(connection, own);
  const start = () => {
    own.active += 1;
    overlap.total += 1;
    own.peak = Math.max(own.peak, own.active);
    overlap.peak = Math.max(overlap.peak, overlap.total);
  };
  const done = () => {
    own.active -= 1;
    overlap.total -= 1;
  };
  (connection as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const last = args.at(-1);
    start();
    if (typeof last === "function") {
      // `pool.query` hands its statement to the connection with a callback.
      args[args.length - 1] = (...results: unknown[]) => {
        done();
        return (last as (...values: unknown[]) => unknown)(...results);
      };
      return query(...args);
    }
    const pending = query(...args) as PromiseLike<unknown>;
    pending.then(done, done);
    return pending;
  };
});

const engine = createQueryEngine({ db, schema, relations });
const allowed = ["kind", "region", "flag", "org", "owner.name"] as const;
const auto = engine.defineResource("events", {
  relations: { owner: true },
  query: { pagination: { modes: ["offset"] }, facets: { allowed: [...allowed] } },
});
/** The same resource with other facet and timeout settings, on `events`, `fresh` or `tiny`. */
function define(
  key: "events" | "fresh" | "tiny",
  facets: { splitAbove?: number; whenCapped?: "skip" | "run" } = {},
  query: { countCap?: number; timeouts?: { facets?: number } } = {},
): typeof auto {
  return engine.defineResource(
    key as "events",
    {
      relations: { owner: true },
      query: {
        pagination: { modes: ["offset"], countCap: query.countCap },
        facets: { allowed: [...allowed], ...facets },
        ...(query.timeouts ? { timeouts: query.timeouts } : {}),
      },
    } as never,
  ) as unknown as typeof auto;
}
const grouped = define("events", { splitAbove: Infinity });
const separate = define("events", { splitAbove: 0 });
const autoFresh = define("fresh");
const autoTiny = define("tiny");
const skipping = define("events", { splitAbove: 0, whenCapped: "skip" }, { countCap: 10 });
const skippingGrouped = define(
  "events",
  { splitAbove: Infinity, whenCapped: "skip" },
  { countCap: 10 },
);
const timed = define("events", { splitAbove: 0 }, { timeouts: { facets: 150 } });

function request(extra: Partial<QueryRequestInput> = {}, count = "exact"): QueryRequestInput {
  return {
    pagination: { mode: "offset", pageIndex: 1, pageSize: 5, count } as never,
    filters: [],
    search: { value: "", fields: [] },
    sorting: [{ key: "id", dir: "asc" }],
    ...extra,
  };
}
const facets: QueryFacetRequest[] = [
  { key: "kind" },
  { key: "region", limit: 2 },
  { key: "flag", missing: true },
  { key: "owner.name", limit: 3 },
];
const sharedStatement = (start: number) =>
  statements.slice(start).some((query) => query.includes("grouping sets"));
const probes = (start: number) =>
  statements.slice(start).filter((query) => query.includes("reltuples")).length;
const explains = (start: number) =>
  statements.slice(start).filter((query) => query.startsWith("explain")).length;

describe.skipIf(!connectionString)("facets split into statements", () => {
  beforeAll(async () => {
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(sql`create table ${owners} (id integer primary key, name text not null)`);
    await db.execute(
      sql`insert into ${owners} select n, 'owner ' || (n % 7) from generate_series(1, 50) n`,
    );
    for (const [table, rows] of [
      [events, 150_000],
      [fresh, 150_000],
      [tiny, 100],
    ] as const) {
      await db.execute(sql`create table ${table} (
        id integer primary key, kind text not null, region text not null, flag boolean not null,
        org integer not null, "ownerId" integer not null
      ) with (autovacuum_enabled = false)`);
      await db.execute(sql`
        insert into ${table}
        select n, (array['a','b','c','d','e'])[1 + n % 5], (array['eu','us','apac'])[1 + n % 3],
          n % 2 = 0, n % 100, 1 + n % 50
        from generate_series(1, ${rows}::int) n
      `);
    }
    await db.execute(sql`analyze ${events}`);
    await db.execute(sql`analyze ${tiny}`);
  }, 120_000);

  afterAll(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
    await client.end();
  });

  it("splits the facets of a big table, with the exact count as a statement of its own", async () => {
    const start = statements.length;
    const result = await auto.query({ request: request({ facets }) });
    const sent = statements.slice(start);
    expect(sharedStatement(start)).toBe(false);
    expect(sent.filter((query) => /^select count\(\*\)/.test(query))).toHaveLength(1);
    expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 150_000 });
    expect(probes(start)).toBe(1);
    const before = statements.length;
    const shared = await grouped.query({ request: request({ facets }) });
    expect(sharedStatement(before)).toBe(true);
    expect(result).toEqual(shared);
  });

  it("reads the table's row estimate once and reuses it", async () => {
    const start = statements.length;
    await auto.queryFacets({ request: request(), facets });
    await auto.queryFacets({ request: request(), facets });
    expect(probes(start)).toBe(0);
    expect(sharedStatement(start)).toBe(false);
  });

  it("keeps one shared statement when the request narrows the table to a few rows", async () => {
    const narrow = request({
      filters: [{ type: "condition", key: "org", operator: "is", value: 7 }],
    });
    const start = statements.length;
    const result = await auto.query({ request: { ...narrow, facets } });
    expect(sharedStatement(start)).toBe(true);
    // The planner's estimate of the matching rows decided it.
    expect(explains(start)).toBe(1);
    expect(result).toEqual(await separate.query({ request: { ...narrow, facets } }));
  });

  it("splits a wide request on a big table without an extra estimate", async () => {
    const wide = request({
      filters: [{ type: "condition", key: "org", operator: "lt", value: 90 }],
    });
    const start = statements.length;
    const result = await auto.query({ request: { ...wide, facets } });
    expect(sharedStatement(start)).toBe(false);
    expect(explains(start)).toBe(1);
    expect(result).toEqual(await grouped.query({ request: { ...wide, facets } }));
  });

  it("shares one statement when PostgreSQL has no estimate or the table is small", async () => {
    let start = statements.length;
    await autoFresh.queryFacets({ request: request(), facets });
    expect(sharedStatement(start)).toBe(true);
    expect(probes(start)).toBe(1);
    start = statements.length;
    await autoFresh.queryFacets({ request: request(), facets });
    expect(probes(start)).toBe(0);
    start = statements.length;
    await autoTiny.queryFacets({ request: request(), facets });
    expect(sharedStatement(start)).toBe(true);
    expect(explains(start)).toBe(0);
  });

  it("never asks for an estimate when the setting decides", async () => {
    const start = statements.length;
    await separate.queryFacets({ request: request(), facets });
    await grouped.queryFacets({ request: request(), facets });
    expect(probes(start)).toBe(0);
  });

  it("runs at most four statements at a time, on several connections", async () => {
    overlap.peak = 0;
    const many: QueryFacetRequest[] = [
      { key: "kind" },
      { key: "kind", limit: 2 },
      { key: "region" },
      { key: "region", limit: 1 },
      { key: "flag" },
      { key: "org", limit: 5 },
      { key: "owner.name" },
    ];
    const result = await separate.query({ request: request({ facets: many }) });
    expect(result.facets).toHaveLength(many.length);
    expect(overlap.peak).toBeGreaterThanOrEqual(2);
    expect(overlap.peak).toBeLessThanOrEqual(4);
  });

  it("runs the statements one after the other in a caller's transaction", async () => {
    const outside = await separate.query({ request: request({ facets }) });
    await db.transaction(async (tx) => {
      for (const peak of overlap.perClient.values()) peak.peak = 0;
      const inside = await separate.query({ db: tx as never, request: request({ facets }) });
      expect(inside).toEqual(outside);
      const peaks = [...overlap.perClient.values()].map((entry) => entry.peak);
      expect(Math.max(...peaks)).toBe(1);
    });
  });

  it("shares the row estimate with the transactions of callers", async () => {
    const start = statements.length;
    for (let round = 0; round < 2; round++) {
      await db.transaction(async (tx) => {
        await auto.queryFacets({ db: tx as never, request: request(), facets });
      });
    }
    expect(probes(start)).toBe(0);
  });

  it("times out one facet and keeps the others", async () => {
    const locker = await client.connect();
    await locker.query("begin");
    await locker.query(`lock table "${namespace.schemaName}"."owners" in access exclusive mode`);
    try {
      const result = await timed.queryFacets({
        request: request(),
        facets: [{ key: "kind" }, { key: "owner.name" }, { key: "region" }],
      });
      expect(result.facets.map(({ key, status }) => [key, status])).toEqual([
        ["kind", "ok"],
        ["owner.name", "timeout"],
        ["region", "ok"],
      ]);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  });

  it("skips split facets above the cap and runs them below it", async () => {
    const above = await skipping.query({
      request: request({ facets }, "capped"),
    });
    expect(above.facets?.map((facet) => facet.status)).toEqual(facets.map(() => "skipped"));
    const few = request(
      {
        facets,
        filters: [{ type: "condition", key: "id", operator: "lt", value: 6 }],
      },
      "capped",
    );
    const result = await skipping.query({ request: few });
    expect(result.facets?.map((facet) => facet.status)).toEqual(facets.map(() => "ok"));
    expect(result).toEqual(await skippingGrouped.query({ request: few }));
  });

  it("rejects a split threshold that is not a number of rows", () => {
    for (const splitAbove of [-1, Number.NaN, "100" as never]) {
      expect(() => define("events", { splitAbove })).toThrow(/splitAbove/);
    }
    expect(() => define("events", { splitAbove: 0 })).not.toThrow();
    expect(() => define("events", { splitAbove: Infinity })).not.toThrow();
  });
});
