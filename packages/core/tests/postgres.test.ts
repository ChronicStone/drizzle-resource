import { randomUUID } from "node:crypto";
import { defineRelations, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, boolean, integer, pgSchema, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import type { QueryRequestInput } from "../index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const namespace = pgSchema(`resource_test_${randomUUID().replaceAll("-", "")}`);
const categories = namespace.table("categories", {
  id: integer().primaryKey(),
  name: text().notNull(),
});
const items = namespace.table("items", {
  id: integer().primaryKey(),
  tenant: text().notNull(),
  name: text().notNull(),
  rank: integer(),
  active: boolean().notNull(),
  categoryId: integer(),
});
const tags = namespace.table("tags", {
  id: integer().primaryKey(),
  itemId: integer().notNull(),
  label: text().notNull(),
});
const keys = namespace.table(
  "keys",
  {
    id: integer().primaryKey(),
    code: text().notNull(),
    region: text().notNull(),
    stable: text().notNull().unique(),
    indexed: text().notNull(),
    active: boolean().notNull(),
  },
  (table) => [
    unique().on(table.code, table.region),
    uniqueIndex().on(table.indexed),
    uniqueIndex()
      .on(table.code)
      .where(sql`${table.active}`),
  ],
);
const lookups = namespace.table("lookups", {
  id: integer().primaryKey(),
  code: text().notNull(),
  region: text().notNull(),
  stable: text().notNull(),
  indexed: text().notNull(),
});
const tokens = namespace.table("tokens", {
  id: bigint("token_id", { mode: "bigint" }).primaryKey(),
});
const schema = { items, categories, tags, keys, lookups, tokens };
const relations = defineRelations(schema, (r) => ({
  items: {
    category: r.one.categories({ from: r.items.categoryId, to: r.categories.id }),
    tags: r.many.tags({ from: r.items.id, to: r.tags.itemId }),
  },
  lookups: {
    composite: r.one.keys({
      from: [r.lookups.code, r.lookups.region],
      to: [r.keys.code, r.keys.region],
    }),
    byStable: r.one.keys({ from: r.lookups.stable, to: r.keys.stable }),
    byIndex: r.one.keys({ from: r.lookups.indexed, to: r.keys.indexed }),
    partial: r.one.keys({ from: r.lookups.code, to: r.keys.code }),
  },
}));
const client = new Pool({ connectionString, max: 4 });
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
const engine = createQueryEngine({ db, schema, relations });
const resource = engine.defineResource("items", {
  relations: { category: true, tags: true },
  query: {
    pagination: { modes: ["offset", "cursor"] },
    facets: { allowed: ["tenant", "rank", "active", "category.name", "tags.label"] },
    scope: (filters) => filters.is("tenant", "a"),
  },
});
const request: QueryRequestInput = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 2, count: "exact" },
  filters: [],
  search: { value: "", fields: [] },
  sorting: [{ key: "rank", dir: "asc" }],
};

