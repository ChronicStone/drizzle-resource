import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import type { QueryEvent, QueryRequestInput } from "../index.js";
import { createObserveFixture, pageRequest } from "./observe-fixture.js";

let hookMode: "ok" | "throw" | "reject" = "ok";
const fixture = createObserveFixture({
  rows: 20_000,
  onQuery: () => {
    if (hookMode === "throw") throw new Error("hook failed");
    // Returned to the engine as is: a rejection must be swallowed there, not left unhandled.
    if (hookMode === "reject") return Promise.reject(new Error("hook rejected"));
  },
});
const { events, ordersResource, groupedResource } = fixture;

const stages = () => events.map((event) => event.stage);

describe.skipIf(!fixture.connectionString)("onQuery on PostgreSQL", () => {
  beforeAll(() => fixture.setup(), 120_000);
  afterAll(() => fixture.teardown(), 60_000);
  beforeEach(() => {
    events.length = 0;
  });

  it("reports the planning of a cross-table search: catalog reads, then plan estimates", async () => {
    // First search of the run: it also reads the index catalog, once per table.
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "none" },
        search: { value: "ref-1999", fields: ["reference", "customer.name"] },
      }),
    });
    expect(stages().filter((stage) => stage === "plan")).toHaveLength(2);
    expect(stages().slice(-2)).toEqual(["ids", "rows"]);
    expect(events[0]!.shape).toContain("search customer.name,reference");

    events.length = 0;
    await ordersResource.query({
      request: pageRequest({
        search: { value: "ref-1999", fields: ["reference", "customer.name"] },
      }),
    });
    expect(stages().filter((stage) => stage === "plan")).toHaveLength(2);
    expect(
      events.filter((event) => event.stage === "plan").every((event) => /^explain/.test(event.sql)),
    ).toBe(true);
    expect(stages()).toContain("count");
  });

  it("reports the ordinary search attempt that ran out of budget, then its retry", async () => {
    const budgeted = fixture.engine.defineResource("orders", {
      relations: { customer: true },
      query: {
        pagination: { modes: ["offset"] },
        search: { allowed: ["reference", "customer.name"], planBudget: 40 },
      },
    });
    const locker = await fixture.client.connect();
    await locker.query("begin");
    const table = (fixture.orders as any)[Symbol.for("drizzle:Name")];
    const schemaName = (fixture.orders as any)[Symbol.for("drizzle:Schema")];
    await locker.query(`lock table "${schemaName}"."${table}" in access exclusive mode`);
    try {
      const pending = budgeted.queryIds({
        request: pageRequest({
          pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "none" },
          search: { value: "ref-1999", fields: ["reference", "customer.name"] },
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await locker.query("rollback");
      await pending;
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
    }
    const ids = events.filter((event) => event.stage === "ids");
    expect(ids).toHaveLength(2);
    expect(ids[0]!.error).toMatchObject({ cause: { code: "57014" } });
    expect(ids[1]!.error).toBeUndefined();
    expect(ids[1]!.sql).not.toBe(ids[0]!.sql);
  });

  it("reports an exact count, the ids and the rows of an offset page", async () => {
    const result = await ordersResource.query({ request: pageRequest() });
    expect(stages()).toEqual(["count", "ids", "rows"]);
    expect(events.map((event) => event.rows)).toEqual([1, 25, 25]);
    expect(result.rows).toHaveLength(25);
    for (const event of events) {
      expect(event.resource).toBe("orders");
      expect(event.shape).toBe("orders · sort createdAt desc · offset · count exact");
      expect(event.shapeKey.count).toBe("exact");
      expect(event.ms).toBeGreaterThanOrEqual(0);
      expect(event.error).toBeUndefined();
    }
    expect(events[0]!.sql).toContain("count(*)");
  });

  it("reports a capped count as a bounded statement", async () => {
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "capped" },
      }),
    });
    expect(stages()).toEqual(["count", "ids", "rows"]);
    expect(events[0]!.sql).toMatch(/limit \$\d+\) "capped_matching_ids"/);
    expect(events[0]!.shape).toContain("count capped");
  });

  it("reports the planner estimate of an estimated count as a plan", async () => {
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "estimated" },
      }),
    });
    expect(stages()).toEqual(["plan", "ids", "rows"]);
    expect(events[0]!.sql).toMatch(/^explain \(format json\) select/);
  });

  it("reports a cursor page without a count", async () => {
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "cursor", cursor: null, pageSize: 10, count: "none" },
      }),
    });
    expect(stages()).toEqual(["ids", "rows"]);
    expect(events[0]!.rows).toBe(11);
    expect(events[0]!.shape).toBe("orders · sort createdAt desc · cursor · count none");
  });

  it("reports facets, one statement per group of facets and one for a relation", async () => {
    await groupedResource.query({
      request: pageRequest({
        facets: [{ key: "status" }, { key: "region" }, { key: "customer.country" }],
      }),
    });
    const facets = events.filter((event) => event.stage === "facets");
    expect(facets).toHaveLength(2);
    expect(facets.some((event) => event.sql.includes("grouping sets"))).toBe(true);
    expect(stages().filter((stage) => stage !== "facets")).toEqual(["ids", "rows"]);
    expect(facets[0]!.shape).toContain(
      "facets customer.country:exclude-self,region:exclude-self,status:exclude-self",
    );
  });

  it("reports the row estimate that decides how facets run, and a statement per facet", async () => {
    const split = fixture.engine.defineResource("orders", {
      relations: { customer: true },
      query: {
        pagination: { modes: ["offset"] },
        // The fixture table has 20,000 rows.
        facets: { allowed: ["status", "region", "customer.country"], splitAbove: 10_000 },
      },
    });
    await split.query({
      request: pageRequest({
        facets: [{ key: "status" }, { key: "region" }, { key: "customer.country" }],
      }),
    });
    const facets = events.filter((event) => event.stage === "facets");
    expect(facets).toHaveLength(3);
    expect(facets.some((event) => event.sql.includes("grouping sets"))).toBe(false);
    const planning = events.filter((event) => event.stage === "plan");
    expect(planning).toHaveLength(1);
    expect(planning[0]!.sql).toContain("reltuples");
    expect(stages().filter((stage) => stage === "count")).toHaveLength(1);
  });

  it("reports a summary", async () => {
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "none" },
      }),
      summary: true,
    });
    expect(stages()).toEqual(["summary", "ids", "rows"]);
    expect(events[0]!.sql).toContain("sum(");
  });

  it("reports the cursor statements of a scan", async () => {
    await ordersResource.scan({ batchSize: 7000, request: { filters: [] } }, async (batches) => {
      let seen = 0;
      for await (const batch of batches) seen += batch.rows.length;
      return seen;
    });
    const scan = events.filter((event) => event.stage === "scan");
    expect(scan[0]!.sql).toMatch(/^declare "resource_scan_/);
    expect(scan.filter((event) => event.sql.startsWith("fetch forward 7000"))).toHaveLength(3);
    expect(scan.at(-1)!.sql).toMatch(/^close "resource_scan_/);
    expect(stages().filter((stage) => stage === "rows")).toHaveLength(3);
  });

  it("explains exactly the statements the engine runs", async () => {
    const requests: Array<[QueryRequestInput, boolean?]> = [
      [pageRequest()],
      [pageRequest({ pagination: { mode: "offset", pageIndex: 3, pageSize: 5, count: "none" } })],
      [
        pageRequest({
          pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "capped" },
          filters: [{ type: "condition", key: "status", operator: "is", value: "paid" }],
        }),
      ],
      [
        pageRequest({
          facets: [{ key: "status" }, { key: "region" }, { key: "customer.country" }],
        }),
      ],
      [pageRequest(), true],
      [pageRequest({ sorting: [{ key: "customer.name", dir: "asc" }] })],
      [
        pageRequest({
          pagination: { mode: "cursor", cursor: null, pageSize: 10, count: "none" },
          facets: [{ key: "status", mode: "include-self", limit: 3, missing: true }],
        }),
      ],
    ];
    const compared = new Set(["ids", "count", "facets", "summary"]);
    for (const [request, summary] of requests) {
      events.length = 0;
      await ordersResource.query({ request, summary });
      const ran = events
        .filter((event) => compared.has(event.stage))
        .map((event) => `${event.stage}: ${event.sql}`)
        .toSorted();
      const report = await ordersResource.explain({ request, summary });
      expect(report.stages.map((stage) => `${stage.stage}: ${stage.sql}`).toSorted()).toEqual(ran);
      expect(report.shape).toBe(events[0]!.shape);
      expect(report.shapeKey).toEqual(events[0]!.shapeKey);
    }
  });

  it("keeps parameter values out of every statement and shape", async () => {
    const secret = "zz-secret-value-731";
    const needle = "needle-secret-482";
    await ordersResource.query({
      request: pageRequest({
        filters: [
          { type: "condition", key: "status", operator: "is", value: secret },
          { type: "condition", key: "reference", operator: "contains", value: secret },
          {
            type: "condition",
            key: "amount",
            operator: "between",
            value: { from: 777_123, to: 888_456 },
          },
        ],
        search: { value: needle, fields: ["reference", "customer.name"] },
        facets: [{ key: "status" }],
      }),
      summary: true,
    });
    const first = await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "cursor", cursor: null, pageSize: 5, count: "none" },
      }),
    });
    const cursor = (first.pageInfo as { nextCursor: string }).nextCursor;
    await ordersResource.query({
      request: pageRequest({
        pagination: { mode: "cursor", cursor, pageSize: 5, count: "none" },
      }),
    });
    expect(events.length).toBeGreaterThan(6);
    for (const event of events) {
      const printed = JSON.stringify({ ...event, error: undefined });
      for (const value of [secret, needle, "777123", "888456", cursor]) {
        expect(printed).not.toContain(value);
      }
    }
    expect(
      events.filter((event) => event.stage === "ids").every((event) => event.sql.includes("$")),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.shape.includes("filter amount:between,reference:contains,status:is"),
      ),
    ).toBe(true);
  });

  it("gives the same shape to requests that differ only in their values", async () => {
    const shapes = new Set<string>();
    for (const [status, size, index] of [
      ["paid", 10, 1],
      ["new", 50, 2],
      ["x", 5, 3],
    ] as const) {
      events.length = 0;
      await ordersResource.query({
        request: pageRequest({
          pagination: { mode: "offset", pageIndex: index, pageSize: size, count: "exact" },
          filters: [{ type: "condition", key: "status", operator: "is", value: status }],
        }),
      });
      for (const event of events) shapes.add(event.shape);
    }
    expect([...shapes]).toEqual([
      "orders · filter status:is · sort createdAt desc · offset · count exact",
    ]);
  });

  it("leaves the scope out of the shape", async () => {
    await fixture.scopedResource.query({
      request: pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 5, count: "none" },
      }),
      context: { region: "eu" },
    });
    expect(events.at(0)!.shape).toBe("orders · sort createdAt desc · offset · count none");
  });

  it("never lets a hook that throws or rejects change a result or leak an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);
    try {
      const request = pageRequest({ facets: [{ key: "status" }] });
      hookMode = "ok";
      const baseline = await ordersResource.query({ request, summary: true });
      for (const mode of ["throw", "reject"] as const) {
        hookMode = mode;
        events.length = 0;
        expect(await ordersResource.query({ request, summary: true })).toEqual(baseline);
        // the hook ran for every statement, and every one of them failed
        expect(events.length).toBeGreaterThanOrEqual(4);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      hookMode = "ok";
      process.off("unhandledRejection", collect);
    }
    expect(unhandled).toEqual([]);
  });

  it("never lets a hook that throws change a result", async () => {
    const throwing = createQueryEngine({
      db: fixture.db,
      schema: { orders: fixture.orders } as never,
      relations: {} as never,
      onQuery: () => {
        throw new Error("hook failed");
      },
    });
    const rejecting = createQueryEngine({
      db: fixture.db,
      schema: { orders: fixture.orders } as never,
      relations: {} as never,
      onQuery: async () => {
        throw new Error("hook rejected");
      },
    });
    const request = pageRequest();
    const define = (engine: typeof throwing) =>
      engine.defineResource(
        "orders" as never,
        { query: { pagination: { modes: ["offset"] } } } as never,
      ) as any;
    const baseline = await define(
      createQueryEngine({
        db: fixture.db,
        schema: { orders: fixture.orders } as never,
        relations: {} as never,
      }),
    ).query({ request });
    expect(await define(throwing).query({ request })).toEqual(baseline);
    expect(await define(rejecting).query({ request })).toEqual(baseline);
  });

  it("reports a statement that times out with its error while the request degrades", async () => {
    const timed = fixture.engine.defineResource("orders", {
      query: { pagination: { modes: ["offset"] }, timeouts: { count: 40 } },
    });
    const locker = await fixture.client.connect();
    await locker.query("begin");
    const table = (fixture.orders as any)[Symbol.for("drizzle:Name")];
    const schemaName = (fixture.orders as any)[Symbol.for("drizzle:Schema")];
    await locker.query(`lock table "${schemaName}"."${table}" in access exclusive mode`);
    try {
      const pending = timed.query({ request: pageRequest() });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await locker.query("rollback");
      const result = await pending;
      expect(result.pageInfo).toMatchObject({ count: "none", reason: "timeout" });
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
    }
    const count = events.find((event) => event.stage === "count")!;
    expect(count.error).toMatchObject({ cause: { code: "57014" } });
    expect(count.rows).toBe(0);
  });
});

export type { QueryEvent };
void sql;
