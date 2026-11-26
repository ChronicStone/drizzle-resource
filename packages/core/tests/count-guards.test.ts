import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
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
const schema = { accounts, docs, labels };
const relations = defineRelations(schema, (r) => ({
  docs: {
    account: r.one.accounts({ from: r.docs.accountId, to: r.accounts.id }),
    labels: r.many.labels({ from: r.docs.id, to: r.labels.docId }),
  },
}));
const client = new Pool({ connectionString, max: 6 });
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
    timeouts: { count: 40, facets: 40, summary: 40 },
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

/** Holds a lock that makes every statement on `docs` wait, so a timeout is deterministic. */
async function withBlockedDocs<T>(run: (release: () => Promise<void>) => Promise<T>) {
  const locker = await client.connect();
  await locker.query("begin");
  await locker.query(`lock table "${namespace.schemaName}"."docs" in access exclusive mode`);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
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
      const result = await timed.query({
        request: request({ count: "exact" }, { facets: [{ key: "accountId" }] }),
        summary: true,
      });
      expect(result.summaryStatus).toBe("ok");
      expect(result.summary).toEqual({ total: 28 });
      expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 28 });
      expect(result.facets?.[0]).toMatchObject({ status: "ok" });
    });

    it("restores the caller's statement timeout inside their transaction", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '9000', true)`);
        await timed.queryIds({ db: tx as never, request: request({ count: "exact" }) });
        const [row] = await tx.execute(sql`show statement_timeout`, "objects");
        expect(row).toEqual({ statement_timeout: "9s" });
      });
    });

    it("keeps the caller's transaction usable after a timeout", async () => {
      await db.transaction(async (tx) => {
        const pending = withBlockedDocs(async (release) => {
          const query = timed.queryIds({ db: tx as never, request: request({ count: "exact" }) });
          await new Promise((resolve) => setTimeout(resolve, 400));
          await release();
          return query;
        });
        const result = await pending;
        expect(result.pageInfo).toMatchObject({ count: "none", reason: "timeout" });
        const [row] = await tx.execute(sql`select 1 as ok`, "objects");
        expect(row).toEqual({ ok: 1 });
      });
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
    const planDb = drizzle({
      client,
      relations: planRelations,
      logger: {
        logQuery(query) {
          planStatements.push(query);
        },
      },
    });
    const search = createQueryEngine({
      db: planDb,
      schema: planSchema,
      relations: planRelations,
    }).defineResource("notes", {
      relations: { owner: true },
      query: { search: { allowed: ["body", "owner.name"] } },
    });

    beforeAll(async () => {
      await db.execute(sql`create extension if not exists pg_trgm`);
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

    function searching(value: string, count: "none" | "capped" | "exact") {
      return {
        pagination: { mode: "offset" as const, pageIndex: 1, pageSize: 5, count },
        filters: [],
        search: { value, fields: ["body", "owner.name"] },
        sorting: [{ key: "id", dir: "asc" as const }],
      };
    }

    it("takes the indexed plan for a rare term and returns its rows", async () => {
      planStatements.length = 0;
      const result = await search.queryIds({ request: searching("zebra", "none") });
      expect(result.ids).toEqual([5, 600, 12000]);
      expect(result.pageInfo).toMatchObject({ count: "none", hasNextPage: false });
      expect(planStatements.some((query) => query.includes("as matches"))).toBe(true);
      expect(planStatements.some((query) => query.startsWith("explain"))).toBe(false);
      expect(planStatements.at(-1)).toContain(" union ");
    });

    it("keeps the ordinary plan for a common term", async () => {
      planStatements.length = 0;
      const result = await search.queryIds({ request: searching("common", "none") });
      expect(result.ids).toEqual([1, 2, 3, 4, 5]);
      expect(result.pageInfo).toMatchObject({ count: "none", hasNextPage: true });
      expect(planStatements.at(-1)).not.toContain(" union ");
    });

    it("decides the same way for a capped count", async () => {
      const rare = await search.queryIds({ request: searching("zebra", "capped") });
      expect(rare.ids).toEqual([5, 600, 12000]);
      expect(rare.pageInfo).toMatchObject({ count: "capped", rowCount: 3, exact: true });
      const common = await search.queryIds({ request: searching("common", "capped") });
      expect(common.pageInfo).toMatchObject({ count: "capped", rowCount: 10_000, exact: false });
    });

    it("still compares plan costs when the count is exact", async () => {
      planStatements.length = 0;
      const result = await search.queryIds({ request: searching("zebra", "exact") });
      expect(result.pageInfo).toMatchObject({ count: "exact", rowCount: 3 });
      expect(planStatements.filter((query) => query.startsWith("explain"))).toHaveLength(2);
      expect(planStatements.some((query) => query.includes("as matches"))).toBe(false);
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