describe.skipIf(!connectionString)("PostgreSQL query pipeline", () => {
  beforeAll(async () => {
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(sql`create table ${categories} (id integer primary key, name text not null)`);
    await db.execute(sql`create table ${items} (
      id integer primary key, tenant text not null, name text not null,
      rank integer, active boolean not null, "categoryId" integer
    )`);
    await db.execute(sql`create table ${tags} (
      id integer primary key, "itemId" integer not null, label text not null
    )`);
    await db.execute(sql`create table ${tokens} (token_id bigint primary key)`);
    await db.insert(tokens).values([{ id: 9007199254740993n }, { id: 9007199254740995n }]);
    await db.execute(sql`create table ${keys} (
      id integer primary key, code text not null, region text not null,
      stable text not null unique, indexed text not null, active boolean not null,
      unique (code, region)
    )`);
    await db.execute(sql`create unique index on ${keys} (indexed)`);
    await db.execute(sql`create unique index on ${keys} (code) where active`);
    await db.execute(sql`create table ${lookups} (
      id integer primary key, code text not null, region text not null,
      stable text not null, indexed text not null
    )`);
    await db.insert(keys).values([
      { id: 1, code: "same", region: "a", stable: "one", indexed: "one", active: true },
      { id: 2, code: "same", region: "b", stable: "two", indexed: "two", active: false },
    ]);
    await db.insert(lookups).values([
      { id: 1, code: "same", region: "a", stable: "one", indexed: "one" },
      { id: 2, code: "same", region: "b", stable: "two", indexed: "two" },
    ]);
    await db.insert(categories).values([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ]);
    await db.insert(items).values([
      { id: 1, tenant: "a", name: "One", rank: 1, active: true, categoryId: 1 },
      { id: 2, tenant: "a", name: "Two", rank: 1, active: true, categoryId: 1 },
      { id: 3, tenant: "a", name: "Three", rank: 2, active: false, categoryId: 2 },
      { id: 4, tenant: "a", name: "Four", rank: null, active: false, categoryId: null },
      { id: 5, tenant: "a", name: "Five", rank: null, active: true, categoryId: 2 },
      { id: 6, tenant: "b", name: "Private", rank: 3, active: true, categoryId: 1 },
    ]);
    await db.insert(tags).values([
      { id: 1, itemId: 1, label: "red" },
      { id: 2, itemId: 1, label: "red" },
      { id: 3, itemId: 1, label: "blue" },
      { id: 4, itemId: 2, label: "red" },
      { id: 5, itemId: 3, label: "blue" },
      { id: 6, itemId: 6, label: "secret" },
    ]);
    statements.length = 0;
  });

  afterAll(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
    await client.end();
  });

  it("never removes the access scope from an exclude-self facet", async () => {
    const result = await resource.queryFacets({ request, facets: [{ key: "tenant" }] });
    expect(result.facets[0]?.options).toEqual([{ value: "a", count: 5 }]);
  });

  it("counts scoped roots and returns stable offset pages including empty deep pages", async () => {
    const first = await resource.queryIds({ request });
    expect(first.ids).toEqual([1, 2]);
    expect(first.pageInfo).toMatchObject({ rowCount: 5, hasNextPage: true });
    const last = await resource.queryIds({
      request: {
        ...request,
        pagination: {
          mode: "offset",
          pageIndex: 3,
          pageSize: 2,
          count: "exact",
        },
      },
    });
    expect(last.ids).toEqual([5]);
    expect(last.pageInfo).toMatchObject({ rowCount: 5, hasNextPage: false });
    const empty = await resource.queryIds({
      request: {
        ...request,
        pagination: {
          mode: "offset",
          pageIndex: 9,
          pageSize: 2,
          count: "exact",
        },
      },
    });
    expect(empty.ids).toEqual([]);
    expect(empty.pageInfo).toMatchObject({ rowCount: 5, hasNextPage: false });
  });

  it.each(["asc", "desc"] as const)(
    "walks cursor pages with ties and nulls in %s order",
    async (dir) => {
      const ids: unknown[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result: Awaited<ReturnType<typeof resource.queryIds>> = await resource.queryIds({
          request: {
            ...request,
            sorting: [{ key: "rank", dir }],
            pagination: { mode: "cursor", pageSize: 2, count: "none", cursor },
          },
        });
        ids.push(...result.ids);
        expect(result.pageInfo.mode).toBe("cursor");
        if (result.pageInfo.mode !== "cursor") throw new Error("Expected cursor pagination");
        cursor = result.pageInfo.nextCursor;
        if (!cursor) break;
      }
      expect(ids).toEqual(dir === "asc" ? [1, 2, 3, 4, 5] : [5, 4, 3, 2, 1]);
    },
  );

  it("counts distinct roots for repeated many-relation values", async () => {
    const result = await resource.queryFacets({
      request,
      facets: [{ key: "tags.label", limit: 1 }],
    });
    expect(result.facets[0]).toEqual({
      key: "tags.label",
      options: [{ value: "blue", count: 2 }],
      nextCursor: "1",
      total: 2,
    });
    const next = await resource.queryFacets({
      request,
      facets: [{ key: "tags.label", limit: 1, cursor: "1" }],
    });
    expect(next.facets[0]?.options).toEqual([{ value: "red", count: 2 }]);
  });

  it("keeps exists filters independent of many-relation facet buckets", async () => {
    const result = await resource.queryFacets({
      request: {
        ...request,
        filters: [{ type: "condition", key: "tags.label", operator: "is", value: "red" }],
      },
      facets: [{ key: "tags.label", mode: "include-self" }],
    });
    expect(result.facets[0]?.options).toEqual([
      { value: "red", count: 2 },
      { value: "blue", count: 1 },
    ]);
  });
  it("batches compatible facets without changing types, ordering, totals or cursors", async () => {
    const requests: QueryRequestInput[] = [
      request,
      { ...request, filters: [{ type: "condition", key: "rank", operator: "is", value: 1 }] },
      {
        ...request,
        filters: [
          {
            type: "group",
            combinator: "or",
            children: [
              { type: "condition", key: "rank", operator: "is", value: 1 },
              { type: "condition", key: "active", operator: "is", value: false },
            ],
          },
        ],
      },
      { ...request, search: { value: "o", fields: ["name"] } },
      { ...request, search: { value: "a", fields: ["category.name"] } },
      { ...request, filters: [{ type: "condition", key: "id", operator: "is", value: -1 }] },
    ];
    for (const current of requests) {
      for (const mode of ["include-self", "exclude-self"] as const) {
        for (const cursor of [undefined, "1", "99"]) {
          const facets = (["rank", "active", "tenant", "category.name", "tags.label"] as const).map(
            (key) => ({ key, mode, limit: 1, cursor }),
          );
          const expected = await Promise.all(
            facets.map(
              async (facet) =>
                (await resource.queryFacets({ request: current, facets: [facet] })).facets[0],
            ),
          );
          const result = await resource.queryFacets({ request: current, facets });
          expect(result.facets).toEqual(expected);
        }
      }
    }
    expect(statements.some((query) => query.includes("grouping sets"))).toBe(true);
  });

  it("keeps duplicate facets and facet searches independent", async () => {
    const facets = [
      { key: "rank" as const, limit: 1 },
      { key: "active" as const, limit: 1 },
      { key: "rank" as const, limit: 1, cursor: "1" },
      { key: "rank" as const, search: "2" },
    ];
    const expected = await Promise.all(
      facets.map(
        async (facet) => (await resource.queryFacets({ request, facets: [facet] })).facets[0],
      ),
    );
    expect((await resource.queryFacets({ request, facets })).facets).toEqual(expected);
  });

  it("pages directly through unique-key joins without materializing matching IDs", async () => {
    const start = statements.length;
    const result = await resource.queryIds({
      request: {
        ...request,
        search: { value: "alpha", fields: ["category.name"] },
      },
    });
    expect(result.ids).toEqual([1, 2]);
    expect(result.pageInfo).toMatchObject({ rowCount: 2, hasNextPage: false });
    expect(statements.slice(start).join("\n")).not.toContain("matching_ids");
    expect(statements.slice(start).join("\n")).not.toContain("distinct");
  });

  it.each(["composite", "byStable", "byIndex"] as const)(
    "derives safe cardinality from the %s key",
    async (relation) => {
      const lookup = engine.defineResource("lookups", {
        relations: { composite: true, byStable: true, byIndex: true },
      });
      const start = statements.length;
      const result = await lookup.queryIds({
        request: {
          ...request,
          sorting: [],
          search: { value: "same", fields: [`${relation}.code`] },
        },
      });
      expect(result.ids).toEqual([1, 2]);
      expect(result.pageInfo).toMatchObject({ rowCount: 2 });
      expect(statements.slice(start).join("\n")).not.toContain("matching_ids");
    },
  );

  it("does not treat a partial unique index or a declared one relation as a uniqueness proof", async () => {
    const lookup = engine.defineResource("lookups", { relations: { partial: true } });
    const start = statements.length;
    const result = await lookup.queryIds({
      request: {
        ...request,
        sorting: [],
        search: { value: "same", fields: ["partial.code"] },
      },
    });
    expect(result.pageInfo).toMatchObject({ rowCount: 2 });
    expect(statements.slice(start).join("\n")).toContain("matching_ids");
  });

  it("hydrates only the selected roots in their stable page order", async () => {
    const result = await resource.query({ request });
    expect(result.rows.map(({ id }) => id)).toEqual([1, 2]);
    expect(result.rows[0]?.category?.name).toBe("Alpha");
    expect(result.rows[0]?.tags).toHaveLength(3);
    expect(result.rows[1]?.tags).toHaveLength(1);
  });

  it("keeps sort-only relation membership without joining it into aggregate rows", async () => {
    const sorted = { ...request, sorting: [{ key: "category.name", dir: "asc" as const }] };
    const start = statements.length;
    const result = await resource.queryIds({ request: sorted });
    expect(result.ids).toEqual([1, 2]);
    expect(result.pageInfo).toMatchObject({ rowCount: 4 });
    const facets = await resource.queryFacets({ request: sorted, facets: [{ key: "active" }] });
    expect(facets.facets[0]?.options).toEqual([
      { value: true, count: 3 },
      { value: false, count: 1 },
    ]);
    const aggregateQueries = statements.slice(start).filter((query) => query.includes("count("));
    expect(aggregateQueries).toHaveLength(2);
    for (const query of aggregateQueries) {
      expect(query).toContain("exists");
      expect(query).not.toContain("inner join");
    }
  });

  it("shares exact totals with compatible facets, including empty and out-of-range pages", async () => {
    for (const pageIndex of [1, 99]) {
      const start = statements.length;
      const result = await resource.query({
        request: {
          ...request,
          pagination: { ...request.pagination, mode: "offset", pageIndex },
          facets: [{ key: "active" }, { key: "tenant" }],
        },
      });
      expect(result.pageInfo).toMatchObject({ rowCount: 5 });
      expect(result.facets?.[1]?.options).toEqual([{ value: "a", count: 5 }]);
      const aggregates = statements.slice(start).filter((query) => query.includes("count("));
      expect(aggregates).toHaveLength(1);
      expect(aggregates[0]).toContain("grouping sets");
    }
    const empty = await resource.query({
      request: {
        ...request,
        filters: [{ type: "condition", key: "id", operator: "is", value: -1 }],
        facets: [{ key: "active" }],
      },
    });
    expect(empty.rows).toEqual([]);
    expect(empty.pageInfo).toMatchObject({ rowCount: 0 });
    expect(empty.facets?.[0]?.options).toEqual([]);
  });

  it("does not reuse exclude-self totals or relation-facet membership for page counts", async () => {
    const filtered = await resource.query({
      request: {
        ...request,
        filters: [{ type: "condition", key: "active", operator: "is", value: true }],
        facets: [{ key: "active" }],
      },
    });
    expect(filtered.pageInfo).toMatchObject({ rowCount: 3 });
    expect(filtered.facets?.[0]?.options).toEqual([
      { value: true, count: 3 },
      { value: false, count: 2 },
    ]);
    const related = await resource.query({
      request: { ...request, facets: [{ key: "category.name" }] },
    });
    expect(related.pageInfo).toMatchObject({ rowCount: 5 });
    expect(related.facets?.[0]?.options).toEqual([
      { value: "Alpha", count: 2 },
      { value: "Beta", count: 2 },
    ]);
  });

  it("scans a scoped ordered selection once with bounded hydration and one exact total", async () => {
    let scopeCalls = 0;
    const scanned = engine.defineResource("items", {
      relations: { category: true },
      query: {
        validation: { maxPageSize: 1 },
        scope: (filters) => {
          scopeCalls += 1;
          return filters.is("tenant", "a");
        },
      },
    });
    const start = statements.length;
    const ids = await scanned.scan({ request, batchSize: 2, count: "exact" }, async (batches) => {
      const result: number[] = [];
      for await (const batch of batches) {
        expect(batch.rows.length).toBeLessThanOrEqual(2);
        expect(batch.totalRows).toBe(5);
        result.push(...batch.rows.map(({ id }) => id));
      }
      return result;
    });
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(scopeCalls).toBe(1);
    const queries = statements.slice(start);
    expect(queries.filter((query) => query.startsWith("declare "))).toHaveLength(1);
    expect(queries.filter((query) => query.startsWith("fetch "))).toHaveLength(3);
    expect(queries.filter((query) => query.includes("count("))).toHaveLength(1);
    expect(queries.filter((query) => query.startsWith("close "))).toHaveLength(1);
    await expect(scanned.queryIds({ request })).rejects.toThrow("Page size cannot exceed 1");
  });

  it("decodes nonstandard ID columns without losing bigint precision", async () => {
    const tokenResource = engine.defineResource("tokens", {});
    const ids = await tokenResource.scan({ batchSize: 1 }, async (batches) => {
      const selected: bigint[] = [];
      for await (const batch of batches) selected.push(...batch.rows.map(({ id }) => id));
      return selected;
    });
    expect(ids).toEqual([9007199254740993n, 9007199254740995n]);
  });

  it("probes trigram indexes once and preserves cross-table substring results", async () => {
    const inputs = ["One", "AlPhA", "Three", "private", "not here", "%", "_", "a"];
    const expected = [];
    for (const value of inputs) {
      expected.push(
        await resource.queryIds({
          request: { ...request, search: { value, fields: ["name", "category.name"] } },
        }),
      );
    }
    await db.execute(sql`create extension if not exists pg_trgm`);
    await db.execute(sql`create index on ${items} using gin (lower(name) gin_trgm_ops)`);
    await db.execute(sql`create index on ${categories} using gin (lower(name) gin_trgm_ops)`);
    const indexedDb = drizzle({
      client,
      relations,
      logger: {
        logQuery(query) {
          statements.push(query);
        },
      },
    });
    const indexed = createQueryEngine({ db: indexedDb, schema, relations }).defineResource(
      "items",
      {
        relations: { category: true, tags: true },
        query: { scope: (filters) => filters.is("tenant", "a") },
      },
    );
    const start = statements.length;
    for (const [index, value] of inputs.entries()) {
      const before = statements.length;
      const result = await indexed.queryIds({
        request: { ...request, search: { value, fields: ["name", "category.name"] } },
      });
      expect(result).toEqual(expected[index]);
      expect(statements.slice(before).filter((query) => query.startsWith("explain"))).toHaveLength(
        /[\p{L}\p{N}]{3}/u.test(value) ? 2 : 0,
      );
    }
    const queries = statements.slice(start);
    expect(queries.filter((query) => query.includes("pg_catalog.pg_index"))).toHaveLength(2);
    expect(queries.filter((query) => query.includes(" union "))).not.toHaveLength(0);
    expect(queries.some((query) => query.includes('"categories"."id" in (select'))).toBe(false);
    for (const value of ["One", "Alpha", "Beta"]) {
      const filtered = {
        ...request,
        filters: [
          {
            type: "condition" as const,
            key: "category.name",
            operator: "is" as const,
            value: "Beta",
          },
        ],
        search: { value, fields: ["name", "category.name"] },
      };
      expect(await indexed.queryIds({ request: filtered })).toEqual(
        await resource.queryIds({ request: filtered }),
      );
    }
  });

  it("keeps scan membership and hydrated values consistent during concurrent updates", async () => {
    try {
      const names = await resource.scan({ request, batchSize: 2 }, async (batches) => {
        const result: string[] = [];
        for await (const batch of batches) {
          if (!result.length)
            await db.update(items).set({ name: "Changed", rank: 0 }).where(eq(items.id, 3));
          result.push(...batch.rows.map(({ name }) => name));
          expect(batch.totalRows).toBeUndefined();
        }
        return result;
      });
      expect(names).toEqual(["One", "Two", "Three", "Four", "Five"]);
    } finally {
      await db.update(items).set({ name: "Three", rank: 2 }).where(eq(items.id, 3));
    }
  });

  it("releases scans on early exit, consumer failure, abort and unused iterators", async () => {
    for (const mode of ["break", "throw", "abort", "unused"] as const) {
      const controller = new AbortController();
      const start = statements.length;
      const run = resource.scan(
        { request, batchSize: 1, signal: controller.signal },
        async (batches) => {
          if (mode === "unused") return;
          for await (const batch of batches) {
            expect(batch.rows).toHaveLength(1);
            if (mode === "break") break;
            if (mode === "throw") throw new Error("Writer failed");
            controller.abort(new Error("Export cancelled"));
          }
        },
      );
      const outcome = await run.then(
        () => null,
        (error: Error) => error.message,
      );
      expect(outcome).toBe(
        { break: null, throw: "Writer failed", abort: "Export cancelled", unused: null }[mode],
      );
      expect(statements.slice(start).filter((query) => query.startsWith("close "))).toHaveLength(1);
      expect(client.waitingCount).toBe(0);
      expect(client.idleCount).toBe(client.totalCount);
    }
  });

  it("accepts an existing snapshot transaction and does not escape its lifetime", async () => {
    await db.transaction(
      async (tx) => {
        const ids = await resource.scan({ request, db: tx, batchSize: 3 }, async (batches) => {
          const result: number[] = [];
          for await (const batch of batches) result.push(...batch.rows.map(({ id }) => id));
          return result;
        });
        expect(ids).toEqual([1, 2, 3, 4, 5]);
        expect(await tx.execute(sql`select 1 as alive`, "objects")).toEqual([{ alive: 1 }]);
      },
      { isolationLevel: "repeatable read" },
    );
    await db.transaction(async (tx) => {
      await expect(resource.scan({ db: tx }, async () => undefined)).rejects.toThrow(
        "repeatable-read",
      );
    });
  });

  it("scans empty selections and deduplicates unproven filter joins", async () => {
    let calls = 0;
    await resource.scan(
      { request: { filters: [{ type: "condition", key: "id", operator: "is", value: -1 }] } },
      async (batches) => {
        for await (const batch of batches) calls += batch.rows.length;
      },
    );
    expect(calls).toBe(0);
    const lookup = engine.defineResource("lookups", { relations: { partial: true } });
    const ids = await lookup.scan(
      { request: { search: { value: "same", fields: ["partial.code"] } }, batchSize: 1 },
      async (batches) => {
        const result: number[] = [];
        for await (const batch of batches) result.push(...batch.rows.map(({ id }) => id));
        return result;
      },
    );
    expect(ids).toEqual([1, 2]);
  });

  it("keeps optimized queries inside the per-call transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(items)
          .values({ id: 7, tenant: "a", name: "Uncommitted", rank: 4, active: true });
        const result = await resource.queryIds({ request, db: tx });
        expect(result.pageInfo).toMatchObject({ rowCount: 6 });
        const facets = await resource.queryFacets({
          request,
          db: tx,
          facets: [{ key: "active" }, { key: "tenant" }],
        });
        expect(facets.facets[1]?.options).toEqual([{ value: "a", count: 6 }]);
        expect((await resource.queryIds({ request })).pageInfo).toMatchObject({ rowCount: 5 });
        tx.rollback();
      }),
    ).rejects.toThrow("Rollback");
    expect((await resource.queryIds({ request })).pageInfo).toMatchObject({ rowCount: 5 });
  });
});
