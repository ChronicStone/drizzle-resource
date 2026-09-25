import { randomUUID } from "node:crypto";
import { count, defineRelations, desc, eq, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, numeric, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vite-plus/test";
import { createQueryEngine, virtual } from "../index.js";
import type { QueryRequestInput } from "../index.js";

const namespace = pgSchema(`model_test_${randomUUID().replaceAll("-", "")}`);
const accounts = namespace.table("accounts", {
  id: integer().primaryKey(),
  name: text().notNull(),
  tenant: text().notNull(),
  secret: text().notNull(),
  metadata: text(),
  amount: numeric().notNull(),
});
const entries = namespace.table("entries", {
  id: integer().primaryKey(),
  accountId: integer().notNull(),
  label: text().notNull(),
  completedAt: timestamp({ withTimezone: true }).notNull(),
});
const schema = { accounts, entries };
const relations = defineRelations(schema, (r) => ({
  accounts: { entries: r.many.entries({ from: r.accounts.id, to: r.entries.accountId }) },
  entries: {
    account: r.one.accounts({ from: r.entries.accountId, to: r.accounts.id, optional: false }),
  },
}));
const connectionString = process.env.TEST_DATABASE_URL;
const client = new Pool({ connectionString });
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
const scalarDatabases: unknown[] = [];
const engine = createQueryEngine({
  db,
  schema,
  relations,
  models: {
    accounts: {
      private: ["secret"],
      hidden: ["metadata"],
      virtual: (account, { db: executionDb }) => {
        expectTypeOf(account).toEqualTypeOf<typeof accounts>();
        expectTypeOf(executionDb).toEqualTypeOf<typeof db>();
        scalarDatabases.push(executionDb);
        return {
          upperName: virtual.text(sql`upper(${account.name})`),
          doubled: virtual.number(sql`${account.amount} * 2`),
          latest: virtual.scalar(
            executionDb
              .select({ value: entries.completedAt })
              .from(entries)
              .where(eq(entries.accountId, account.id))
              .orderBy(desc(entries.completedAt))
              .limit(1),
          ),
        };
      },
    },
  },
}).withContext<{ tenant: string }>();
const resource = engine.defineResource("accounts", {
  relations: { entries: true },
  views: {
    list: { select: { name: true, upperName: true } },
    detail: {
      select: { id: true, metadata: true, latest: true, entries: { select: { label: true } } },
    },
  },
  query: {
    scope: (f, ctx) => f.is("tenant", ctx.tenant),
    search: { allowed: ["name", "upperName", "entries.label"] },
    pagination: { modes: ["offset", "cursor"] },
  },
  summary: (row) => ({ rows: count(), total: sum(row.amount), doubled: sum(row.doubled) }),
});
const nested = engine.defineResource("entries", {
  relations: { account: { with: { entries: true } } },
  views: {
    list: { select: { account: { select: { name: true, upperName: true, latest: true } } } },
    defaults: { select: { account: true } },
  },
});
const request: QueryRequestInput = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 1, count: "exact" },
  filters: [],
  search: { value: "", fields: [] },
  sorting: [{ key: "id", dir: "asc" }],
};
const context = { tenant: "a" };

