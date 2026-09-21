import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, integer, pgSchema, text } from "drizzle-orm/pg-core";
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
const schema = { items, categories, tags };
const relations = defineRelations(schema, (r) => ({
  items: {
    category: r.one.categories({ from: r.items.categoryId, to: r.categories.id }),
    tags: r.many.tags({ from: r.items.id, to: r.tags.itemId }),
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
        const result = await resource.queryIds({
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
});
