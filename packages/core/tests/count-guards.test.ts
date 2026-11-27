import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import { isOurTimeout, parseDurationMilliseconds, withStatementTimeout } from "../src/postgres.js";
import type { QueryPageInfo, QueryRequestInput } from "../index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const namespace = pgSchema(`resource_guards_${randomUUID().replaceAll("-", "")}`);
const accounts = namespace.table("accounts", {
  id: integer().primaryKey(),
  name: text().notNull(),
});
const docs = namespace.table("docs", {
  id: integer().primaryKey(),
  org: text().notNull(),
  title: text().notNull(),
  accountId: integer(),
});
const labels = namespace.table("labels", {
  id: integer().primaryKey(),
  docId: integer().notNull(),
  label: text().notNull(),
});
// `code` is not unique, so joining it repeats a doc once per matching row.
const cats = namespace.table("cats", {
  id: integer().primaryKey(),
  code: text().notNull(),
  label: text().notNull(),
});
const schema = { accounts, docs, labels, cats };
const relations = defineRelations(schema, (r) => ({
  docs: {
    account: r.one.accounts({ from: r.docs.accountId, to: r.accounts.id }),
    labels: r.many.labels({ from: r.docs.id, to: r.labels.docId }),
    byCat: r.one.cats({ from: r.docs.org, to: r.cats.code }),
  },
}));
const client = new Pool({ connectionString, max: 12 });
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

const capped = engine.defineResource("docs", {
  relations: { account: true, labels: true },
  query: {
    pagination: { modes: ["offset", "cursor"], countCap: 10 },
    facets: { allowed: ["org", "account.name"] },
    scope: (filters) => filters.is("org", "a"),
  },
});
const skipping = engine.defineResource("docs", {
  relations: { account: true },
  query: {
    pagination: { modes: ["offset"], countCap: 10 },
    facets: { allowed: ["accountId", "account.name"], whenCapped: "skip" },
    scope: (filters) => filters.is("org", "a"),
  },
});
// Equality on a text column is compiled to lower(column) = $1, which PostgreSQL cannot estimate,
// so the estimated tests use an unscoped resource filtered on a numeric column.
const estimating = engine.defineResource("docs", {
  relations: { account: true },
  query: {
    pagination: { modes: ["offset"], countCap: 10 },
    facets: { allowed: ["accountId"], whenCapped: "skip" },
  },
});
const timed = engine.defineResource("docs", {
  relations: { account: true },
  summary: () => ({ total: sql<number>`count(*)`.mapWith(Number) }),
  query: {
    pagination: { modes: ["offset"] },
    facets: { allowed: ["accountId"] },
    timeouts: { count: 100, facets: 100, summary: 100 },
  },
});
const skippingTimed = engine.defineResource("docs", {
  query: {
    pagination: { modes: ["offset"], countCap: 10 },
    facets: { allowed: ["accountId"], whenCapped: "skip" },
    timeouts: { count: 100 },
  },
});
const manyFacets = engine.defineResource("docs", {
  relations: { account: true, labels: true },
  query: {
    pagination: { modes: ["offset"], countCap: 10 },
    facets: { allowed: ["org", "accountId", "account.name", "labels.label"] },
    timeouts: { count: 100, facets: 100 },
  },
});
// Generous stage timeouts for the tests that must finish in time on a loaded machine.
const roomy = engine.defineResource("docs", {
  summary: () => ({ total: sql<number>`count(*)`.mapWith(Number) }),
  query: {
    pagination: { modes: ["offset"] },
    facets: { allowed: ["accountId"] },
    timeouts: { count: 30_000, facets: 30_000, summary: 30_000 },
  },
});
const guarded = engine.defineResource("docs", {
  query: { pagination: { modes: ["offset"] }, validation: { maxPageIndex: 3 } },
});

function request(
  pagination: Partial<Extract<QueryRequestInput["pagination"], { mode?: "offset" }>> = {},
  extra: Partial<QueryRequestInput> = {},
): QueryRequestInput {
  return {
    pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "capped", ...pagination },
    filters: [],
    search: { value: "", fields: [] },
    sorting: [{ key: "id", dir: "asc" }],
    ...extra,
  };
}

/** Poll until `count` sessions wait on a lock; resolves with how many do when time runs out. */
async function waitForLockWaiters(count: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  while (Date.now() < deadline) {
    const [row] = await db.execute(
      sql`select count(*)::int as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database()`,
      "objects",
    );
    waiting = Number((row as { waiting: number }).waiting);
    if (waiting >= count) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return waiting;
}

/** Create pg_trgm once, even when another test file creates it at the same moment. */
async function ensureTrigramExtension() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.execute(sql`create extension if not exists pg_trgm`);
      return;
    } catch (error) {
      const [row] = await db.execute(
        sql`select 1 as present from pg_extension where extname = 'pg_trgm'`,
        "objects",
      );
      if (row) return;
      if (attempt === 4) throw error;
    }
  }
}