describe("model and view definitions", () => {
  it("rejects unknown engine models and field names", () => {
    expect(() =>
      createQueryEngine({
        db,
        schema,
        relations,
        // @ts-expect-error models must belong to the schema
        models: { missing: {} },
      }),
    ).toThrow("Unknown model");
    expect(() =>
      createQueryEngine({
        db,
        schema,
        relations,
        // @ts-expect-error hidden fields must belong to the model
        models: { accounts: { hidden: ["missing"] } },
      }),
    ).toThrow("Unknown model field");
  });
  it("rejects private, unknown and mismatched selections at definition time", () => {
    expect(() =>
      engine.defineResource("accounts", {
        // @ts-expect-error private fields cannot be selected
        views: { bad: { select: { secret: true } } },
      }),
    ).toThrow("private field");
    expect(() =>
      engine.defineResource("accounts", {
        // @ts-expect-error unknown selected field
        views: { bad: { select: { missing: true } } },
      }),
    ).toThrow("Unknown selection");
    expect(() =>
      engine.defineResource("entries", {
        relations: { account: true },
        // @ts-expect-error nested private field
        views: { bad: { select: { account: { select: { secret: true } } } } },
      }),
    ).toThrow("private field");
  });

  it("infers views, nested scalar virtuals, decimals and safe defaults", () => {
    expectTypeOf<typeof resource.$infer.views.list>().toEqualTypeOf<{
      name: string;
      upperName: string;
    }>();
    expectTypeOf<typeof resource.$infer.views.detail>().toEqualTypeOf<{
      id: number;
      metadata: string | null;
      latest: Date | null;
      entries: { label: string }[];
    }>();
    expectTypeOf<typeof resource.$infer.summary>().toEqualTypeOf<{
      rows: number;
      total: string | null;
      doubled: string | null;
    }>();
    expectTypeOf<typeof nested.$infer.views.list>().toEqualTypeOf<{
      account: { name: string; upperName: string; latest: Date | null };
    }>();
    expectTypeOf<typeof nested.$infer.views.defaults>().toEqualTypeOf<{
      account: { id: number; name: string; tenant: string; amount: string };
    }>();
    expectTypeOf<typeof resource.$infer.query>().not.toHaveProperty("secret");
    expectTypeOf<typeof resource.$infer.query>().not.toHaveProperty("metadata");
    expectTypeOf<typeof resource.$infer.views.detail>().toHaveProperty("metadata");
    const legacy = engine.defineResource("entries", {
      relations: { account: true },
      hydration: { profiles: { detail: { account: true } } },
    });
    expectTypeOf<typeof legacy.$infer.profiles.detail.account>().not.toHaveProperty("secret");
    expectTypeOf<typeof legacy.$infer.profiles.detail.account>().not.toHaveProperty("metadata");

    async function checkCallTypes() {
      const defaultRow = await resource.findById({ id: 1, context });
      // @ts-expect-error hidden fields are not in default output
      void defaultRow?.metadata;
      // @ts-expect-error private fields are never in output
      void defaultRow?.secret;
      const detail = await resource.findById({ id: 1, context, view: "detail" });
      expectTypeOf(detail?.metadata).toEqualTypeOf<string | null | undefined>();
      const page = await resource.query({ request, context, view: "list" });
      // @ts-expect-error unrequested summaries are absent
      void page.summary;
      // @ts-expect-error view names are a literal union
      await resource.query({ request, context, view: "missing" });
      // @ts-expect-error views and legacy relation loads cannot be combined
      await resource.query({ request, context, view: "list", load: { entries: true } });
      // @ts-expect-error this resource has no summary definition
      await nested.query({ request, summary: true });
      const requested = await resource.query({ request, context, summary: true });
      expectTypeOf(requested.summary).toEqualTypeOf<typeof resource.$infer.summary>();
      const maybe = await resource.query({ request, context, summary: Math.random() > 0.5 });
      // @ts-expect-error a dynamic flag does not guarantee a summary
      void maybe.summary;
      if ("summary" in maybe)
        expectTypeOf(maybe.summary).toEqualTypeOf<typeof resource.$infer.summary>();
    }
    void checkCallTypes;
    engine.defineResource("accounts", {
      summary: (row) => ({
        // @ts-expect-error private columns are absent from the summary expression input
        secret: count(row.secret),
      }),
    });
  });

  it("removes private fields from the public registry at every depth", () => {
    expect(resource.fields.has("secret")).toBe(false);
    expect(nested.fields.has("account.secret")).toBe(false);
    expect(nested.fields.has("account.upperName")).toBe(true);
    expect(resource.fields.has("metadata")).toBe(true);
  });

  it("rejects scalar queries with multiple selected columns", () => {
    const invalid = virtual.scalar(
      // @ts-expect-error scalar queries must select exactly one value
      (_account: typeof accounts, { db: executionDb }: { db: typeof db }) =>
        executionDb.select({ id: entries.id, label: entries.label }).from(entries),
    );
    expect(() => invalid.resolve(accounts, { db })).toThrow("exactly one column");
  });

  it("projects custom strategy rows before returning them", async () => {
    const custom = engine.defineResource("accounts", {
      views: { list: { select: { name: true } } },
      strategy: {
        query: async () => ({
          rows: [
            {
              id: 1,
              name: "Alpha",
              tenant: "a",
              amount: "1.00",
              secret: "never",
              metadata: "hidden",
            },
          ],
          pageInfo: {
            mode: "offset",
            pageIndex: 1,
            pageSize: 1,
            count: "exact",
            rowCount: 1,
            hasNextPage: false,
          },
        }),
      },
    });
    const defaults = await custom.query({ request });
    expect(defaults.rows).toEqual([{ id: 1, name: "Alpha", tenant: "a", amount: "1.00" }]);
    expect((await custom.query({ request, view: "list" })).rows).toEqual([{ name: "Alpha" }]);
  });

  it("preserves custom row shapes when model policies only apply to unrelated tables", async () => {
    type CustomRow = { id: number; transformed: string };
    const custom = engine.defineResource<"entries", undefined, { tenant: string }, CustomRow>(
      "entries",
      {
        strategy: {
          query: async () => ({
            rows: [{ id: 1, transformed: "custom" }],
            pageInfo: {
              mode: "offset",
              pageIndex: 1,
              pageSize: 1,
              count: "exact",
              rowCount: 1,
              hasNextPage: false,
            },
          }),
          rows: async ({ ids }) => ids.map((id) => ({ id, transformed: "custom" })),
        },
      },
    );
    const page = await custom.query({ request });
    expectTypeOf(page.rows).toEqualTypeOf<CustomRow[]>();
    expect(page.rows).toEqual([{ id: 1, transformed: "custom" }]);
    expect(await custom.queryRows({ request, ids: [1] })).toEqual(page.rows);
    const scopedGraph = engine.defineResource<
      "entries",
      { account: true },
      { tenant: string },
      CustomRow,
      { profiles: { list: {} }; defaults: { query: "list" } }
    >("entries", {
      relations: { account: true },
      hydration: { profiles: { list: {} }, defaults: { query: "list" } },
      strategy: { query: async () => ({ rows: page.rows, pageInfo: page.pageInfo }) },
    });
    expectTypeOf<typeof scopedGraph.$infer.query>().toEqualTypeOf<CustomRow>();
    expect((await scopedGraph.query({ request })).rows).toEqual(page.rows);
  });

  it("rejects private query paths before database execution", async () => {
    await expect(
      resource.query({
        context,
        request: {
          ...request,
          filters: [{ type: "condition", key: "secret", operator: "is", value: "never" }],
        },
      }),
    ).rejects.toThrow("Unknown filter field");
  });
});

