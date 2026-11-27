import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import type {
  QueryCountMode,
  QueryFacetOutcome,
  QueryFacetResult,
  QueryPageInfo,
} from "../index.js";

// Compiles only while QueryFacetResult stays an interface.
interface LabelledFacet extends QueryFacetResult {
  label: string;
}

const docs = pgTable("docs", { id: integer().primaryKey(), org: text().notNull() });
const schema = { docs };
const relations = defineRelations(schema, () => ({}));
const engine = createQueryEngine({ db: drizzle.mock({ relations }), schema, relations });

describe("types that keep compiling", () => {
  it("accepts a strategy that forwards the built-in page", () => {
    const resource = engine.defineResource("docs", {
      query: { facets: { allowed: ["org"] } },
      strategy: {
        query: async ({ request, utils, relations: load }) =>
          utils.executeHydratedPage({ request, relations: load }),
      },
    });
    expect(resource.key).toBe("docs");
  });

  it("accepts facets written by hand without a status", () => {
    const facet: QueryFacetResult = { key: "org", options: [] };
    const skipped: QueryFacetResult = {
      key: "org",
      status: "skipped",
      reason: "above-cap",
      options: [],
    };
    expect(facet.status ?? "ok").toBe("ok");
    expectTypeOf<QueryFacetResult["status"]>().toEqualTypeOf<
      "ok" | "skipped" | "timeout" | undefined
    >();
    expect(skipped.status).toBe("skipped");
  });

  it("keeps QueryFacetResult extendable and narrows through QueryFacetOutcome", () => {
    const facet: LabelledFacet = { key: "org", options: [], label: "Org" };
    expect(facet.label).toBe("Org");
    const explain = (outcome: QueryFacetOutcome) =>
      outcome.status === "skipped" ? outcome.reason : (outcome.status ?? "ok");
    expect(explain({ key: "org", options: [], status: "skipped", reason: "above-cap" })).toBe(
      "above-cap",
    );
  });

  it("narrows rowCount and the capped flag on pageInfo.count", () => {
    const label = (info: QueryPageInfo) => {
      switch (info.count) {
        case "none":
          return info.reason ?? "none";
        case "exact":
          return String(info.rowCount);
        case "capped":
          return info.exact ? String(info.rowCount) : `${info.rowCount}+`;
        case "estimated":
          return `about ${info.rowCount}`;
      }
    };
    expect(
      label({
        mode: "offset",
        pageIndex: 1,
        pageSize: 5,
        hasNextPage: false,
        count: "capped",
        rowCount: 10,
        exact: false,
      }),
    ).toBe("10+");
  });

  it("types scan's count as any count mode and rejects the ones it cannot report", async () => {
    const resource = engine.defineResource("docs", {});
    const mode = "capped" as QueryCountMode;
    await expect(resource.scan({ count: mode }, async () => undefined)).rejects.toThrow(
      "exact total or none",
    );
  });
});
