import {
  avg,
  avgDistinct,
  count,
  countDistinct,
  defineRelations,
  max,
  min,
  sql,
  sum,
  sumDistinct,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, numeric, pgTable, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { z } from "zod";
import { createQueryEngine, virtual } from "../../core/index.js";
import { responseSchema } from "../index.js";

const items = pgTable("summary_items", {
  id: integer().primaryKey(),
  amount: numeric().notNull(),
  createdAt: timestamp().notNull(),
});
const schema = { items };
const relations = defineRelations(schema);
const db = drizzle({ connection: "postgres://localhost/unused", relations });
const engine = createQueryEngine({
  db,
  schema,
  relations,
  models: {
    items: {
      hidden: ["createdAt"],
      virtual: (item) => ({ double: virtual.number(sql`${item.amount} * 2`) }),
    },
  },
});
const resource = engine.defineResource("items", {
  views: { list: { select: { id: true, double: true } } },
  summary: (item) => ({
    rows: count(),
    distinctRows: countDistinct(item.id),
    total: sum(item.amount),
    distinctTotal: sumDistinct(item.amount),
    average: avg(item.amount),
    distinctAverage: avgDistinct(item.amount),
    earliest: min(item.createdAt),
    latest: max(item.createdAt),
    smallestId: min(item.id),
    maximumAmount: max(item.amount),
    numericTotal: sum(item.amount).mapWith(Number),
    alias: count().as("item_count"),
    virtualTotal: sum(item.double),
  }),
});
const pageInfo = {
  mode: "offset",
  pageIndex: 1,
  pageSize: 25,
  hasNextPage: false,
  count: "exact",
  rowCount: 0,
};
const emptySummary = {
  rows: 0,
  distinctRows: 0,
  total: null,
  distinctTotal: null,
  average: null,
  distinctAverage: null,
  earliest: null,
  latest: null,
  smallestId: null,
  maximumAmount: null,
  numericTotal: null,
  alias: 0,
  virtualTotal: null,
};

describe("automatic summary response schemas", () => {
  it("infers aggregate validators and their output without repeating the summary", () => {
    const validator = responseSchema(resource, { view: "list", summary: true });
    type Output = z.output<typeof validator>;
    expectTypeOf<Output["summary"]>().toEqualTypeOf<typeof resource.$infer.summary>();
    expectTypeOf<Output["rows"][number]>().toEqualTypeOf<{ id: number; double: number }>();
    const payload = { rows: [], pageInfo, summary: emptySummary };
    expect(validator.parse(payload)).toEqual(payload);
    const populated = {
      ...payload,
      summary: {
        ...emptySummary,
        rows: 2,
        distinctRows: 2,
        total: "9007199254740993.123456",
        earliest: new Date("2026-01-01Z"),
        latest: new Date("2026-01-02Z"),
        smallestId: 1,
        maximumAmount: "12.34",
        numericTotal: 42,
      },
    };
    expect(validator.parse(populated)).toEqual(populated);
    for (const invalid of [
      { rows: null },
      { total: 42 },
      { earliest: "2026-01-01" },
      { smallestId: "1" },
    ]) {
      expect(() =>
        validator.parse({ ...payload, summary: { ...emptySummary, ...invalid } }),
      ).toThrow(/expected|Expected/);
    }
  });

  it("supports default rows and keeps unrequested summaries out of the result type", () => {
    const validator = responseSchema(resource, { summary: true });
    expect(validator.parse({ rows: [], pageInfo, summary: emptySummary })).toEqual({
      rows: [],
      pageInfo,
      summary: emptySummary,
    });
    const without = responseSchema(resource, { view: "list", summary: false });
    type Without = z.output<typeof without>;
    expectTypeOf<Without>().not.toHaveProperty("summary");
    expect(without.parse({ rows: [], pageInfo })).toEqual({ rows: [], pageInfo });
    const noSummary = engine.defineResource("items", {});
    expect(() => {
      // @ts-expect-error this resource declares no summary
      responseSchema(noSummary, { summary: true });
    }).toThrow("No summary");
  });

  it("requires an explicit override for opaque SQL instead of guessing its runtime type", () => {
    const custom = engine.defineResource("items", {
      summary: () => ({ value: sql<number>`coalesce(sum(1), 0)`.mapWith(Number) }),
    });
    expect(() => responseSchema(custom, { summary: true })).toThrow('summary field "value"');
    const validator = responseSchema(custom, { summary: z.object({ value: z.number() }) });
    expect(validator.parse({ rows: [], pageInfo, summary: { value: 0 } })).toEqual({
      rows: [],
      pageInfo,
      summary: { value: 0 },
    });
  });
});