describe.skipIf(!connectionString)("model projections and summaries in PostgreSQL", () => {
  beforeAll(async () => {
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(
      sql`create table ${accounts} (id integer primary key, name text not null, tenant text not null, secret text not null, metadata text, amount numeric not null)`,
    );
    await db.execute(
      sql`create table ${entries} (id integer primary key, "accountId" integer not null, label text not null, "completedAt" timestamptz not null)`,
    );
    await db.insert(accounts).values([
      { id: 1, name: "Alpha", tenant: "a", secret: "never", metadata: "operator", amount: "10.25" },
      { id: 2, name: "Beta", tenant: "a", secret: "never", amount: "20.75" },
      { id: 3, name: "Gamma", tenant: "b", secret: "never", amount: "100.00" },
    ]);
    await db.insert(entries).values([
      { id: 1, accountId: 1, label: "match", completedAt: new Date("2026-01-01Z") },
      { id: 2, accountId: 1, label: "match", completedAt: new Date("2026-02-01Z") },
      { id: 3, accountId: 2, label: "other", completedAt: new Date("2026-01-01Z") },
    ]);
  });
  afterAll(async () => {
    await db.execute(sql`drop schema ${sql.identifier(namespace.schemaName)} cascade`);
    await client.end();
  });

  it("selects only requested columns and strips internal ordering IDs", async () => {
    statements.length = 0;
    const result = await resource.query({ request, context, view: "list" });
    expectTypeOf(result.rows).toEqualTypeOf<{ name: string; upperName: string }[]>();
    expect(result.rows).toEqual([{ name: "Alpha", upperName: "ALPHA" }]);
    expect(statements.at(-1)).not.toContain('"secret"');
    expect(statements.at(-1)).not.toContain('"metadata"');
    expect(statements.at(-1)).not.toContain('"amount"');
    expect(statements.at(-1)).not.toContain('"entries"');
    expect(result).not.toHaveProperty("summary");
  });

  it("applies safe defaults through legacy reads and hydrates hidden fields explicitly", async () => {
    const result = await resource.findById({ id: 1, context });
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("upperName");
    const detail = await resource.findById({ id: 1, context, view: "detail" });
    expect(detail).toEqual({
      id: 1,
      metadata: "operator",
      latest: new Date("2026-02-01Z"),
      entries: [{ label: "match" }, { label: "match" }],
    });
  });

  it("correlates and decodes virtuals inside nested selections", async () => {
    const result = await nested.findById({ id: 1, view: "list" });
    expect(result).toEqual({
      account: { name: "Alpha", upperName: "ALPHA", latest: new Date("2026-02-01Z") },
    });
    const defaults = await nested.findById({ id: 1, view: "defaults" });
    expect(defaults?.account).not.toHaveProperty("entries");
    expect(defaults?.account).not.toHaveProperty("secret");
    const empty = engine.defineResource("entries", {
      relations: { account: true },
      views: { empty: { select: { account: { select: {} } } } },
    });
    expect(await empty.findById({ id: 1, view: "empty" })).toEqual({ account: {} });
  });

  it("aggregates all scoped rows in one statement and reuses the pagination count", async () => {
    statements.length = 0;
    const result = await resource.query({ request, context, view: "list", summary: true });
    expectTypeOf(result.summary).toEqualTypeOf<typeof resource.$infer.summary>();
    expect(result.summary).toEqual({ rows: 2, total: "31.00", doubled: "62.00" });
    expect(result.pageInfo.rowCount).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("sum(");
    expect(statements[0]).not.toMatch(/limit|offset|order by/i);
    const standalone = await resource.querySummary({ request, context });
    expect(standalone).toEqual(result.summary);
  });

  it("allows trusted scopes on private and virtual fields without exposing private paths", async () => {
    const scope = engine.defineScope("accounts", (_ctx, f) =>
      f.and([f.is("secret", "never"), f.is("upperName", "alpha")]),
    );
    const scoped = engine.defineResource("accounts", {
      query: { scope },
      summary: () => ({ rows: count() }),
    });
    expect(scoped.fields.has("secret")).toBe(false);
    expect(await scoped.querySummary({ request, context })).toEqual({ rows: 1 });
    engine.defineResource("accounts", {
      query: {
        scope: (f) => f.is("secret", "never"),
        // @ts-expect-error private fields cannot be configured for public search
        search: { allowed: ["secret"] },
      },
    });
  });

  it("does not multiply aggregates when multiple children match a relation filter", async () => {
    const result = await resource.querySummary({
      context,
      request: {
        ...request,
        filters: [{ type: "condition", key: "entries.label", operator: "is", value: "match" }],
      },
    });
    expect(result).toEqual({ rows: 1, total: "10.25", doubled: "20.50" });
  });

  it("aggregates search across nested virtuals", async () => {
    const searched = engine.defineResource("entries", {
      relations: { account: true },
      summary: () => ({ rows: count() }),
      query: { search: { allowed: ["account.upperName"] } },
    });
    const result = await searched.querySummary({
      request: {
        ...request,
        search: { value: "alpha", fields: ["account.upperName"] },
      },
    });
    expect(result.rows).toBe(2);
  });

  it("does not decode empty sums as zero and preserves numeric precision", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(accounts).values({
        id: 5,
        name: "Precise",
        tenant: "precision",
        secret: "never",
        amount: "9007199254740993.123456",
      });
      const summary = await resource.querySummary({
        request,
        context: { tenant: "precision" },
        db: tx,
      });
      expect(summary.total).toBe("9007199254740993.123456");
      await tx.delete(accounts).where(eq(accounts.id, 5));
    });
  });

  it("ignores cursor bounds and empty pages, but honors virtual search and empty datasets", async () => {
    const first = await resource.query({
      context,
      summary: true,
      view: "list",
      request: {
        ...request,
        sorting: [{ key: "upperName", dir: "asc" }],
        pagination: { mode: "cursor", pageSize: 1 },
      },
    });
    if (first.pageInfo.mode !== "cursor") throw new Error("Expected cursor");
    const next = await resource.query({
      context,
      summary: true,
      view: "list",
      request: {
        ...request,
        sorting: [{ key: "upperName", dir: "asc" }],
        pagination: { mode: "cursor", pageSize: 1, cursor: first.pageInfo.nextCursor },
      },
    });
    expect(next.rows[0]?.upperName).toBe("BETA");
    expect(next.summary).toEqual(first.summary);
    const emptyPage = await resource.query({
      context,
      summary: true,
      view: "list",
      request: {
        ...request,
        pagination: { pageIndex: 99, pageSize: 1 },
      },
    });
    expect(emptyPage.rows).toEqual([]);
    expect(emptyPage.summary.rows).toBe(2);
    const empty = await resource.querySummary({
      context,
      request: {
        ...request,
        search: { value: "missing", fields: ["upperName"] },
      },
    });
    expect(empty).toEqual({ rows: 0, total: null, doubled: null });
  });

  it("uses the current transaction for scalar virtuals and summaries", async () => {
    await db.transaction(async (tx) => {
      await tx
        .insert(accounts)
        .values({ id: 4, name: "Tx", tenant: "a", secret: "never", amount: "1.00" });
      scalarDatabases.length = 0;
      const detail = await resource.findById({ id: 4, context, db: tx, view: "detail" });
      expect(detail?.latest).toBeNull();
      expect(scalarDatabases.length).toBeGreaterThan(0);
      expect(scalarDatabases.every((database) => database === tx)).toBe(true);
      const summary = await resource.querySummary({ request, context, db: tx });
      expect(summary.total).toBe("32.00");
      await tx.delete(accounts).where(eq(accounts.id, 4));
    });
  });

  it("applies views to PostgreSQL scans without computing summaries", async () => {
    statements.length = 0;
    const rows = await resource.scan({ context, view: "list", batchSize: 1 }, async (batches) => {
      const collected: Array<typeof resource.$infer.views.list> = [];
      for await (const batch of batches) collected.push(...batch.rows);
      return collected;
    });
    expect(rows).toEqual([
      { name: "Alpha", upperName: "ALPHA" },
      { name: "Beta", upperName: "BETA" },
    ]);
    expect(statements.some((statement) => statement.includes("sum("))).toBe(false);
  });

  it("keeps private IDs available internally without allowing public ID sorts", async () => {
    const privateIds = createQueryEngine({
      db,
      schema,
      relations,
      models: { accounts: { private: ["id", "secret"] } },
    }).defineResource("accounts", { summary: () => ({ rows: count() }) });
    const defaultSort = { ...request, sorting: [] };
    const page = await privateIds.query({ request: defaultSort, summary: true });
    expectTypeOf(page.rows[0]).not.toHaveProperty("id");
    expect(page.rows[0]).not.toHaveProperty("id");
    expect(page.summary.rows).toBe(3);
    expect(await privateIds.querySummary({ request: defaultSort })).toEqual({ rows: 3 });
    expect((await privateIds.queryRows({ request: defaultSort, ids: [1] }))[0]).not.toHaveProperty(
      "id",
    );
    expect(await privateIds.findById({ id: 1 })).not.toHaveProperty("id");
    const scanned = await privateIds.scan({ batchSize: 1 }, async (batches) => {
      const collected: Array<typeof privateIds.$infer.query> = [];
      for await (const batch of batches) collected.push(...batch.rows);
      return collected;
    });
    expect(scanned).toHaveLength(3);
    expect(scanned.every((row) => !("id" in row))).toBe(true);
    await expect(privateIds.query({ request })).rejects.toThrow('Unknown sorting field "id"');
  });
});
