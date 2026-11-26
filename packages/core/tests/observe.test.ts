import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createQueryEngine, formatExplain } from "../index.js";
import type { ExplainPlanNode, ExplainReport, QueryEvent, QueryRequest } from "../index.js";
import { analyzePlan } from "../src/explain.js";
import type { AnalysisInput } from "../src/explain.js";
import { createStatementObserver, describeRequestShape } from "../src/observe.js";

function request(extra: Partial<QueryRequest> = {}): QueryRequest {
  return {
    context: {},
    pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "exact" },
    sorting: [{ key: "createdAt", dir: "desc" }],
    filters: [],
    search: { value: "", fields: [] },
    ...extra,
  };
}

describe("request shape", () => {
  it("names filters, sorts, search, facets, pagination and count without any value", () => {
    const { shape, key } = describeRequestShape(
      "orders",
      request({
        filters: [
          { type: "condition", key: "status", operator: "is", value: "paid" },
          { type: "condition", key: "createdAt", operator: "between", value: { from: 1, to: 2 } },
        ],
        sorting: [
          { key: "createdAt", dir: "desc" },
          { key: "id", dir: "desc" },
        ],
        search: { value: "acme", fields: ["customer.name", "reference"] },
        facets: [{ key: "status", mode: "exclude-self" }],
      }),
    );
    expect(shape).toBe(
      "orders · filter createdAt:between,status:is · sort createdAt desc · search customer.name,reference · facets status:exclude-self · offset · count exact",
    );
    expect(key).toEqual({
      resource: "orders",
      filters: ["createdAt:between", "status:is"],
      sorting: ["createdAt desc"],
      search: ["customer.name", "reference"],
      facets: ["status:exclude-self"],
      pagination: "offset",
      count: "exact",
    });
  });

  it("is the same for different values, filter order, page index and facet order", () => {
    const first = describeRequestShape(
      "orders",
      request({
        filters: [
          { type: "condition", key: "status", operator: "is", value: "paid" },
          { type: "condition", key: "region", operator: "isAnyOf", value: ["eu"] },
        ],
        pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "exact" },
        search: { value: "alpha", fields: ["reference"] },
        facets: [{ key: "status" }, { key: "region", limit: 5 }],
      }),
    ).shape;
    const second = describeRequestShape(
      "orders",
      request({
        filters: [
          { type: "condition", key: "region", operator: "isAnyOf", value: ["us", "eu", "apac"] },
          { type: "condition", key: "status", operator: "is", value: "SECRET" },
        ],
        pagination: { mode: "offset", pageIndex: 900, pageSize: 100, count: "exact" },
        search: { value: "something else", fields: ["reference"] },
        facets: [{ key: "region" }, { key: "status", limit: 50 }],
      }),
    ).shape;
    expect(second).toBe(first);
    expect(first).not.toContain("SECRET");
  });

  it("differs when the structure differs", () => {
    const base = describeRequestShape("orders", request()).shape;
    const operator = describeRequestShape(
      "orders",
      request({ filters: [{ type: "condition", key: "status", operator: "is", value: 1 }] }),
    ).shape;
    const other = describeRequestShape(
      "orders",
      request({ filters: [{ type: "condition", key: "status", operator: "isNot", value: 1 }] }),
    ).shape;
    const cursor = describeRequestShape(
      "orders",
      request({ pagination: { mode: "cursor", cursor: null, pageSize: 25, count: "none" } }),
    ).shape;
    expect(new Set([base, operator, other, cursor]).size).toBe(4);
  });

  it("reads an or group differently from separate filters and ignores an empty search", () => {
    const group = describeRequestShape(
      "orders",
      request({
        filters: [
          {
            type: "group",
            combinator: "or",
            children: [
              { type: "condition", key: "a", operator: "is", value: 1 },
              { type: "condition", key: "b", operator: "is", value: 1 },
            ],
          },
        ],
        search: { value: "", fields: ["reference"] },
      }),
    ).shape;
    expect(group).toBe("orders · filter (a:is|b:is) · sort createdAt desc · offset · count exact");
  });

  it("drops the id tie-breaker only when it follows the same direction", () => {
    const same = describeRequestShape(
      "orders",
      request({
        sorting: [
          { key: "createdAt", dir: "desc" },
          { key: "id", dir: "desc" },
        ],
      }),
    ).shape;
    const mixed = describeRequestShape(
      "orders",
      request({
        sorting: [
          { key: "createdAt", dir: "desc" },
          { key: "id", dir: "asc" },
        ],
      }),
    ).shape;
    expect(same).toContain("sort createdAt desc ·");
    expect(mixed).toContain("sort createdAt desc, id asc ·");
  });
});

