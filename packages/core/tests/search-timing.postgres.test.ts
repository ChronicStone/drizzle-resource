import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { runTimed } from "../src/postgres.js";
import { parseDurationMilliseconds } from "../src/postgres.js";
import { createObserveFixture, pageRequest } from "./observe-fixture.js";

const fixture = createObserveFixture({ rows: 2_000 });

describe("statement_timeout parsing", () => {
  it("reads PostgreSQL's units", () => {
    expect(parseDurationMilliseconds("25ms")).toBe(25);
    expect(parseDurationMilliseconds("3s")).toBe(3_000);
    expect(parseDurationMilliseconds("1min")).toBe(60_000);
    expect(parseDurationMilliseconds("2h")).toBe(7_200_000);
    expect(parseDurationMilliseconds("500")).toBe(500);
    expect(parseDurationMilliseconds("garbage")).toBeUndefined();
  });
});

describe.skipIf(!fixture.connectionString)(
  "the timed run and the capped count on PostgreSQL",
  () => {
    beforeAll(() => fixture.setup(), 120_000);
    afterAll(() => fixture.teardown(), 60_000);

    it("takes the timeout in force from what set_config reports, in PostgreSQL's units", async () => {
      // A connection whose timeout is 3 s while the budget asks for 60 s: the 3 s applies, and it
      // is only known by reading `set_config`'s answer ("3s") as a number of milliseconds.
      const pool = new Pool({ connectionString: fixture.connectionString, max: 1 });
      try {
        const db = drizzle({ client: pool, relations: fixture.relationsGraph });
        await pool.query("set statement_timeout = '3s'");
        const outcome = await runTimed(db as never, 60_000, async () => 1, { capToCurrent: true });
        expect(outcome).toMatchObject({ kind: "ok", effective: 3_000 });
        await pool.query("set statement_timeout = '1min'");
        const minute = await runTimed(db as never, 100_000, async () => 1, { capToCurrent: true });
        expect(minute).toMatchObject({ kind: "ok", effective: 60_000 });
        await pool.query("set statement_timeout = 0");
        const none = await runTimed(db as never, 100_000, async () => 1, { capToCurrent: true });
        expect(none).toMatchObject({ kind: "ok", effective: 100_000 });
      } finally {
        await pool.end();
      }
    });

    it("starts its clock once the timeout is set, not while it waits for a connection", async () => {
      // One connection, busy for 300 ms. The statement then cancels itself at 50 ms, before the 100 ms
      // timeout: that is not the timeout running out. A clock that started before `set_config`
      // would read 350 ms and call it one.
      const pool = new Pool({ connectionString: fixture.connectionString, max: 1 });
      try {
        const db = drizzle({ client: pool, relations: fixture.relationsGraph });
        const busy = pool.query("select pg_sleep(0.3)");
        const outcome = await runTimed(
          db as never,
          100,
          async (tx) => {
            await (tx as any).execute("set local statement_timeout = '50ms'");
            await (tx as any).execute("select pg_sleep(1)");
          },
          {},
        );
        await busy;
        expect(outcome.kind).toBe("cancelled");
        expect(outcome.elapsed).toBeLessThan(95);
      } finally {
        await pool.end();
      }
    });

    it("calls a capped count exact when it found exactly the cap, and not when it found more", async () => {
      const n = 11;
      const request = pageRequest({
        pagination: { mode: "offset", pageIndex: 1, pageSize: 5, count: "capped" },
        filters: [{ type: "condition", key: "id", operator: "between", value: { from: 1, to: n } }],
      });
      const withCap = (countCap: number) =>
        fixture.engine.defineResource("orders", {
          query: { pagination: { modes: ["offset"], countCap } },
        });
      const atCap = await withCap(n).query({ request });
      expect(atCap.pageInfo).toMatchObject({ count: "capped", rowCount: n, exact: true });
      const belowCap = await withCap(n - 1).query({ request });
      expect(belowCap.pageInfo).toMatchObject({ count: "capped", rowCount: n - 1, exact: false });
      const aboveCap = await withCap(n + 1).query({ request });
      expect(aboveCap.pageInfo).toMatchObject({ count: "capped", rowCount: n, exact: true });
    });
  },
);
