import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { formatExplain } from "../index.js";
import type { ExplainReport, QueryFilterNode, QueryRequestInput } from "../index.js";
import { createObserveFixture, pageRequest } from "./observe-fixture.js";

const fixture = createObserveFixture({ rows: 300_000 });
const { ordersResource } = fixture;

const is = (key: string, value: unknown): QueryFilterNode => ({
  type: "condition",
  key,
  operator: "is",
  value,
});
const noCount = { mode: "offset", pageIndex: 1, pageSize: 25, count: "none" } as const;

function codes(report: ExplainReport, stage: string) {
  return report.stages
    .filter((entry) => entry.stage === stage)
    .flatMap((entry) => entry.warnings.map((warning) => warning.code));
}

describe.skipIf(!fixture.connectionString)("explain on a 300,000-row table", () => {
  beforeAll(() => fixture.setup(), 180_000);
  afterAll(() => fixture.teardown(), 60_000);

  it("runs nothing without analyze, and reads the count from the plan", async () => {
    fixture.statements.length = 0;
    const report = await ordersResource.explain({ request: pageRequest() });
    expect(report.analyzed).toBe(false);
    expect(report.stages.map((stage) => stage.stage)).toEqual(["ids", "count"]);
    expect(
      report.stages.every((stage) => stage.ms === undefined && stage.rowsRead === undefined),
    ).toBe(true);
    // Every statement the explain sent is an EXPLAIN or a catalog read; no ANALYZE, no transaction.
    const sent = fixture.statements.filter((statement) => !statement.includes("pg_catalog"));
    expect(sent.every((statement) => /^explain \(verbose, format json\)/.test(statement))).toBe(
      true,
    );
    expect(codes(report, "count")).toEqual(["full-count"]);
    expect(report.stages[1]!.warnings[0]).toMatchObject({
      basis: "estimated",
      fix: 'count: "capped" stops after 10,001 rows and shows "10,000+" instead',
    });
    expect(report.stages[1]!.warnings[0]!.message).toMatch(
      /^expects to read about 300,000 rows to return one number$/,
    );
  });

  it("measures an exact count with analyze, and a capped count is not a full count", async () => {
    const exact = await ordersResource.explain({ request: pageRequest(), analyze: true });
    const count = exact.stages.find((stage) => stage.stage === "count")!;
    expect(count.warnings[0]).toMatchObject({
      code: "full-count",
      message: "reads 300,000 rows to return one number",
      basis: "measured",
    });
    expect(count.rowsRead).toBe(300_000);
    expect(count.rowsReturned).toBe(1);
    expect(count.ms).toBeGreaterThan(0);
    const ids = exact.stages.find((stage) => stage.stage === "ids")!;
    expect(ids.warnings).toEqual([]);
    expect(ids.rowsReturned).toBe(25);
    expect(ids.summary).toMatch(/^index orders_created_at_id_idx, 25 rows read$/);

    const capped = await ordersResource.explain({
      request: pageRequest({ pagination: { ...noCount, count: "capped" } }),
      analyze: true,
    });
    expect(codes(capped, "count")).toEqual([]);
    expect(capped.stages.find((stage) => stage.stage === "count")!.rowsRead).toBe(10_001);
  });

  it("warns about a deep offset from the request, and advises cursor pagination", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ pagination: { ...noCount, pageIndex: 4_000, pageSize: 50 } }),
    });
    expect(report.stages[0]!.warnings).toHaveLength(1);
    expect(report.stages[0]!.warnings[0]).toMatchObject({
      code: "deep-offset",
      basis: "estimated",
      message:
        "page 4,000 skips 199,950 rows to return 50: PostgreSQL reads and discards every row before the page",
      fix: 'use cursor pagination (pagination: { mode: "cursor" }): it starts after the last row of the previous page, at any depth',
    });
    const noCursor = await fixture.scopedResource.explain({
      request: pageRequest({ pagination: { ...noCount, pageIndex: 4_000, pageSize: 50 } }),
      context: { region: "eu" },
    });
    expect(noCursor.stages[0]!.warnings[0]!.fix).toContain("allow cursor pagination");
    // A cursor page at any depth reads the page only.
    const cursor = await ordersResource.explain({
      request: pageRequest({
        pagination: { mode: "cursor", cursor: null, pageSize: 50, count: "none" },
      }),
      analyze: true,
    });
    expect(cursor.stages[0]!.warnings).toEqual([]);
  });

  it("finds a filter that walks the whole sort index, which the planner thought cheap", async () => {
    const request = pageRequest({
      pagination: noCount,
      filters: [is("a", 0), is("b", 1)],
    });
    const planned = await ordersResource.explain({ request });
    // The planner believes a third of the rows match: nothing to warn about before running it.
    expect(codes(planned, "ids")).toEqual([]);
    const measured = await ordersResource.explain({ request, analyze: true });
    const [walk] = measured.stages[0]!.warnings;
    expect(walk).toMatchObject({
      code: "index-walk",
      message:
        "walks 300,000 rows of orders_created_at_id_idx to find 0 matching rows: the filter is checked row by row after the index",
      basis: "measured",
    });
    expect(walk!.fix).toContain("add an index that starts with the filtered columns");
    expect(measured.stages[0]!.rowsRead).toBe(300_000);
    expect(measured.stages[0]!.rowsReturned).toBe(0);
  });

  it("finds a row estimate that is far off, because two columns move together", async () => {
    const request = pageRequest({ filters: [is("c", 3), is("d", 3)] });
    const report = await ordersResource.explain({ request, analyze: true });
    const [estimate] = report.stages
      .find((stage) => stage.stage === "count")!
      .warnings.filter((warning) => warning.code === "misestimate");
    expect(estimate!.message).toMatch(
      /^PostgreSQL expected [\d,]+ rows from orders but got 15,000 \(\d+x more\), so it can pick a plan that is slow at this size$/,
    );
    expect(estimate!.fix).toMatch(/^run ANALYZE orders;/);
    // Only a measurement can show it.
    expect(codes(await ordersResource.explain({ request }), "count")).not.toContain("misestimate");
  });

  it("finds a filter that no index serves, in the plan and in the measurement", async () => {
    const request = pageRequest({ filters: [is("amount", 12_345)] });
    for (const analyze of [false, true]) {
      const report = await ordersResource.explain({ request, analyze });
      for (const stage of ["ids", "count"]) {
        expect(codes(report, stage)).toContain("seq-scan");
      }
      const [warning] = report.stages[1]!.warnings;
      expect(warning!.message).toMatch(
        /^reads (about )?300,00\d rows of orders to keep (about )?\d+: no index serves the filter \(orders\.amount = 12345\)$/,
      );
      expect(warning!.fix).toBe("add an index on the filtered column(s) of orders");
    }
  });

  it("finds a sort through a relation", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ sorting: [{ key: "customer.name", dir: "asc" }] }),
      analyze: true,
    });
    const [warning] = report.stages[0]!.warnings;
    expect(warning).toMatchObject({
      code: "relation-sort",
      message:
        "sorting by customer.name joins every matching row of orders to the related table before it can sort (300,000 rows sorted)",
      fix: 'copy customer.name onto orders and sort by the copy, or add "customer.name" to sort.disabled',
    });
  });

  it("finds facets that share one GROUPING SETS statement", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({
        pagination: { ...noCount, count: "capped" },
        facets: [{ key: "status" }, { key: "region" }, { key: "customer.country" }],
      }),
      analyze: true,
    });
    const facets = report.stages.filter((stage) => stage.stage === "facets");
    expect(facets).toHaveLength(2);
    const shared = facets.find((stage) => stage.label?.includes("GROUPING SETS"))!;
    expect(shared.warnings[0]).toMatchObject({
      code: "single-cpu-facets",
      message:
        "2 facets (status, region) share one GROUPING SETS statement, which PostgreSQL runs on one CPU while it reads 300,000 rows",
    });
    expect(facets.find((stage) => stage !== shared)!.warnings).toEqual([]);
    expect(formatExplain(report)).toContain("fix: request fewer facets at once");
  });

  it("explains a summary and a facet with its empty-count statement", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({
        pagination: noCount,
        facets: [{ key: "region", missing: true }],
      }),
      summary: true,
    });
    expect(report.stages.map((stage) => stage.stage)).toEqual([
      "ids",
      "facets",
      "facets",
      "summary",
    ]);
    expect(report.stages.some((stage) => stage.label?.includes("rows where region is empty"))).toBe(
      true,
    );
  });

  it("runs analyze in a read-only transaction that is rolled back", async () => {
    fixture.statements.length = 0;
    await ordersResource.explain({ request: pageRequest(), analyze: true });
    const sent = fixture.statements.map((statement) => statement.toLowerCase());
    expect(sent[0]).toMatch(/^begin/);
    expect(sent).toContain("rollback");
    expect(sent).not.toContain("commit");
    expect(
      sent.some((statement) => statement.startsWith("explain (analyze, buffers, verbose")),
    ).toBe(true);
  });

  it("shows an estimated count as the plan it is read from", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ pagination: { ...noCount, count: "estimated" } }),
    });
    expect(report.stages.map((stage) => stage.stage)).toEqual(["ids", "count"]);
    expect(report.stages[1]!.label).toBe(
      "the count is the planner's row estimate for this statement, nothing is counted",
    );
    expect(report.stages[1]!.sql).not.toMatch(/count\(\*\)/);
  });

  it("advises the expression index for a text filter, and the advice clears the warning", async () => {
    const request = pageRequest({ filters: [is("status", "zzz")] });
    const flagged = (report: ExplainReport) =>
      report.stages
        .flatMap((stage) => stage.warnings)
        .filter((warning) => warning.code === "seq-scan" || warning.code === "index-walk");
    for (const analyze of [false, true]) {
      const before = flagged(await ordersResource.explain({ request, analyze }));
      expect(before.length).toBeGreaterThan(0);
      for (const warning of before) expect(warning.fix).toContain("lower(status)");
    }
    await fixture.db.execute(
      sql`create index orders_lower_status_idx on ${fixture.orders} (lower(status))`,
    );
    try {
      await fixture.db.execute(sql`analyze ${fixture.orders}`);
      const after = await ordersResource.explain({ request, analyze: true });
      expect(flagged(after)).toEqual([]);
      expect(after.stages[0]!.rowsRead).toBeLessThan(10);
    } finally {
      await fixture.db.execute(
        sql`drop index ${sql.identifier(fixture.schemaName)}.orders_lower_status_idx`,
      );
    }
  });

  it("does not send an estimate on a text expression to ANALYZE", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ filters: [is("status", "paid")] }),
      analyze: true,
    });
    const estimate = report.stages
      .flatMap((stage) => stage.warnings)
      .find((warning) => warning.code === "misestimate")!;
    expect(estimate.fix).toMatch(
      /^PostgreSQL keeps no statistics on lower\(status\), so ANALYZE cannot fix/,
    );
  });

  it("leaves a sort through a relation alone when almost nothing matches", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({
        filters: [is("id", 5)],
        sorting: [{ key: "customer.name", dir: "asc" }],
      }),
      analyze: true,
    });
    expect(codes(report, "ids")).not.toContain("relation-sort");
  });

  it("finds the full count in the facets statement that carries it", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ facets: [{ key: "status" }, { key: "region" }] }),
      analyze: true,
    });
    expect(report.stages.map((stage) => stage.stage)).toEqual(["ids", "facets"]);
    const found = report.stages[1]!.warnings.find((warning) => warning.code === "full-count")!;
    expect(found.message).toBe(
      "the exact count rides in this facets statement, which reads 300,000 rows to produce it",
    );
    expect(found.fix).toContain('count: "capped"');
  });

  describe("a search without an exact count", () => {
    const request = pageRequest({
      pagination: noCount,
      search: { value: "ref-29999", fields: ["reference", "customer.name"] },
    });

    it("explains both plans and says which the engine takes, without running anything", async () => {
      const report = await ordersResource.explain({ request });
      const [ordinary, indexed] = report.stages.filter((stage) => stage.stage === "ids");
      expect(ordinary).toMatchObject({ attempt: "ordinary" });
      expect(indexed).toMatchObject({ attempt: "indexed" });
      expect(ordinary!.sql).not.toBe(indexed!.sql);
      expect(ordinary!.label).toBe("ordinary search plan, runs first with a 25 ms budget");
      expect(report.notes.join("\n")).toMatch(
        /^search: the engine runs the ordinary plan first with a 25 ms budget and switches to the indexed plan only if that runs over/,
      );
      expect(report.notes.join("\n")).toMatch(
        /PostgreSQL costs the ordinary plan at [\d,]+ and the indexed plan at [\d,]+/,
      );
    });

    it("applies the budget under analyze, and keeps the ordinary plan when it fits", async () => {
      const roomy = fixture.engine.defineResource("orders", {
        relations: { customer: true },
        query: {
          pagination: { modes: ["offset"] },
          search: { allowed: ["reference", "customer.name"], planBudget: 60_000 },
        },
      });
      const report = await roomy.explain({ request, analyze: true });
      const ids = report.stages.filter((stage) => stage.stage === "ids");
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatchObject({
        attempt: "ordinary",
        budget: { ms: 60_000, exceeded: false },
      });
      expect(report.notes.join("\n")).toContain(
        "the ordinary plan finished within its 60000 ms budget, so the engine keeps it",
      );
    });

    it("reports the attempt that ran over its budget and then the indexed retry", async () => {
      const tight = fixture.engine.defineResource("orders", {
        relations: { customer: true },
        query: {
          pagination: { modes: ["offset"] },
          search: { allowed: ["reference", "customer.name"], planBudget: 1 },
        },
      });
      const report = await tight.explain({ request, analyze: true });
      const ids = report.stages.filter((stage) => stage.stage === "ids");
      expect(ids.map((stage) => stage.attempt)).toEqual(["ordinary", "indexed"]);
      expect(ids[0]!.budget).toEqual({ ms: 1, exceeded: true });
      expect(ids[0]!.summary).toMatch(
        /^stopped at its 1 ms budget, the engine retries with the indexed plan/,
      );
      expect(ids[1]!.ms).toBeGreaterThan(0);
      expect(report.notes.join("\n")).toContain("ran over its 1 ms budget, so the engine retries");
      expect(formatExplain(report)).toContain("stopped at its 1 ms budget");
    });
  });

  it("explains inside a caller's transaction, without the search budget, and leaves it usable", async () => {
    const request = pageRequest({
      pagination: noCount,
      search: { value: "ref-29999", fields: ["reference", "customer.name"] },
    });
    const report = await fixture.db.transaction(async (transaction) => {
      const explained = await ordersResource.explain({ request, db: transaction, analyze: true });
      const result = await transaction.execute<{ one: number }>(sql`select 1 as one`);
      expect(result.rows[0]!.one).toBe(1);
      return explained;
    });
    expect(report.stages.filter((stage) => stage.stage === "ids")).toHaveLength(1);
    expect(report.stages[0]!.attempt).toBeUndefined();
    expect(report.analyzed).toBe(true);
  });

  it("explains concurrent requests independently", async () => {
    const requests = [
      pageRequest({ pagination: { ...noCount, pageIndex: 4_000, pageSize: 50 } }),
      pageRequest({ filters: [is("amount", 12_345)] }),
      pageRequest({ sorting: [{ key: "customer.name", dir: "asc" }] }),
      pageRequest({ facets: [{ key: "status" }, { key: "region" }] }),
    ];
    const alone = [];
    for (const request of requests) alone.push(await ordersResource.explain({ request }));
    const together = await Promise.all([
      ...requests.map((request) => ordersResource.explain({ request })),
      ordersResource.query({ request: pageRequest() }),
      ...requests.map((request) => ordersResource.explain({ request, analyze: true })),
    ]);
    const warnings = (report: ExplainReport) =>
      report.stages.map((stage) => [stage.stage, stage.warnings.map((warning) => warning.code)]);
    for (const [index, report] of alone.entries()) {
      expect(warnings(together[index] as ExplainReport)).toEqual(warnings(report));
    }
    for (const index of requests.keys()) {
      const measured = together[requests.length + 1 + index] as ExplainReport;
      expect(measured.shape).toBe(alone[index]!.shape);
      expect(measured.analyzed).toBe(true);
    }
  });

  it("refuses a resource whose ids come from your own statement", async () => {
    const custom = fixture.engine.defineResource("orders", {
      strategy: { ids: async () => ({ ids: [], pageInfo: {} as never }) },
    });
    await expect(custom.explain({ request: pageRequest() })).rejects.toThrow(
      'explain() cannot explain resource "orders": its strategy.ids runs your own statements',
    );
  });

  it("prints the report for the console", async () => {
    const request: QueryRequestInput = pageRequest({
      filters: [is("c", 3), is("d", 3)],
      facets: [{ key: "status" }, { key: "region" }],
    });
    const report = await ordersResource.explain({ request, analyze: true });
    const printed = formatExplain(report);
    expect(printed.split("\n")[0]).toBe(
      "orders · filter c:is,d:is · sort createdAt desc · facets region:exclude-self,status:exclude-self · offset · count exact",
    );
    expect(printed).toMatch(/\n {2}ids {5}\S+ ms +/);
    // The exact count rides in the facets statement, so there is no count stage of its own.
    expect(report.stages.map((stage) => stage.stage)).toEqual(["ids", "facets"]);
    expect(printed).toContain("fix: run ANALYZE orders;");
    expect(printed).not.toContain("plan only");
  });
});