describe("statement observer", () => {
  const query = Object.assign(Promise.resolve([{ id: 1 }]), { toSQL: () => ({ sql: "select 1" }) });

  it("hands the query straight back when nobody observes it", () => {
    const observer = createStatementObserver("orders", [undefined]);
    expect(observer.active).toBe(false);
    expect(observer.run("ids", undefined, query)).toBe(query);
  });

  it("emits one event per statement and survives a hook that throws or rejects", async () => {
    const events: QueryEvent[] = [];
    const observer = createStatementObserver("orders", [
      () => {
        throw new Error("sync hook");
      },
      async () => {
        throw new Error("async hook");
      },
      (event) => {
        events.push(event);
      },
    ]);
    const rows = await observer.run("ids", request(), query);
    expect(rows).toEqual([{ id: 1 }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resource: "orders", stage: "ids", rows: 1, sql: "select 1" });
    expect(events[0]!.shape).toContain("orders · sort createdAt desc");
    expect(events[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it("reports a failing statement and rethrows it", async () => {
    const events: QueryEvent[] = [];
    const failure = new Error("boom");
    const failing = Object.assign(Promise.reject(failure), { toSQL: () => ({ sql: "select 2" }) });
    const observer = createStatementObserver("orders", [(event) => void events.push(event)]);
    await expect(observer.run("count", request(), failing)).rejects.toBe(failure);
    expect(events[0]).toMatchObject({ stage: "count", rows: 0, error: failure });
  });
});

function plan(node: ExplainPlanNode): ExplainPlanNode {
  return node;
}

function input(
  extra: Partial<AnalysisInput> & Pick<AnalysisInput, "plan" | "stage">,
): AnalysisInput {
  return {
    analyzed: true,
    tables: new Map([["public.orders", 1_000_000]]),
    countCap: 10_000,
    root: "orders",
    pagination: { mode: "offset", offset: 0, pageSize: 25, pageIndex: 1 },
    allowsCursor: true,
    hasSearch: false,
    relationSorts: [],
    groupingSets: false,
    ...extra,
  };
}

describe("plan analysis", () => {
  it("warns about an exact count that reads every matching row", () => {
    const analysis = analyzePlan(
      input({
        stage: "count",
        plan: plan({
          "Node Type": "Aggregate",
          "Actual Rows": 1,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              "Actual Rows": 9_412_330,
              "Actual Loops": 1,
            },
          ],
        }),
      }),
    );
    expect(analysis.warnings.map((warning) => warning.code)).toEqual(["full-count"]);
    expect(analysis.warnings[0]).toMatchObject({
      message: "reads 9,412,330 rows to return one number",
      fix: 'count: "capped" stops after 10,001 rows and shows "10,000+" instead',
      basis: "measured",
    });
    expect(analysis.rowsRead).toBe(9_412_330);
  });

  it("does not warn about a capped count or a count under the cap", () => {
    const capped = analyzePlan(
      input({
        stage: "count",
        plan: plan({
          "Node Type": "Aggregate",
          "Actual Rows": 1,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Limit",
              "Actual Rows": 10_001,
              "Actual Loops": 1,
              Plans: [
                {
                  "Node Type": "Seq Scan",
                  "Relation Name": "orders",
                  "Actual Rows": 10_001,
                  "Actual Loops": 1,
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(capped.warnings).toEqual([]);
  });

  it("finds an index walk, and the misestimate the walk implies", () => {
    const analysis = analyzePlan(
      input({
        stage: "ids",
        plan: plan({
          "Node Type": "Limit",
          "Plan Rows": 25,
          "Actual Rows": 25,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Index Name": "orders_created_idx",
              "Relation Name": "orders",
              Filter: "(lower(reference) ~~ '%x%'::text)",
              "Plan Rows": 5_000_000,
              "Actual Rows": 25,
              "Actual Loops": 1,
              "Rows Removed by Filter": 9_999_000,
            },
          ],
        }),
        tables: new Map([["public.orders", 10_000_000]]),
      }),
    );
    const codes = analysis.warnings.map((warning) => warning.code);
    expect(codes).toContain("index-walk");
    expect(codes).toContain("misestimate");
    const walk = analysis.warnings.find((warning) => warning.code === "index-walk")!;
    expect(walk.message).toBe(
      "walks 9,999,025 rows of orders_created_idx to find 25 matching rows: the filter is checked row by row after the index",
    );
    const estimate = analysis.warnings.find((warning) => warning.code === "misestimate")!;
    expect(estimate.message).toContain("expected 5,000,000 matching rows in orders");
    expect(estimate.message).toContain("imply about 25");
  });

  it("expects an index walk from the planner's own numbers when nothing ran", () => {
    const analysis = analyzePlan(
      input({
        stage: "ids",
        analyzed: false,
        plan: plan({
          "Node Type": "Limit",
          "Plan Rows": 25,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Index Name": "orders_created_idx",
              "Relation Name": "orders",
              Filter: "(status = 'x'::text)",
              "Plan Rows": 1_000,
            },
          ],
        }),
      }),
    );
    expect(analysis.warnings).toHaveLength(1);
    expect(analysis.warnings[0]).toMatchObject({ code: "index-walk", basis: "estimated" });
    expect(analysis.warnings[0]!.message).toBe(
      "expects to walk about 25,000 rows of orders_created_idx to find 25 matching rows: the filter is checked row by row after the index",
    );
  });

  it("does not call a filtered index scan that finds its rows quickly a walk", () => {
    const analysis = analyzePlan(
      input({
        stage: "ids",
        plan: plan({
          "Node Type": "Limit",
          "Plan Rows": 25,
          "Actual Rows": 25,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Index Name": "orders_created_idx",
              "Relation Name": "orders",
              Filter: "(status = 'x'::text)",
              "Plan Rows": 500_000,
              "Actual Rows": 25,
              "Actual Loops": 1,
              "Rows Removed by Filter": 40,
            },
          ],
        }),
      }),
    );
    expect(analysis.warnings).toEqual([]);
    expect(analysis.summary).toBe("index orders_created_idx, 65 rows read");
  });

  it("reports a deep offset from the request and a relation sort from the resource", () => {
    const analysis = analyzePlan(
      input({
        stage: "ids",
        analyzed: false,
        plan: plan({
          "Node Type": "Limit",
          "Plan Rows": 25,
          Plans: [{ "Node Type": "Sort", "Plan Rows": 800_000, Plans: [] }],
        }),
        pagination: { mode: "offset", offset: 199_975, pageSize: 25, pageIndex: 8_000 },
        allowsCursor: false,
        relationSorts: ["customer.name"],
      }),
    );
    expect(analysis.warnings.map((warning) => warning.code)).toEqual([
      "relation-sort",
      "deep-offset",
    ]);
    expect(analysis.warnings[0]!.message).toBe(
      "sorting by customer.name joins every matching row of orders to the related table before it can sort (about 800,000 rows sorted)",
    );
    expect(analysis.warnings[1]!.message).toBe(
      "page 8,000 skips 199,975 rows to return 25: PostgreSQL reads and discards every row before the page",
    );
    expect(analysis.warnings[1]!.fix).toContain("allow cursor pagination");
  });

  it("finds a seq scan whose filter keeps almost nothing, but not one that keeps most rows", () => {
    const scan = (kept: number) =>
      plan({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Filter: "(amount = 1)",
        "Actual Rows": kept,
        "Actual Loops": 1,
        "Rows Removed by Filter": 500_000 - kept,
      });
    expect(
      analyzePlan(input({ stage: "ids", plan: scan(3) })).warnings.map(({ code }) => code),
    ).toEqual(["seq-scan"]);
    expect(analyzePlan(input({ stage: "ids", plan: scan(400_000) })).warnings).toEqual([]);
  });

  it("flags facets that share a GROUPING SETS statement, unless it aggregates in parallel", () => {
    const scan = {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      "Actual Rows": 5_000_000,
      "Actual Loops": 1,
    };
    const single = analyzePlan(
      input({
        stage: "facets",
        plan: plan({ "Node Type": "Aggregate", Plans: [scan] }),
        groupingSets: true,
        facets: ["status", "region", "country"],
      }),
    );
    expect(single.warnings[0]!.message).toBe(
      "3 facets (status, region, country) share one GROUPING SETS statement, which PostgreSQL runs on one CPU while it reads 5,000,000 rows",
    );
    const parallel = analyzePlan(
      input({
        stage: "facets",
        plan: plan({
          "Node Type": "Aggregate",
          "Partial Mode": "Partial",
          Plans: [scan],
        }),
        groupingSets: true,
        facets: ["status", "region"],
      }),
    );
    expect(parallel.warnings).toEqual([]);
  });
});

describe("formatExplain", () => {
  const report: ExplainReport = {
    resource: "orders",
    shape: "orders · filter status:is · sort createdAt desc · offset · count exact",
    shapeKey: {
      resource: "orders",
      filters: ["status:is"],
      sorting: ["createdAt desc"],
      search: [],
      facets: [],
      pagination: "offset",
      count: "exact",
    },
    analyzed: true,
    planning: [],
    notes: [],
    stages: [
      {
        stage: "ids",
        sql: "select 1",
        ms: 0.4,
        summary: "index orders_created_at_idx, 51 rows read",
        plan: { "Node Type": "Limit" },
        warnings: [],
      },
      {
        stage: "count",
        sql: "select 2",
        ms: 812,
        summary: "seq scan on orders, 9,412,330 rows read",
        plan: { "Node Type": "Aggregate" },
        warnings: [
          {
            code: "full-count",
            message: "reads 9,412,330 rows to return one number",
            fix: 'count: "capped" stops after 10,001 rows and shows "10,000+" instead',
            basis: "measured",
          },
        ],
      },
      {
        stage: "facets",
        sql: "select 3",
        ms: 1700,
        summary: "seq scan on orders, 9,412,330 rows read",
        plan: { "Node Type": "Aggregate" },
        warnings: [],
      },
    ],
  };

  it("prints one line per stage with what is slow and what fixes it", () => {
    expect(formatExplain(report)).toBe(
      [
        "orders · filter status:is · sort createdAt desc · offset · count exact",
        "  ids     0.4 ms   index orders_created_at_idx, 51 rows read",
        "  count   812 ms   reads 9,412,330 rows to return one number",
        '                   fix: count: "capped" stops after 10,001 rows and shows "10,000+" instead',
        "  facets  1.70 s   seq scan on orders, 9,412,330 rows read",
      ].join("\n"),
    );
  });

  it("says when nothing ran", () => {
    const printed = formatExplain({
      ...report,
      analyzed: false,
      stages: report.stages.map(({ ms: _ms, ...stage }) => stage),
    });
    expect(printed).toContain("  ids     -        index orders_created_at_idx");
    expect(printed).toContain("plan only, nothing was executed");
  });
});

describe("explain on other databases", () => {
  it("fails with a clear error", async () => {
    const items = pgTable("items", { id: integer().primaryKey(), name: text().notNull() });
    const db = { query: { items: { findMany: async () => [] } } };
    const resource = createQueryEngine({ db, schema: { items }, relations: {} }).defineResource(
      "items",
      {},
    );
    await expect(
      resource.explain({
        request: {
          pagination: { mode: "offset", pageIndex: 1, pageSize: 10 },
          sorting: [],
          filters: [],
          search: { value: "", fields: [] },
        },
      }),
    ).rejects.toThrow("explain() needs a PostgreSQL database");
  });
});
