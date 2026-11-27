import { drizzle } from "drizzle-orm/node-postgres";
import { defineRelations } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import { createQueryEngine } from "../../core/index.js";

import { requestSchema, responseSchema } from "../index.js";

const orders = pgTable("orders", {
  id: uuid().primaryKey(),
  reference: varchar({ length: 255 }).notNull(),
});
const schema = { orders };
const relations = defineRelations(schema);
const resource = createQueryEngine({
  db: drizzle({ connection: "postgres://localhost/unused", relations }),
  schema,
  relations,
}).defineResource("orders", {
  query: {
    pagination: { modes: ["offset", "cursor"] },
    validation: { maxPageIndex: 20 },
  },
});

function page(pagination: Record<string, unknown>) {
  return { pagination: { pageSize: 10, ...pagination } };
}

describe("Zod count modes and page limits", () => {
  it.each(["none", "exact", "capped", "estimated"])("accepts count %s", (count) => {
    const request = requestSchema(resource);
    expect(request.parse(page({ pageIndex: 1, count })).pagination.count).toBe(count);
    expect(
      request.parse({ pagination: { mode: "cursor", pageSize: 5, count } }).pagination.count,
    ).toBe(count);
  });

  it("rejects an unknown count mode", () => {
    expect(requestSchema(resource).safeParse(page({ count: "approx" })).success).toBe(false);
  });

  it("enforces maxPageIndex and lets an override only narrow it", () => {
    const request = requestSchema(resource);
    expect(request.safeParse(page({ pageIndex: 20 })).success).toBe(true);
    expect(request.safeParse(page({ pageIndex: 21 })).success).toBe(false);
    const narrowed = requestSchema(resource, { limits: { maxPageIndex: 5 } });
    expect(narrowed.safeParse(page({ pageIndex: 5 })).success).toBe(true);
    expect(narrowed.safeParse(page({ pageIndex: 6 })).success).toBe(false);
    const widened = requestSchema(resource, { limits: { maxPageIndex: 500 } });
    expect(widened.safeParse(page({ pageIndex: 21 })).success).toBe(false);
  });

  it("leaves the page index unlimited by default", () => {
    const open = createQueryEngine({
      db: drizzle({ connection: "postgres://localhost/unused", relations }),
      schema,
      relations,
    }).defineResource("orders", { query: {} });
    expect(requestSchema(open).safeParse(page({ pageIndex: 1_000_000 })).success).toBe(true);
  });

  it("validates every pageInfo count variant and the new facet and summary fields, with status optional", () => {
    const response = responseSchema(resource);
    const base = { mode: "offset", pageIndex: 1, pageSize: 10, hasNextPage: true };
    for (const count of [
      { count: "none", rowCount: null },
      { count: "none", rowCount: null, reason: "timeout" },
      { count: "exact", rowCount: 4 },
      { count: "capped", rowCount: 10_000, exact: false },
      { count: "estimated", rowCount: 8_549_540 },
    ]) {
      expect(response.safeParse({ rows: [], pageInfo: { ...base, ...count } }).success).toBe(true);
    }
    expect(
      response.safeParse({ rows: [], pageInfo: { ...base, count: "capped", rowCount: 3 } }).success,
    ).toBe(false);
    expect(
      response.safeParse({
        rows: [],
        pageInfo: {
          mode: "cursor",
          pageSize: 10,
          nextCursor: null,
          count: "capped",
          rowCount: 1,
          exact: true,
        },
        facets: [
          { key: "status", status: "skipped", reason: "above-cap", options: [] },
          { key: "kind", status: "timeout", options: [] },
          { key: "org", status: "ok", options: [{ value: "a", count: 1 }] },
        ],
      }).success,
    ).toBe(true);
    expect(
      response.safeParse({
        rows: [],
        pageInfo: { ...base, count: "none", rowCount: null },
        facets: [{ key: "status", options: [] }],
      }).success,
    ).toBe(true);
  });
});
