import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createQueryEngine, formatExplain } from "../index.js";
import type { ExplainReport, QueryFilterNode, QueryRequestInput } from "../index.js";
import { createObserveFixture, pageRequest } from "./observe-fixture.js";

const fixture = createObserveFixture({ rows: 300_000 });
const { ordersResource, groupedResource } = fixture;

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
    expect(report.stages.map((stage) => stage.stage)).toEqual(["count", "ids"]);
    expect(
      report.stages.every((stage) => stage.ms === undefined && stage.rowsRead === undefined),
    ).toBe(true);
    // Every statement the explain sent is an EXPLAIN or a catalog read; no ANALYZE, no transaction.
    const sent = fixture.statements.filter((statement) => !statement.includes("pg_catalog"));
    expect(sent.every((statement) => /^explain \(verbose, format json\)/.test(statement))).toBe(
      true,
    );
    expect(codes(report, "count")).toEqual(["full-count"]);
    expect(report.stages[0]!.warnings[0]).toMatchObject({
      basis: "estimated",
      fix: 'count: "capped" stops after 10,001 rows and shows "10,000+" instead',
    });
    expect(report.stages[0]!.warnings[0]!.message).toMatch(
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
        /^reads (about )?300,00\d rows of orders to keep (about )?\d+: it checks the filter \(orders\.amount = 12345\) on every row$/,
      );
      expect(warning!.fix).toBe("add an index on the filtered column(s) of orders");
    }
  });

  it("finds a sort through a relation", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ sorting: [{ key: "customer.name", dir: "asc" }] }),
      analyze: true,
    });
    const [warning] = report.stages.find((stage) => stage.stage === "ids")!.warnings;
    expect(warning).toMatchObject({
      code: "relation-sort",
      message:
        "sorting by customer.name joins every matching row of orders to the related table before it can sort (300,000 rows sorted)",
      fix: 'copy customer.name onto orders and sort by the copy, or add "customer.name" to sort.disabled',
    });
  });

  it("finds facets that share one GROUPING SETS statement", async () => {
    const report = await groupedResource.explain({
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
      fix: "set query.facets.splitAbove to a number of rows: above it each facet runs as its own statement, which can use parallel workers",
    });
    expect(facets.find((stage) => stage !== shared)!.warnings).toEqual([]);
    expect(formatExplain(report)).toContain("fix: set query.facets.splitAbove");
  });

  it("runs the facets of a big table as separate statements, with nothing to warn about", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({
        pagination: { ...noCount, count: "exact" },
        facets: [{ key: "status" }, { key: "region" }, { key: "customer.country" }],
      }),
      analyze: true,
    });
    const facets = report.stages.filter((stage) => stage.stage === "facets");
    expect(facets.map((stage) => stage.label)).toEqual(["status", "region", "customer.country"]);
    expect(facets.flatMap((stage) => stage.warnings.map((warning) => warning.code))).toEqual([]);
    expect(report.stages.filter((stage) => stage.stage === "count")).toHaveLength(1);
    // The row estimate the decision read is reported with the other planning statements.
    expect(report.planning.some((entry) => entry.sql.includes("reltuples"))).toBe(true);
  });

  it("explains a summary and a facet with its empty-count statement", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({
        pagination: noCount,
        facets: [{ key: "region", missing: true }],
      }),
      summary: true,
    });
    // in the order the request runs them: the summary, the facets, then the page
    expect(report.stages.map((stage) => stage.stage)).toEqual([
      "summary",
      "facets",
      "facets",
      "ids",
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
    expect(report.stages.map((stage) => stage.stage)).toEqual(["count", "ids"]);
    expect(report.stages[0]!.label).toBe(
      "the count is the planner's row estimate for this statement, nothing is counted",
    );
    expect(report.stages[0]!.sql).not.toMatch(/count\(\*\)/);
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
    const report = await groupedResource.explain({
      request: pageRequest({ facets: [{ key: "status" }, { key: "region" }] }),
      analyze: true,
    });
    expect(report.stages.map((stage) => stage.stage)).toEqual(["facets", "ids"]);
    const found = report.stages[0]!.warnings.find((warning) => warning.code === "full-count")!;
    expect(found.message).toBe(
      "the exact count rides in this facets statement, which reads 300,000 rows to produce it",
    );
    expect(found.fix).toContain('count: "capped"');
  });

  it("finds the full count in a statement of its own when the facets are split", async () => {
    const report = await ordersResource.explain({
      request: pageRequest({ facets: [{ key: "status" }, { key: "region" }] }),
      analyze: true,
    });
    expect(report.stages.map((stage) => stage.stage)).toEqual(["ids", "count", "facets", "facets"]);
    const count = report.stages.find((stage) => stage.stage === "count")!;
    expect(count.warnings.map((warning) => warning.code)).toEqual(["full-count"]);
    expect(count.warnings[0]!.message).toMatch(/rows to return one number$/);
    expect(
      report.stages
        .filter((stage) => stage.stage === "facets")
        .flatMap((stage) => stage.warnings.map((warning) => warning.code)),
    ).toEqual([]);
  });

  describe("a search without an exact count", () => {
    const request = pageRequest({
      pagination: noCount,
      search: { value: "ref-29999", fields: ["reference", "customer.name"] },
    });
    const resourceWith = (planBudget: number) =>
      fixture.engine.defineResource("orders", {
        relations: { customer: true },
        query: {
          pagination: { modes: ["offset"] },
          search: { allowed: ["reference", "customer.name"], planBudget },
        },
      });

    it("explains both attempts and says which the engine takes, without running anything", async () => {
      const report = await ordersResource.explain({ request });
      const [ordinary, indexed] = report.stages.filter((stage) => stage.stage === "ids");
      expect(ordinary).toMatchObject({ attempt: "ordinary" });
      expect(indexed).toMatchObject({ attempt: "indexed" });
      expect(ordinary!.sql).not.toBe(indexed!.sql);
      expect(ordinary!.label).toBe("ordinary search plan, runs first with a 25 ms budget");
      expect(indexed!.label).toBe(
        "indexed search plan, runs when the ordinary one ran over, with a 100 ms budget",
      );
      expect(report.notes.join("\n")).toMatch(
        /^search, the page: the engine runs the ordinary plan with a 25 ms budget; if that runs over it tries the indexed plan with 100 ms; if that runs over too it runs the ordinary plan again with no budget\./,
      );
      expect(report.notes.join("\n")).toMatch(
        /PostgreSQL costs the ordinary plan at [\d,]+ and the indexed plan at [\d,]+/,
      );
    });

    it("keeps the ordinary plan under analyze when it fits its budget", async () => {
      const report = await resourceWith(60_000).explain({ request, analyze: true });
      const ids = report.stages.filter((stage) => stage.stage === "ids");
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatchObject({
        attempt: "ordinary",
        budget: { ms: 60_000, exceeded: false },
      });
      expect(report.notes.join("\n")).toContain(
        "the ordinary plan finished within its 60000 ms budget, so query keeps it",
      );
    });

    it("moves to the indexed attempt, with four times the budget, when the ordinary one runs over", async () => {
      const report = await resourceWith(1).explain({ request, analyze: true });
      const ids = report.stages.filter((stage) => stage.stage === "ids");
      expect(ids.slice(0, 2).map((stage) => stage.attempt)).toEqual(["ordinary", "indexed"]);
      expect(ids[0]!.budget).toEqual({ ms: 1, exceeded: true });
      expect(ids[0]!.summary).toMatch(/^stopped at its 1 ms budget; planned: /);
      expect(ids[1]!.budget!.ms).toBe(4);
      // When the indexed attempt runs over too, the ordinary plan runs once more with no budget.
      const final = ids.filter((stage) => stage.final);
      expect(final.length).toBe(ids[1]!.budget!.exceeded ? 1 : 0);
      expect(final.every((stage) => stage.sql === ids[0]!.sql && stage.budget === undefined)).toBe(
        true,
      );
      expect(formatExplain(report)).toContain("stopped at its 1 ms budget");
    });
  });

  describe("explain takes the path query takes", () => {
    const searchRequest = (
      count: "none" | "capped" | "exact",
      extra: Partial<QueryRequestInput> = {},
    ) =>
      pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count },
        search: { value: "ref-29999", fields: ["reference", "customer.name"] },
        ...extra,
      });
    const resourceWith = (planBudget: number) =>
      fixture.engine.defineResource("orders", {
        relations: { customer: true },
        query: {
          pagination: { modes: ["offset"] },
          search: { allowed: ["reference", "customer.name"], planBudget },
        },
      });
    const compared = new Set(["ids", "count", "facets", "summary"]);
    const ranBy = async (
      resource: { query: typeof ordersResource.query },
      request: QueryRequestInput,
    ) => {
      fixture.events.length = 0;
      await resource.query({ request });
      return fixture.events
        .filter((event) => compared.has(event.stage))
        .map((event) => `${event.stage}: ${event.sql}`)
        .toSorted();
    };

    for (const [outcome, budget] of [
      ["fits its budget", 60_000],
      ["runs over its budget", 1],
    ] as const) {
      for (const count of ["none", "capped", "exact"] as const) {
        it(`${count} count, the ordinary plan ${outcome}`, async () => {
          const resource = resourceWith(budget);
          const request = searchRequest(count);
          const ran = await ranBy(resource, request);
          const report = await resource.explain({ request, analyze: true });
          expect(report.stages.map((stage) => `${stage.stage}: ${stage.sql}`).toSorted()).toEqual(
            ran,
          );
          const attempts = report.stages.map((stage) => stage.attempt).filter(Boolean);
          // Exact counts decide the plan up front; the others run budgeted attempts.
          expect(attempts.length > 0).toBe(count !== "exact");
        });
      }
    }

    describe("a capped count steers the page", () => {
      const kinds = (sqls: string[]) =>
        sqls.map((statement) => (statement.includes(" union ") ? "indexed" : "ordinary"));
      for (const [term, outcome, pageFirst] of [
        ["ref-29999", "comes back under its cap", "indexed"],
        ["ref", "hits its cap", "ordinary"],
      ] as const) {
        it(`${term}: the count ${outcome}, the page starts on the ${pageFirst} plan`, async () => {
          const resource = fixture.engine.defineResource("orders", {
            relations: { customer: true },
            query: {
              pagination: { modes: ["offset"], countCap: 1_000 },
              // roomy, so no attempt runs over and both runs take the same attempts
              search: { allowed: ["reference", "customer.name"], planBudget: 60_000 },
            },
          });
          const request = pageRequest({
            pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "capped" },
            search: { value: term, fields: ["reference", "customer.name"] },
          });
          fixture.events.length = 0;
          const result = await resource.query({ request });
          const ran = fixture.events.filter(
            (event) => event.stage === "count" || event.stage === "ids",
          );
          const report = await resource.explain({ request, analyze: true });
          const listed = report.stages.filter(
            (stage) => stage.stage === "count" || stage.stage === "ids",
          );
          // the same statements, in the same order, on the same plans
          expect(listed.map((stage) => `${stage.stage}: ${stage.sql}`)).toEqual(
            ran.map((event) => `${event.stage}: ${event.sql}`),
          );
          expect(listed.map((stage) => `${stage.stage} ${kinds([stage.sql])[0]}`)).toEqual(
            ran.map((event) => `${event.stage} ${kinds([event.sql])[0]}`),
          );
          // and the page began where the count says it should
          const page = ran.filter((event) => event.stage === "ids");
          expect(kinds(page.map((event) => event.sql))[0]).toBe(pageFirst);
          expect((result.pageInfo as { exact?: boolean }).exact).toBe(pageFirst === "indexed");
          expect(report.notes.join("\n")).toContain(
            pageFirst === "indexed"
              ? "the count came back under its cap"
              : "the count hit its cap, so the page starts on the ordinary plan",
          );
          const firstPage = listed.find((stage) => stage.stage === "ids")!;
          expect(firstPage.attempt).toBe(pageFirst);
          expect(firstPage.label).toContain(
            pageFirst === "indexed"
              ? "first because the count came back under its cap"
              : "first because the count hit its cap",
          );
        });
      }
    });

    it("lists both paths without analyze, in the order the request runs them", async () => {
      const report = await resourceWith(25).explain({ request: searchRequest("capped") });
      expect(report.stages.map((stage) => [stage.stage, stage.attempt])).toEqual([
        ["count", "ordinary"],
        ["count", "indexed"],
        ["ids", "ordinary"],
        ["ids", "indexed"],
      ]);
      const printed = formatExplain(report);
      expect(printed).toContain("ordinary search plan, runs first with a 25 ms budget");
      expect(printed).toContain(
        "indexed search plan, runs when the ordinary one ran over, with a 100 ms budget",
      );
      expect(printed).toContain(
        "indexed search plan, first when the count comes back under its cap",
      );
      expect(printed).toContain(
        "ordinary search plan, first when the count hits its cap (25 ms budget)",
      );
    });

    it("runs facets once, on the ordinary plan, whichever attempt the count takes", async () => {
      // The default budget: a rare term's count sits near it, so the two runs can take different
      // attempts. Facets never depend on that, and the matrix above pins the attempts themselves.
      const request = searchRequest("capped", { facets: [{ key: "status" }] });
      fixture.events.length = 0;
      await ordersResource.query({ request });
      const ran = fixture.events.filter((event) =>
        ["count", "ids", "facets"].includes(event.stage),
      );
      fixture.statements.length = 0;
      const report = await ordersResource.explain({ request, analyze: true });
      const kinds = (items: Array<{ stage: string; sql: string }>) =>
        items
          .filter((item) => item.stage !== "facets")
          .map((item) => `${item.stage} ${item.sql.includes(" union ") ? "indexed" : "ordinary"}`);
      const samePath = kinds(ran).join() === kinds(report.stages).join();
      const listing = (items: Array<{ stage: string; sql: string }>) =>
        items.map((item) => `${item.stage}: ${item.sql}`).toSorted();
      expect(listing(samePath ? report.stages : ran)).toEqual(listing(ran));
      const facets = report.stages.filter((stage) => stage.stage === "facets");
      expect(facets.map((stage) => stage.sql)).toEqual(
        ran.filter((event) => event.stage === "facets").map((event) => event.sql),
      );
      expect(facets).toHaveLength(1);
      expect(facets[0]!.attempt).toBeUndefined();
      expect(facets[0]!.budget).toBeUndefined();
      expect(facets[0]!.warnings.every((warning) => warning.basis === "measured")).toBe(true);
      // Every stage is one EXPLAIN ANALYZE: no statement runs twice for the report.
      const analyzed = fixture.statements.filter((statement) =>
        statement.startsWith("explain (analyze"),
      );
      expect(analyzed).toHaveLength(report.stages.length);
      for (const stage of report.stages) {
        expect(analyzed.filter((statement) => statement.includes(stage.sql))).toHaveLength(
          report.stages.filter((other) => other.sql === stage.sql).length,
        );
      }
    });

    it("caps the attempts to the connection's timeout and fails on the rerun, as query does", async () => {
      // One connection, warmed up, then given a 10 ms timeout: both budgeted attempts are capped
      // to it, and the ordinary plan run again with no budget is cancelled by the connection.
      const limited = new Pool({ connectionString: fixture.connectionString, max: 1 });
      try {
        const engine = createQueryEngine({
          db: drizzle({ client: limited, relations: fixture.relationsGraph }),
          schema: fixture.schema,
          relations: fixture.relationsGraph,
        });
        const resource = engine.defineResource("orders", {
          relations: { customer: true },
          query: {
            pagination: { modes: ["offset"] },
            search: { allowed: ["reference", "customer.name"], planBudget: 60_000 },
          },
        });
        // A common term sorted through a relation is slow on both plans, by far more than 10 ms.
        const request = searchRequest("none", {
          search: { value: "ref", fields: ["reference", "customer.name"] },
          sorting: [{ key: "customer.name", dir: "asc" }],
        });
        await resource
          .query({
            request: { ...request, pagination: { ...request.pagination!, count: "none" } },
            // a warm-up that the timeout below does not reach
          })
          .catch(() => undefined);
        await limited.query("set statement_timeout = 10");
        const plain = await resource.explain({ request });
        expect(plain.notes.join("\n")).toContain(
          "the connection's statement_timeout (10 ms) is below the 60000 ms plan budget",
        );
        // Both attempts are capped to the connection's 10 ms and run over; the ordinary plan then
        // runs again with no budget and the connection cancels it. explain ends where query ends.
        for (const run of [
          () => resource.explain({ request, analyze: true }),
          () => resource.query({ request }),
        ]) {
          await expect(run()).rejects.toMatchObject({ cause: { code: "57014" } });
        }
      } finally {
        await limited.end();
      }
    });

    it("runs the ordinary attempt under the smaller of the budget and the connection's timeout", async () => {
      const limited = new Pool({
        connectionString: fixture.connectionString,
        max: 2,
        statement_timeout: 5_000,
      });
      try {
        const engine = createQueryEngine({
          db: drizzle({ client: limited, relations: fixture.relationsGraph }),
          schema: fixture.schema,
          relations: fixture.relationsGraph,
        });
        const resource = engine.defineResource("orders", {
          relations: { customer: true },
          query: {
            pagination: { modes: ["offset"] },
            search: { allowed: ["reference", "customer.name"], planBudget: 60_000 },
          },
        });
        const report = await resource.explain({ request: searchRequest("none"), analyze: true });
        expect(report.stages[0]!.budget).toEqual({ ms: 5_000, exceeded: false });
      } finally {
        await limited.end();
      }
    });
  });

  describe('with facets.whenCapped: "skip"', () => {
    const skipping = fixture.engine.defineResource("orders", {
      query: {
        pagination: { modes: ["offset"], countCap: 100 },
        facets: { allowed: ["status", "region"], whenCapped: "skip" },
      },
    });
    const capped = (extra: Partial<QueryRequestInput> = {}) =>
      pageRequest({
        pagination: { ...noCount, count: "capped" },
        facets: [{ key: "status" }],
        ...extra,
      });

    it("keeps a conditional note without analyze", async () => {
      const report = await skipping.explain({ request: capped() });
      expect(report.stages.map((stage) => stage.stage)).toEqual(["count", "facets", "ids"]);
      expect(report.notes.join("\n")).toContain(
        'facets.whenCapped is "skip": the facets above are skipped when the count passes 100',
      );
    });

    it("drops the facets when the measured count passes the cap, as query does", async () => {
      const request = capped();
      fixture.events.length = 0;
      await skipping.query({ request });
      const ran = fixture.events
        .filter((event) => ["count", "ids", "facets"].includes(event.stage))
        .map((event) => `${event.stage}: ${event.sql}`)
        .toSorted();
      fixture.statements.length = 0;
      const report = await skipping.explain({ request, analyze: true });
      expect(report.stages.map((stage) => stage.stage)).toEqual(["count", "ids"]);
      expect(report.stages.map((stage) => `${stage.stage}: ${stage.sql}`).toSorted()).toEqual(ran);
      expect(report.notes.join("\n")).toMatch(
        /facets\.whenCapped is "skip" and the count passes 100 \(it read 101 rows\): query skips the facets, so they are not run here/,
      );
      expect(report.notes.join("\n")).not.toContain("the facets above are skipped when");
      // the skipped facets were never sent to the database
      expect(fixture.statements.filter((statement) => statement.includes("facet_buckets"))).toEqual(
        [],
      );
    });

    it("keeps the facets when the measured count stays within the cap", async () => {
      const request = capped({ filters: [is("id", 5)] });
      const report = await skipping.explain({ request, analyze: true });
      expect(report.stages.map((stage) => stage.stage)).toEqual(["count", "facets", "ids"]);
      expect(report.notes.join("\n")).toContain(
        'facets.whenCapped is "skip", but the count stays within 100: query runs the facets',
      );
    });
  });

  it("advises a trigram index for a substring filter, and the advised index clears the walk", async () => {
    const request = pageRequest({
      filters: [{ type: "condition", key: "status", operator: "contains", value: "zzz" }],
    });
    const flagged = (report: ExplainReport) =>
      report.stages
        .flatMap((stage) => stage.warnings)
        .filter((warning) => warning.code === "seq-scan" || warning.code === "index-walk");
    const before = flagged(await ordersResource.explain({ request, analyze: true }));
    expect(before.length).toBeGreaterThan(0);
    for (const warning of before) {
      expect(warning.fix).toContain("USING gin (lower(status) gin_trgm_ops)");
    }
    await fixture.db.execute(
      sql`create index orders_status_trgm_idx on ${fixture.orders} using gin (lower(status) gin_trgm_ops)`,
    );
    try {
      await fixture.db.execute(sql`analyze ${fixture.orders}`);
      expect(flagged(await ordersResource.explain({ request, analyze: true }))).toEqual([]);
    } finally {
      await fixture.db.execute(
        sql`drop index ${sql.identifier(fixture.schemaName)}.orders_status_trgm_idx`,
      );
    }
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
    expect(report.notes.join("\n")).toContain(
      "inside a transaction you pass, the engine chooses between the ordinary and the indexed plan by the planner's cost and applies no budget",
    );
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
    expect(report.stages.map((stage) => stage.stage)).toEqual(["facets", "ids"]);
    expect(printed).toContain("fix: run ANALYZE orders;");
    expect(printed).not.toContain("plan only");
  });
});