/** Holds a lock that makes every statement on `docs` wait, so a timeout is deterministic. */
async function withBlockedDocs<T>(
  run: (release: () => Promise<void>) => Promise<T>,
  table = `"${namespace.schemaName}"."docs"`,
  holdMs = 600,
) {
  const locker = await client.connect();
  await locker.query("begin");
  await locker.query(`lock table ${table} in access exclusive mode`);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    // Let a statement reach the lock, then keep holding it well past every timeout in these
    // tests, so a slow machine cannot release the table before a timeout fires.
    await waitForLockWaiters(1, 5000);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await locker.query("rollback");
    locker.release();
  };
  try {
    return await run(release);
  } finally {
    await release();
  }
}

describe.skipIf(!connectionString)("count modes and guards", () => {
  beforeAll(async () => {
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(sql`create table ${accounts} (id integer primary key, name text not null)`);
    await db.execute(sql`create table ${docs} (
      id integer primary key, org text not null, title text not null, "accountId" integer
    )`);
    await db.execute(sql`create table ${labels} (
      id integer primary key, "docId" integer not null, label text not null
    )`);
    await db.insert(accounts).values([
      { id: 1, name: "Odd" },
      { id: 2, name: "Even" },
    ]);
    // 25 rows in org "a" (ids 1..25) and 3 in org "b".
    await db.execute(sql`
      insert into ${docs} (id, org, title, "accountId")
      select n, case when n <= 25 then 'a' else 'b' end, 'doc ' || n, 1 + n % 2
      from generate_series(1, 28) as n
    `);
    await db.execute(
      sql`create table ${cats} (id integer primary key, code text not null, label text not null)`,
    );
    await db.insert(cats).values([
      { id: 1, code: "a", label: "x" },
      { id: 2, code: "a", label: "y" },
      { id: 3, code: "b", label: "x" },
    ]);
    await db.insert(labels).values([
      { id: 1, docId: 1, label: "red" },
      { id: 2, docId: 1, label: "red" },
      { id: 3, docId: 2, label: "red" },
    ]);
    await db.execute(sql`analyze ${docs}`);
    statements.length = 0;
  });

  afterAll(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
    await client.end();
  });

  describe("capped count", () => {
    it("reports an exact count while the matches fit under the cap", async () => {
      const result = await capped.queryIds({
        request: request(
          {},
          {
            filters: [{ type: "condition", key: "id", operator: "isAnyOf", value: [1, 2, 3, 4] }],
          },
        ),
      });
      expect(result.pageInfo).toEqual({
        mode: "offset",
        pageIndex: 1,
        pageSize: 10,
        hasNextPage: false,
        count: "capped",
        rowCount: 4,
        exact: true,
      });
    });

    it("stops counting at the cap and says the count is not exact", async () => {
      const result = await capped.queryIds({ request: request() });
      expect(result.ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.pageInfo).toEqual({
        mode: "offset",
        pageIndex: 1,
        pageSize: 10,
        hasNextPage: true,
        count: "capped",
        rowCount: 10,
        exact: false,
      });
    });

    it("counts one row past the cap in SQL, not the whole table", async () => {
      statements.length = 0;
      await capped.queryIds({ request: request() });
      const count = statements.find((query) => query.includes("capped_matching_ids"));
      expect(count).toBeDefined();
      expect(count).toContain("limit");
      expect(count).not.toContain("count(distinct");
    });

    it("reads hasNextPage from a lookahead row while the count is capped", async () => {
      const second = await capped.queryIds({ request: request({ pageIndex: 2 }) });
      expect(second.ids).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(second.pageInfo).toMatchObject({ hasNextPage: true, count: "capped", exact: false });
      const last = await capped.queryIds({ request: request({ pageIndex: 3 }) });
      expect(last.ids).toEqual([21, 22, 23, 24, 25]);
      expect(last.pageInfo).toMatchObject({ hasNextPage: false, count: "capped", exact: false });
    });

    it("returns an empty page without a second statement when nothing matches", async () => {
      const result = await capped.queryIds({
        request: request(
          {},
          {
            filters: [{ type: "condition", key: "title", operator: "is", value: "nothing" }],
          },
        ),
      });
      expect(result.ids).toEqual([]);
      expect(result.pageInfo).toMatchObject({
        count: "capped",
        rowCount: 0,
        exact: true,
        hasNextPage: false,
      });
    });

    it("counts distinct roots when a to-many relation repeats them", async () => {
      const result = await capped.queryIds({
        request: request(
          {},
          {
            filters: [{ type: "condition", key: "labels.label", operator: "is", value: "red" }],
          },
        ),
      });
      expect(result.ids).toEqual([1, 2]);
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 2, exact: true });
    });

    it("works with cursor pages", async () => {
      const first = await capped.queryIds({
        request: {
          ...request(),
          pagination: { mode: "cursor", cursor: null, pageSize: 10, count: "capped" },
        },
      });
      expect(first.pageInfo).toMatchObject({
        mode: "cursor",
        count: "capped",
        rowCount: 10,
        exact: false,
      });
      expect((first.pageInfo as { nextCursor: string | null }).nextCursor).not.toBeNull();
    });

    it("lets a resource default to a capped count", async () => {
      const defaulted = engine.defineResource("docs", {
        query: {
          pagination: { modes: ["offset"], countCap: 5 },
          defaults: { pagination: { mode: "offset", count: "capped" } },
        },
      });
      const result = await defaulted.queryIds({
        request: {
          pagination: { pageIndex: 1, pageSize: 2 },
          filters: [],
          search: { value: "", fields: [] },
          sorting: [],
        },
      });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 5, exact: false });
    });

    it("uses a cap of 10,000 when the resource sets none", async () => {
      const plain = engine.defineResource("docs", { query: { pagination: { modes: ["offset"] } } });
      const result = await plain.queryIds({ request: request() });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 28, exact: true });
    });

    it.each([0, -1, 1.5])("rejects a count cap of %s", (countCap) => {
      expect(() => engine.defineResource("docs", { query: { pagination: { countCap } } })).toThrow(
        "Count cap",
      );
    });
  });

  describe("capped count over a join that repeats roots", () => {
    const repeating = engine.defineResource("docs", {
      relations: { byCat: true },
      query: { pagination: { modes: ["offset"], countCap: 20 } },
    });
    const onLabel = {
      filters: [
        {
          type: "condition" as const,
          key: "byCat.label",
          operator: "isAnyOf" as const,
          value: ["x", "y"],
        },
      ],
    };

    it("counts each root once, as the exact count does", async () => {
      const exact = await repeating.queryIds({ request: request({ count: "exact" }, onLabel) });
      expect(exact.pageInfo).toMatchObject({ count: "exact", rowCount: 28 });
      const uncapped = engine.defineResource("docs", {
        relations: { byCat: true },
        query: { pagination: { modes: ["offset"], countCap: 100 } },
      });
      const result = await uncapped.queryIds({ request: request({ count: "capped" }, onLabel) });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 28, exact: true });
    });

    it("stops at the cap through the distinct branch", async () => {
      statements.length = 0;
      const result = await repeating.queryIds({ request: request({ count: "capped" }, onLabel) });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 20, exact: false });
      expect(
        statements.some(
          (query) => query.includes("capped_matching_ids") && query.includes("distinct"),
        ),
      ).toBe(true);
    });
  });

  describe("estimated count", () => {
    it("uses the planner estimate when it is above the cap", async () => {
      const result = await estimating.queryIds({ request: request({ count: "estimated" }) });
      expect(result.pageInfo).toMatchObject({ count: "estimated", hasNextPage: true });
      expect((result.pageInfo as { rowCount: number }).rowCount).toBe(28);
      expect(result.ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("looks ahead for the next page because an estimate proves nothing", async () => {
      const result = await estimating.queryIds({
        request: request({ count: "estimated", pageIndex: 3 }),
      });
      expect(result.ids).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
      expect(result.pageInfo).toMatchObject({ count: "estimated", hasNextPage: false });
    });

    it("falls back to a capped count when a filter goes through a relation", async () => {
      const result = await capped.queryIds({
        request: request(
          { count: "estimated" },
          {
            filters: [{ type: "condition", key: "account.name", operator: "is", value: "Odd" }],
          },
        ),
      });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 10, exact: false });
    });

    it("falls back to a capped count when the planner cannot estimate the filter", async () => {
      // lower(org) = $1 has no statistics, so the estimate is tiny whatever the data holds.
      const result = await capped.queryIds({ request: request({ count: "estimated" }) });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 10, exact: false });
    });

    it("falls back to a capped count when the estimate is small", async () => {
      const result = await capped.queryIds({
        request: request(
          { count: "estimated" },
          {
            filters: [{ type: "condition", key: "id", operator: "is", value: 3 }],
          },
        ),
      });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 1, exact: true });
    });
  });

  describe("exact and none keep their behavior", () => {
    it("still returns exact counts", async () => {
      const result = await capped.queryIds({ request: request({ count: "exact" }) });
      expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 25, hasNextPage: true });
    });

    it("still looks ahead without a count", async () => {
      const result = await capped.queryIds({ request: request({ count: "none" }) });
      expect(result.pageInfo).toMatchObject({ count: "none", rowCount: null, hasNextPage: true });
    });
  });

  describe("facets when the count is capped", () => {
    const facets = [{ key: "accountId" as const }];

    it("skips facets once the cap is hit and says so", async () => {
      statements.length = 0;
      const result = await skipping.query({ request: request({}, { facets }) });
      expect(result.pageInfo).toMatchObject({ count: "capped", exact: false });
      expect(result.facets).toEqual([
        { key: "accountId", status: "skipped", reason: "above-cap", options: [] },
      ]);
      expect(statements.some((query) => query.includes("group by"))).toBe(false);
    });

    it("still computes facets when the matches fit under the cap", async () => {
      const result = await skipping.query({
        request: request(
          {},
          {
            facets,
            filters: [{ type: "condition", key: "id", operator: "isAnyOf", value: [1, 2, 3] }],
          },
        ),
      });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 3, exact: true });
      expect(result.facets).toEqual([
        {
          key: "accountId",
          status: "ok",
          options: [
            { value: 2, count: 2 },
            { value: 1, count: 1 },
          ],
          nextCursor: undefined,
          total: 2,
        },
      ]);
    });

    it("skips facets above an estimated count too", async () => {
      const result = await estimating.query({
        request: request({ count: "estimated" }, { facets }),
      });
      expect(result.pageInfo).toMatchObject({ count: "estimated" });
      expect(result.facets?.[0]).toMatchObject({ status: "skipped", reason: "above-cap" });
    });

    it("never skips facets for an exact count", async () => {
      const result = await skipping.query({ request: request({ count: "exact" }, { facets }) });
      expect(result.facets?.[0]).toMatchObject({ status: "ok" });
    });

    it("runs facets by default even when the cap is hit", async () => {
      const result = await capped.query({
        request: request({}, { facets: [{ key: "account.name" }] }),
      });
      expect(result.pageInfo).toMatchObject({ count: "capped", exact: false });
      expect(result.facets?.[0]).toMatchObject({ status: "ok" });
      expect(result.facets?.[0]?.options).toEqual([
        { value: "Even", count: 13 },
        { value: "Odd", count: 12 },
      ]);
    });

    it("marks facets resolved by queryFacets as ok", async () => {
      const result = await capped.queryFacets({ request: request(), facets: [{ key: "org" }] });
      expect(result.facets[0]).toMatchObject({ key: "org", status: "ok" });
    });

    it.each(["sometimes", 1])("rejects whenCapped %s", (whenCapped) => {
      expect(() =>
        engine.defineResource("docs", { query: { facets: { whenCapped: whenCapped as never } } }),
      ).toThrow("whenCapped");
    });
  });

  describe("maxPageIndex", () => {
    it("accepts the last allowed page and rejects the next one", async () => {
      await expect(
        guarded.queryIds({ request: request({ pageIndex: 3, count: "none" }) }),
      ).resolves.toMatchObject({ ids: [21, 22, 23, 24, 25, 26, 27, 28] });
      await expect(
        guarded.queryIds({ request: request({ pageIndex: 4, count: "none" }) }),
      ).rejects.toThrow("Page index cannot exceed 3");
    });

    it("does not limit cursor pages", async () => {
      const both = engine.defineResource("docs", {
        query: {
          pagination: { modes: ["offset", "cursor"] },
          validation: { maxPageIndex: 1 },
        },
      });
      await expect(
        both.queryIds({
          request: {
            ...request(),
            pagination: { mode: "cursor", cursor: null, pageSize: 5, count: "none" },
          },
        }),
      ).resolves.toMatchObject({ ids: [1, 2, 3, 4, 5] });
    });

    it("is unlimited by default", async () => {
      await expect(
        capped.queryIds({ request: request({ pageIndex: 5000, count: "none" }) }),
      ).resolves.toMatchObject({ ids: [] });
    });

    it("is also enforced for trusted executions and facets", async () => {
      await expect(
        guarded.query({ request: request({ pageIndex: 9, count: "none" }) }),
      ).rejects.toThrow("Page index cannot exceed 3");
    });
  });

  describe("timeouts", () => {
    it("adds no transaction or setting when no timeout is configured", async () => {
      statements.length = 0;
      await capped.queryIds({ request: request({ count: "exact" }) });
      expect(statements.some((query) => /set_config|^begin/.test(query))).toBe(false);
    });

    it("degrades a slow count to no count and still returns the page", async () => {
      const result = await withBlockedDocs(async (release) => {
        const pending = timed.queryIds({ request: request({ count: "exact" }) });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await release();
        return pending;
      });
      expect(result.ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.pageInfo).toEqual({
        mode: "offset",
        pageIndex: 1,
        pageSize: 10,
        hasNextPage: true,
        count: "none",
        rowCount: null,
        reason: "timeout",
      });
    });

    it("degrades a slow capped count the same way", async () => {
      const result = await withBlockedDocs(async (release) => {
        const pending = timed.queryIds({ request: request({ count: "capped" }) });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await release();
        return pending;
      });
      expect(result.pageInfo).toMatchObject({ count: "none", rowCount: null, reason: "timeout" });
    });

    it("degrades slow facets to empty timeout facets", async () => {
      const result = await withBlockedDocs(async (release) => {
        const pending = timed.query({
          request: request({ count: "none" }, { facets: [{ key: "accountId" }] }),
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await release();
        return pending;
      });
      expect(result.facets).toEqual([{ key: "accountId", status: "timeout", options: [] }]);
      expect(result.rows).toHaveLength(10);
    });

    it("degrades a slow summary to null values with summaryStatus timeout", async () => {
      const result = await withBlockedDocs(async (release) => {
        const pending = timed.query({ request: request({ count: "none" }), summary: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await release();
        return pending;
      });
      expect(result.summaryStatus).toBe("timeout");
      expect(result.summary).toEqual({ total: null });
      expect(result.rows).toHaveLength(10);
    });

    it("keeps results unchanged when the stage finishes in time", async () => {
      const result = await roomy.query({
        request: request({ count: "exact" }, { facets: [{ key: "accountId" }] }),
        summary: true,
      });
      expect(result.summaryStatus).toBe("ok");
      expect(result.summary).toEqual({ total: 28 });
      expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 28 });
      expect(result.facets?.[0]).toMatchObject({ status: "ok" });
    });

    const groups = [
      [{ key: "org" as const }, { key: "accountId" as const }],
      [{ key: "account.name" as const }, { key: "labels.label" as const }],
      [
        { key: "org" as const, missing: true },
        { key: "accountId" as const, missing: true },
      ],
    ];

    it.each(groups)(
      "sets no statement timeout in a caller's transaction and leaves it usable: %j",
      async (...facets) => {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('statement_timeout', '9000', true)`);
          statements.length = 0;
          const result = await manyFacets.query({
            db: tx as never,
            request: request({ count: "capped" }, { facets }),
          });
          expect(result.pageInfo).toMatchObject({ count: "capped" });
          expect(result.facets?.map((facet) => facet.status)).toEqual(facets.map(() => "ok"));
          expect(statements.some((query) => query.includes("set_config"))).toBe(false);
          expect(statements.some((query) => /savepoint/i.test(query))).toBe(false);
          const [row] = await tx.execute(sql`show statement_timeout`, "objects");
          expect(row).toEqual({ statement_timeout: "9s" });
        });
      },
    );

    it("does not time a stage in a caller's transaction: it waits for the table instead", async () => {
      await db.transaction(async (tx) => {
        const result = await withBlockedDocs(async (release) => {
          const pending = manyFacets.query({
            db: tx as never,
            request: request({ count: "capped" }, { facets: [{ key: "org" }] }),
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          await release();
          return pending;
        });
        expect(result.pageInfo).toMatchObject({ count: "capped" });
        expect(result.facets?.[0]).toMatchObject({ status: "ok" });
      });
    });

    it("reads the timeout in force as PostgreSQL prints it", () => {
      expect(parseDurationMilliseconds("25")).toBe(25);
      expect(parseDurationMilliseconds("25ms")).toBe(25);
      expect(parseDurationMilliseconds("3s")).toBe(3000);
      expect(parseDurationMilliseconds("1min")).toBe(60_000);
      expect(parseDurationMilliseconds("0")).toBe(0);
      expect(parseDurationMilliseconds("soon")).toBeUndefined();
    });

    it("measures a timeout by elapsed time, not by the server's message", () => {
      const french = Object.assign(new Error("annulation de la requête à cause du délai écoulé"), {
        code: "57014",
      });
      expect(isOurTimeout(french, 50, 40)).toBe(true);
      expect(isOurTimeout(new Error("Failed query", { cause: french }), 40, 40)).toBe(true);
      expect(isOurTimeout(french, 36, 40)).toBe(true); // within the margin
      expect(isOurTimeout(french, 10, 40)).toBe(false);
      expect(isOurTimeout(new Error("annulation"), 500, 40)).toBe(false);
      expect(isOurTimeout(Object.assign(new Error("x"), { code: "23505" }), 500, 40)).toBe(false);
    });

    it("reports a real timeout and rethrows a cancel from elsewhere", async () => {
      const slow = await withStatementTimeout(db as never, 30, async (tx) => {
        await (tx as typeof db).execute(sql`select pg_sleep(2)`);
      });
      expect(slow).toEqual({ timedOut: true });

      await expect(
        withStatementTimeout(db as never, 5000, async (tx) => {
          const [pid] = await (tx as typeof db).execute(
            sql`select pg_backend_pid() as pid`,
            "objects",
          );
          setTimeout(async () => {
            await db.execute(sql`select pg_cancel_backend(${(pid as { pid: number }).pid})`);
          }, 100);
          await (tx as typeof db).execute(sql`select pg_sleep(3)`);
        }),
      ).rejects.toThrow("Failed query");
    });

    it("caps the budget at the setting already in force", async () => {
      const read = (database: typeof db, ms: number) =>
        withStatementTimeout(
          database as never,
          ms,
          async (tx) => {
            const [row] = await (tx as typeof db).execute(sql`show statement_timeout`, "objects");
            return (row as { statement_timeout: string }).statement_timeout;
          },
          { capToCurrent: true },
        );
      // The defaults are far above anything a statement here needs, so only the cap is measured.
      expect(await read(db, 3000)).toEqual({ timedOut: false, value: "3s" });
      const strict = new Pool({ connectionString, max: 1, options: "-c statement_timeout=1000" });
      const lenient = new Pool({ connectionString, max: 1, options: "-c statement_timeout=60000" });
      try {
        const strictDb = drizzle({ client: strict, relations });
        const lenientDb = drizzle({ client: lenient, relations });
        expect(await read(strictDb, 3000)).toEqual({ timedOut: false, value: "1s" });
        expect(await read(lenientDb, 3000)).toEqual({ timedOut: false, value: "3s" });
      } finally {
        await strict.end();
        await lenient.end();
      }
    });

    it("holds at most one connection per facet statement while facets are timed", async () => {
      const facets = [
        { key: "org" as const, missing: true },
        { key: "accountId" as const },
        { key: "account.name" as const },
        { key: "labels.label" as const },
      ];
      const waiting = await withBlockedDocs(async (release) => {
        const pending = manyFacets.query({ request: request({ count: "none" }, { facets }) });
        const waitingNow = await waitForLockWaiters(2, 5000);
        await release();
        await pending;
        return waitingNow;
      });
      // Each facet statement waits in a transaction of its own, so they still run in parallel.
      expect(waiting).toBeGreaterThanOrEqual(2);
      expect(waiting).toBeLessThanOrEqual(facets.length + 1);
    });

    it("skips facets when the count times out under whenCapped skip", async () => {
      const result = await withBlockedDocs(async (release) => {
        const pending = skippingTimed.query({
          request: request({ count: "capped" }, { facets: [{ key: "accountId" }] }),
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await release();
        return pending;
      });
      expect(result.pageInfo).toMatchObject({ count: "none", reason: "timeout" });
      expect(result.facets).toEqual([
        { key: "accountId", status: "skipped", reason: "above-cap", options: [] },
      ]);
    });

    it.each([0, -5, 2.5])("rejects a timeout of %s", (value) => {
      expect(() =>
        engine.defineResource("docs", { query: { timeouts: { count: value } } }),
      ).toThrow("timeout");
    });
  });

  describe("search plan without an exact count", () => {
    const plansNamespace = pgSchema(`resource_plan_${randomUUID().replaceAll("-", "")}`);
    const owners = plansNamespace.table("owners", {
      id: integer().primaryKey(),
      name: text().notNull(),
    });
    const notes = plansNamespace.table("notes", {
      id: integer().primaryKey(),
      body: text().notNull(),
      ownerId: integer().notNull(),
    });
    const planSchema = { owners, notes };
    const planRelations = defineRelations(planSchema, (r) => ({
      notes: { owner: r.one.owners({ from: r.notes.ownerId, to: r.owners.id }) },
    }));
    const planStatements: string[] = [];
    // What the engine did, in order: `t<ms>` is a budgeted `statement_timeout`, `T<ms>` a
    // resource timeout, `C:`/`P:` the count and the page statement, then `O` for the ordinary
    // plan or `U` for the indexed one.
    const events: string[] = [];
    const planDb = drizzle({
      client,
      relations: planRelations,
      logger: {
        logQuery(query, params) {
          planStatements.push(query);
          if (query.includes("set_config('statement_timeout'")) {
            events.push(`${query.includes("least(") ? "t" : "T"}${String(params[0])}`);
          } else if (query.includes('"notes"') && !query.startsWith("explain")) {
            if (query.includes("count(*)"))
              events.push(`C:${query.includes(" union ") ? "U" : "O"}`);
            else if (query.includes('"notes"."id"'))
              events.push(`P:${query.includes(" union ") ? "U" : "O"}`);
          }
        },
      },
    });
    const search = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: { search: { allowed: ["body", "owner.name"], planBudget: 300 } },
    });
    const roomySearch = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: { search: { allowed: ["body", "owner.name"], planBudget: 30_000 } },
    });
    const blockedNotes = () => `"${plansNamespace.schemaName}"."notes"`;
    const afterBlocked = (run: () => Promise<unknown>, holdMs = 600, settleMs = 400) =>
      withBlockedDocs(
        async (release) => {
          const pending = run();
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          await release();
          return pending;
        },
        blockedNotes(),
        holdMs,
      );
    // A budget of 100 ms gives the indexed attempt 400 ms.
    const tightSearch = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: { search: { allowed: ["body", "owner.name"], planBudget: 100 } },
    });

    // A budget of 300 ms gives the indexed attempt 1,200 ms; these tests need room between them.
    const midSearch = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: { search: { allowed: ["body", "owner.name"], planBudget: 300 } },
    });
    const countCut = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: {
        search: { allowed: ["body", "owner.name"], planBudget: 300 },
        timeouts: { count: 150 },
      },
    });

    beforeAll(async () => {
      await ensureTrigramExtension();
      await db.execute(sql`create schema ${sql.identifier(plansNamespace.schemaName)}`);
      await db.execute(sql`create table ${owners} (id integer primary key, name text not null)`);
      await db.execute(sql`create table ${notes} (
        id integer primary key, body text not null, "ownerId" integer not null
      )`);
      await db.execute(sql`create index on ${notes} using gin (lower(body) gin_trgm_ops)`);
      await db.execute(sql`create index on ${owners} using gin (lower(name) gin_trgm_ops)`);
      await db.execute(
        sql`insert into ${owners} select n, 'owner ' || n from generate_series(1, 12100) as n`,
      );
      // 12,100 notes: every body holds "common"; three also hold "zebra".
      await db.execute(sql`
        insert into ${notes}
        select n, 'common note ' || n || case when n in (5, 600, 12000) then ' zebra' else '' end, n
        from generate_series(1, 12100) as n
      `);
      await db.execute(sql`analyze ${notes}`);
      await db.execute(sql`analyze ${owners}`);
    });

    afterAll(async () => {
      await db.execute(
        sql`drop schema if exists ${sql.identifier(plansNamespace.schemaName)} cascade`,
      );
    });

    function searching(value: string, count: "none" | "capped" | "estimated" | "exact") {
      return {
        pagination: { mode: "offset" as const, pageIndex: 1, pageSize: 5, count },
        filters: [],
        search: { value, fields: ["body", "owner.name"] },
        sorting: [{ key: "id", dir: "asc" as const }],
      };
    }

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Every statement on `notes` waits for `locker`; resolves once a statement is waiting. */
    async function lockNotes() {
      const locker = await client.connect();
      await locker.query("begin");
      await locker.query(`lock table ${blockedNotes()} in access exclusive mode`);
      return locker;
    }

    it("keeps the ordinary plan for a common term, one budgeted statement", async () => {
      planStatements.length = 0;
      events.length = 0;
      const result = await roomySearch.queryIds({ request: searching("common", "none") });
      expect(result.ids).toEqual([1, 2, 3, 4, 5]);
      expect(result.pageInfo).toMatchObject({ count: "none", hasNextPage: true });
      expect(events).toEqual(["t30000", "P:O"]);
      expect(planStatements.some((query) => query.startsWith("explain"))).toBe(false);
    });

    it.each(["capped", "estimated"] as const)(
      "budgets the count and the page on their own, with a %s count",
      async (count) => {
        events.length = 0;
        const result = await roomySearch.query({ request: searching("common", count) });
        expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
        expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 10_000, exact: false });
        expect(events).toEqual(["t30000", "C:O", "t30000", "P:O"]);
      },
    );

    it("retries with the indexed plan, under a larger budget, when the ordinary plan runs out", async () => {
      events.length = 0;
      const result = (await afterBlocked(() =>
        search.queryIds({ request: searching("zebra", "none") }),
      )) as Awaited<ReturnType<typeof search.queryIds>>;
      expect(result.ids).toEqual([5, 600, 12000]);
      expect(result.pageInfo).toMatchObject({ count: "none", hasNextPage: false });
      expect(events).toEqual(["t300", "P:O", "t1200", "P:U"]);
    });

    it("goes back to the ordinary plan with no budget when the indexed attempt misses too", async () => {
      // A busy server: the statement waits past the first budget (100 ms) and the second (400 ms).
      events.length = 0;
      const result = (await afterBlocked(
        () => tightSearch.queryIds({ request: searching("common", "none") }),
        1500,
      )) as Awaited<ReturnType<typeof tightSearch.queryIds>>;
      expect(result.ids).toEqual([1, 2, 3, 4, 5]);
      expect(result.pageInfo).toMatchObject({ count: "none", hasNextPage: true });
      expect(events).toEqual(["t100", "P:O", "t400", "P:U", "P:O"]);
    });

    it("keeps the indexed plan when the indexed attempt fits its larger budget", async () => {
      events.length = 0;
      const result = (await afterBlocked(
        () => tightSearch.queryIds({ request: searching("zebra", "none") }),
        250,
        0,
      )) as Awaited<ReturnType<typeof tightSearch.queryIds>>;
      expect(result.ids).toEqual([5, 600, 12000]);
      expect(events).toEqual(["t100", "P:O", "t400", "P:U"]);
    });

    it("gives the page its own budgeted attempts after a count that went indexed", async () => {
      events.length = 0;
      // The count waits on the first lock and finishes on the indexed plan within its larger
      // budget. A second lock, queued behind the count, then holds up the page.
      const first = await lockNotes();
      const pending = midSearch.query({ request: searching("common", "capped") });
      await waitForLockWaiters(1, 5000);
      await wait(600); // the count's ordinary attempt (300 ms) has missed; its indexed one waits
      const second = await client.connect();
      await second.query("begin");
      const acquiring = second.query(`lock table ${blockedNotes()} in access exclusive mode`);
      await waitForLockWaiters(2, 5000); // the count's statement and this request
      await first.query("rollback"); // the count is first in line; this lock is granted after it
      first.release();
      await acquiring;
      await wait(2200); // past both of the page's budgets (300 ms, then 1,200 ms)
      await second.query("rollback");
      second.release();
      const result = await pending;
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 10_000, exact: false });
      expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
      expect(events).toEqual(["t300", "C:O", "t1200", "C:U", "t300", "P:O", "t1200", "P:U", "P:O"]);
    });

    it("starts the page on the indexed plan when the capped count fits under its cap", async () => {
      events.length = 0;
      const result = (await afterBlocked(() =>
        midSearch.query({ request: searching("zebra", "capped") }),
      )) as Awaited<ReturnType<typeof midSearch.query>>;
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 3, exact: true });
      expect(result.rows.map((row) => row.id)).toEqual([5, 600, 12000]);
      // The count pays the ordinary attempt once; the page skips it and runs the indexed plan.
      expect(events).toEqual(["t300", "C:O", "t1200", "C:U", "t1200", "P:U"]);
    });

    it("starts the page on the ordinary plan when the capped count hit its cap", async () => {
      events.length = 0;
      const result = await roomySearch.query({ request: searching("common", "capped") });
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 10_000, exact: false });
      expect(events).toEqual(["t30000", "C:O", "t30000", "P:O"]);
    });

    it("bounds the indexed page too: past 4x the budget it returns to the ordinary plan", async () => {
      events.length = 0;
      const first = await lockNotes();
      const pending = midSearch.query({ request: searching("zebra", "capped") });
      await waitForLockWaiters(1, 5000);
      await wait(600); // the count's ordinary attempt (300 ms) has missed; its indexed one waits
      const second = await client.connect();
      await second.query("begin");
      const acquiring = second.query(`lock table ${blockedNotes()} in access exclusive mode`);
      await waitForLockWaiters(2, 5000);
      await first.query("rollback");
      first.release();
      await acquiring;
      await wait(2200); // past the page's indexed budget (1,200 ms)
      await second.query("rollback");
      second.release();
      const result = await pending;
      expect(result.pageInfo).toMatchObject({ count: "capped", rowCount: 3, exact: true });
      expect(result.rows.map((row) => row.id)).toEqual([5, 600, 12000]);
      expect(events).toEqual(["t300", "C:O", "t1200", "C:U", "t1200", "P:U", "P:O"]);
    });

    it("does not let a smaller count timeout leak the indexed plan into the page", async () => {
      events.length = 0;
      const result = (await afterBlocked(
        () => countCut.query({ request: searching("common", "capped") }),
        1500,
        0,
      )) as Awaited<ReturnType<typeof countCut.query>>;
      expect(result.pageInfo).toMatchObject({ count: "none", rowCount: null, reason: "timeout" });
      expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
      const firstPage = events.findIndex((event) => event.startsWith("P:"));
      expect(events.slice(firstPage - 1, firstPage + 3)).toEqual(["t300", "P:O", "t1200", "P:U"]);
    });

    it("picks the plan from costs in a caller's transaction, with no budget and no timeout", async () => {
      await planDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '20000', true)`);
        planStatements.length = 0;
        const rare = await search.queryIds({
          db: tx as never,
          request: searching("zebra", "none"),
        });
        expect(rare.ids).toEqual([5, 600, 12000]);
        expect(planStatements.some((query) => query.startsWith("explain"))).toBe(true);
        expect(planStatements.some((query) => query.includes("set_config"))).toBe(false);
        const [row] = await tx.execute(sql`show statement_timeout`, "objects");
        expect(row).toEqual({ statement_timeout: "20s" });
      });
    });

    it("lets statements overlap in a caller's transaction without sharing a limit", async () => {
      await planDb.transaction(async (tx) => {
        const offsets = [0, 3, 8, 15];
        for (const offset of offsets) {
          const first = search.queryIds({ db: tx as never, request: searching("zebra", "none") });
          await new Promise((resolve) => setTimeout(resolve, offset));
          const second = search.query({
            db: tx as never,
            request: { ...searching("common", "none"), facets: [{ key: "ownerId" }] },
          });
          const [rare, common] = await Promise.all([first, second]);
          expect(rare.ids).toEqual([5, 600, 12000]);
          expect(common.facets?.[0]).toMatchObject({ status: "ok" });
        }
        const [row] = await tx.execute(sql`show statement_timeout`, "objects");
        expect(row).toEqual({ statement_timeout: "0" });
      });
    });

    it.each([0, -1, 2.5])("rejects a plan budget of %s", (planBudget) => {
      expect(() =>
        createQueryEngine({
          db: planDb,
          schema: planSchema,
          relations: planRelations,
        }).defineResource("notes", { query: { search: { planBudget } } }),
      ).toThrow("plan budget");
    });

    it("still compares plan costs when the count is exact", async () => {
      planStatements.length = 0;
      const result = await search.queryIds({ request: searching("zebra", "exact") });
      expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 3 });
      expect(planStatements.filter((query) => query.startsWith("explain"))).toHaveLength(2);
    });
  });

  it("types pageInfo so count narrows rowCount", () => {
    const info = { count: "none", rowCount: null } as QueryPageInfo;
    expect(info.rowCount).toBeNull();
    if (info.count === "none") expectTypeOf(info.rowCount).toEqualTypeOf<null>();
    if (info.count === "exact") expectTypeOf(info.rowCount).toEqualTypeOf<number>();
    if (info.count === "capped") expectTypeOf(info.exact).toEqualTypeOf<boolean>();
    if (info.count === "estimated") expectTypeOf(info.rowCount).toEqualTypeOf<number>();
  });
});
