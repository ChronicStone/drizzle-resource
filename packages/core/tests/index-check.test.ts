import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  index,
  integer,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createQueryEngine, formatIndexFindings } from "../index.js";
import { confirmDefaultSort } from "../src/index-check.js";
import type { IndexFinding } from "../index.js";

const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  orgId: uuid("org_id").notNull(),
});
const lines = pgTable("order_lines", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull(),
  sku: text("sku").notNull(),
});

type Extra = (table: any) => any[];

function makeOrders(extra: (t: any) => any[] = () => []) {
  return pgTable(
    "orders",
    {
      id: uuid("id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      tenant: text("tenant").notNull(),
      createdAt: timestamp("created_at").notNull(),
      deletedAt: timestamp("deleted_at"),
      status: text("status").notNull(),
      total: integer("total").notNull(),
      reference: text("reference").notNull().unique(),
      accountId: uuid("account_id").notNull(),
    },
    extra,
  );
}

function setup(
  extra: Extra,
  query: Record<string, unknown> = {},
  options: { relations?: boolean; strategy?: Record<string, unknown> } = {},
) {
  const orders = makeOrders(extra);
  const schema = { accounts, lines, orders };
  const relations = defineRelations(schema, (r) => ({
    orders: {
      account: r.one.accounts({ from: r.orders.accountId, to: r.accounts.id }),
      lines: r.many.lines({ from: r.orders.id, to: r.lines.orderId }),
    },
  }));
  const db = drizzle.mock({ relations });
  const engine = createQueryEngine({ db, schema, relations }).withContext<{ orgId: string }>();
  const resource = engine.defineResource("orders", {
    ...(options.relations === false ? {} : { relations: { account: true, lines: true } }),
    ...(options.strategy ? { strategy: options.strategy } : {}),
    query: {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId)]),
      search: { allowed: ["status"] },
      facets: { allowed: ["status"] },
      sort: { disabled: ["account.id", "account.name", "account.orgId"] },
      ...query,
    },
  } as never);
  return { engine, resource: resource as any, orders };
}

const byRule = (findings: IndexFinding[], rule: string) =>
  findings.filter((finding) => finding.rule === rule);

describe("checkIndexes: default sort", () => {
  const createdDesc = [{ key: "createdAt", dir: "desc" }];

  it("reports a default sort with no index and gives the index that fixes it", () => {
    const { resource } = setup(() => [], { sort: { defaults: createdDesc } });
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding).toMatchObject({
      resource: "orders",
      level: "error",
      message: "default sort createdAt desc, id desc under scope orgId has no index",
      fields: ["createdAt", "id"],
      fix: {
        drizzle:
          'index("orders_org_id_created_at_id_idx").on(t.orgId, t.createdAt.desc(), t.id.desc())',
        sql: "create index orders_org_id_created_at_id_idx on orders (org_id, created_at desc, id desc);",
      },
    });
  });

  it("accepts the index read forward and the opposite index read backward", () => {
    for (const make of [
      (t: any) => index("a").on(t.orgId, t.createdAt.desc(), t.id.desc()),
      (t: any) => index("b").on(t.orgId, t.createdAt, t.id),
    ]) {
      const { resource } = setup((t) => [make(t)], { sort: { defaults: createdDesc } });
      expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
    }
  });

  it("accepts the equality columns of the scope in any order", () => {
    const { resource } = setup((t) => [index("a").on(t.tenant, t.orgId, t.createdAt, t.id)], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("tenant", ctx.tenant)]),
      filters: { caseSensitive: ["tenant"] },
      sort: { defaults: createdDesc },
    });
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("does not count an index that skips a scope column", () => {
    const { resource } = setup(
      (t) => [index("a").on(t.orgId, t.createdAt, t.id), index("b").on(t.createdAt, t.id)],
      {
        scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("tenant", ctx.tenant)]),
        sort: { defaults: createdDesc },
      },
    );
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.message).toContain("under scope orgId, tenant");
  });

  it("does not count scope conditions that are not plain equalities", () => {
    const { resource } = setup((t) => [index("a").on(t.createdAt, t.id)], {
      scope: (f: any, ctx: any) =>
        f.and([f.isAnyOf("orgId", ctx.orgIds), f.or([f.is("tenant", "a"), f.is("tenant", "b")])]),
      sort: { defaults: createdDesc },
    });
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("warns, with a gentler level, when only the id tie-breaker is missing", () => {
    const { resource } = setup(
      (t) => [index("orders_org_created").on(t.orgId, t.createdAt.desc())],
      {
        sort: { defaults: createdDesc },
      },
    );
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding).toMatchObject({ level: "warn" });
    expect(finding?.message).toContain("orders_org_created");
    expect(finding?.message).toContain("id tie-breaker");
  });

  it("does not count an expression for a plain column", () => {
    const { resource } = setup(
      (t) => [index("expression").on(t.orgId, sql`date(${t.createdAt}) desc`, t.id.desc())],
      { sort: { defaults: createdDesc } },
    );
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")[0]?.level).toBe("error");
  });

  it("does not ask for an index on `is null`: it filters the rows the index reads", () => {
    const { resource } = setup((t) => [index("a").on(t.orgId, t.createdAt.desc(), t.id.desc())], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
      sort: { defaults: createdDesc },
    });
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("only warns, without a fix, when the index serves the sort and a scope equality filters", () => {
    const { resource } = setup((t) => [index("a").on(t.orgId, t.createdAt.desc(), t.id.desc())], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("status", "open")]),
      filters: { caseSensitive: ["status"] },
      sort: { defaults: createdDesc },
    });
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("served by index a");
    expect(finding?.message).toContain("filters row by row");
    expect(finding?.fix).toBeUndefined();
  });

  it("gives the same warning for a missing id tie-breaker with or without a soft-delete scope", () => {
    for (const scope of [
      (f: any, ctx: any) => f.is("orgId", ctx.orgId),
      (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
      (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("status", "open")]),
    ]) {
      const { resource } = setup((t) => [index("a").on(t.orgId, t.createdAt.desc())], {
        scope,
        filters: { caseSensitive: ["status"] },
        sort: { defaults: createdDesc },
      });
      const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
      expect(finding?.level).toBe("warn");
      expect(finding?.message).toContain("id tie-breaker");
    }
  });

  it("does not count an index with an `is null` column before the sort columns", () => {
    const { resource } = setup(
      (t) => [index("a").on(t.deletedAt, t.createdAt.desc(), t.id.desc())],
      {
        scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
        sort: { defaults: createdDesc },
      },
    );
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")[0]?.level).toBe("error");
  });

  it("warns, naming the equality, when the index provides the order but leaves one out", () => {
    const value = setup((t) => [index("a").on(t.status, t.createdAt.desc(), t.id.desc())], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("status", "open")]),
      filters: { caseSensitive: ["status"] },
      sort: { defaults: createdDesc },
    });
    const [finding] = byRule(value.resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("orgId is not in it: orgId filters row by row");
    expect(finding?.message).toContain("prefer a full scan");
  });

  it("gives the same verdict for every order of the scope", () => {
    const conditions: Array<(f: any, ctx: any) => any> = [
      (f, ctx) => f.is("orgId", ctx.orgId),
      (f) => f.is("tenant", "t1"),
      (f) => f.is("deletedAt", null),
      (f) => f.is("status", "open"),
    ];
    const permutations = (items: number[]): number[][] =>
      items.length < 2
        ? [items]
        : items.flatMap((item, at) =>
            permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const indexes: Array<(t: any) => any[]> = [
      () => [],
      (t) => [index("a").on(t.orgId, t.createdAt.desc(), t.id.desc())],
      (t) => [index("a").on(t.tenant, t.createdAt.desc(), t.id.desc())],
      (t) => [index("a").on(t.tenant, t.orgId, t.createdAt.desc(), t.id.desc())],
      (t) => [index("a").on(t.orgId, t.createdAt.desc())],
      (t) => [index("a").on(t.deletedAt, t.createdAt.desc(), t.id.desc())],
      (t) => [index("a").on(t.orgId, t.deletedAt, t.createdAt.desc(), t.id.desc())],
      (t) => [index("a").on(t.createdAt.desc(), t.id.desc())],
    ];
    for (const make of indexes) {
      const seen = new Set<string>();
      for (const order of permutations([0, 1, 2, 3])) {
        const { resource } = setup(make, {
          scope: (f: any, ctx: any) =>
            f.and(order.map((position) => conditions[position]!(f, ctx))),
          filters: { caseSensitive: ["tenant", "status"] },
          sort: { defaults: createdDesc },
        });
        seen.add(
          JSON.stringify(
            byRule(resource.checkIndexes(), "default-sort-unindexed").map((finding) => [
              finding.level,
              finding.message
                .replace(/under scope [^ ]+( [^ ]+)* (has|is)/, "$2")
                .replace(/\(.*\)/, ""),
            ]),
          ),
        );
      }
      expect(seen.size).toBe(1);
    }
  });

  it("serves an index on one equality or the other, in any scope order", () => {
    for (const make of [
      (t: any) => index("a").on(t.orgId, t.createdAt.desc(), t.id.desc()),
      (t: any) => index("a").on(t.tenant, t.createdAt.desc(), t.id.desc()),
    ]) {
      for (const scope of [
        (f: any) => f.and([f.is("tenant", "t1"), f.is("orgId", "x")]),
        (f: any) => f.and([f.is("orgId", "x"), f.is("tenant", "t1")]),
        (f: any, ctx: any) => f.and([f.is("tenant", ctx.tenant), f.is("orgId", ctx.orgId)]),
      ]) {
        const { resource } = setup((t) => [make(t)], {
          scope,
          filters: { caseSensitive: ["tenant"] },
          sort: { defaults: createdDesc },
        });
        const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
        expect(finding?.level).toBe("warn");
        expect(finding?.message).toContain("filters row by row");
      }
    }
  });

  it("reads a single value in an array as an equality, as the engine does", () => {
    const notEquality = [
      (f: any, ctx: any) => f.isAnyOf("orgId", ctx.orgIds),
      (f: any) => f.isAnyOf("orgId", ["a", "b"]),
      (f: any) => f.isAnyOf("orgId", []),
      (f: any) => f.isAnyOf("orgId", [null]),
    ];
    const equality = [
      (f: any) => f.isAnyOf("orgId", ["a"]),
      (f: any) => f.is("orgId", ["a", "b"]),
      (f: any) => f.is("orgId", ["a"]),
    ];
    for (const scope of equality) {
      const withIndex = setup((t) => [index("a").on(t.orgId, t.createdAt.desc(), t.id.desc())], {
        scope,
        sort: { defaults: createdDesc },
      });
      expect(byRule(withIndex.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
      const without = setup(() => [], { scope, sort: { defaults: createdDesc } });
      expect(byRule(without.resource.checkIndexes(), "default-sort-unindexed")[0]?.fix?.sql).toBe(
        "create index orders_org_id_created_at_id_idx on orders (org_id, created_at desc, id desc);",
      );
    }
    for (const scope of notEquality) {
      const { resource } = setup(() => [], { scope, sort: { defaults: createdDesc } });
      expect(byRule(resource.checkIndexes(), "default-sort-unindexed")[0]?.fix?.sql).toBe(
        "create index orders_created_at_id_idx on orders (created_at desc, id desc);",
      );
    }
  });

  it("writes one where, joined with and, for several null scope columns", () => {
    const { resource } = setup(() => [], {
      scope: (f: any, ctx: any) =>
        f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null), f.is("status", null)]),
      sort: { defaults: createdDesc },
    });
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.fix).toEqual({
      drizzle:
        'index("orders_org_id_created_at_id_partial_idx").on(t.orgId, t.createdAt.desc(), t.id.desc()).where(sql`${t.deletedAt} is null and ${t.status} is null`)',
      sql: "create index orders_org_id_created_at_id_partial_idx on orders (org_id, created_at desc, id desc) where deleted_at is null and status is null;",
    });
  });

  it("says a null column before the sort columns forces a sort, and suggests a partial index", () => {
    const { resource } = setup(
      (t) => [index("a").on(t.orgId, t.deletedAt, t.createdAt.desc(), t.id.desc())],
      {
        scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
        sort: { defaults: createdDesc },
      },
    );
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("error");
    expect(finding?.message).toContain("partial index");
    expect(finding?.fix).toEqual({
      drizzle:
        'index("orders_org_id_created_at_id_partial_idx").on(t.orgId, t.createdAt.desc(), t.id.desc()).where(sql`${t.deletedAt} is null`)',
      sql: "create index orders_org_id_created_at_id_partial_idx on orders (org_id, created_at desc, id desc) where deleted_at is null;",
    });
  });

  it("trusts a nullable unique column once the scope gives it a value", () => {
    const slugs = pgTable(
      "slugs",
      {
        id: uuid("id").primaryKey(),
        orgId: uuid("org_id").notNull(),
        slug: text("slug"),
        createdAt: timestamp("created_at").notNull(),
      },
      (t) => [unique("slugs_org_slug").on(t.orgId, t.slug)],
    );
    const schema = { slugs };
    const relations = defineRelations(schema, () => ({}));
    const engine = createQueryEngine({ db: drizzle.mock({ relations }), schema, relations });
    const define = (scope: (f: any) => any) =>
      engine.defineResource("slugs", {
        query: {
          scope,
          filters: { caseSensitive: ["slug"] },
          sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
        },
      } as never) as any;
    expect(
      byRule(
        define((f) => f.and([f.is("orgId", "x"), f.is("slug", "y")])).checkIndexes(),
        "default-sort-unindexed",
      ),
    ).toEqual([]);
    expect(
      byRule(define((f) => f.is("orgId", "x")).checkIndexes(), "default-sort-unindexed")[0]?.level,
    ).toBe("error");
  });

  it("warns, and does not fail, when the index starts with none of the scope columns", () => {
    const { resource } = setup((t) => [index("a").on(t.createdAt.desc(), t.id.desc())], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
      sort: { defaults: createdDesc },
    });
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("orgId filters row by row");
  });

  it("counts a partial index whose condition the scope states", () => {
    const partial = (t: any, where: any) =>
      index("a").on(t.orgId, t.createdAt.desc(), t.id.desc()).where(where);
    const nullScope = (f: any, ctx: any) =>
      f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]);
    const isEmpty = (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.isEmpty("deletedAt")]);
    for (const scope of [nullScope, isEmpty]) {
      const { resource } = setup((t) => [partial(t, sql`${t.deletedAt} is null`)], {
        scope,
        sort: { defaults: createdDesc },
      });
      expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
    }
    const equality = setup((t) => [partial(t, sql`${t.status} = 'open'`)], {
      scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("status", "open")]),
      filters: { caseSensitive: ["status"] },
      sort: { defaults: createdDesc },
    });
    expect(byRule(equality.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("warns when a partial index about a scope column would serve but the scope cannot promise it", () => {
    const { resource } = setup(
      (t) => [
        index("a")
          .on(t.orgId, t.createdAt.desc(), t.id.desc())
          .where(sql`${t.status} = 'open'`),
      ],
      {
        scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("status", ctx.status)]),
        filters: { caseSensitive: ["status"] },
        sort: { defaults: createdDesc },
      },
    );
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("cannot confirm the index is used");
    expect(finding?.fix).toBeDefined();
  });

  it("ignores partial indexes about other columns, and those the scope contradicts", () => {
    const where = (condition: (t: any) => any) =>
      setup((t) => [index("a").on(t.orgId, t.createdAt.desc(), t.id.desc()).where(condition(t))], {
        scope: (f: any, ctx: any) => f.and([f.is("orgId", ctx.orgId), f.is("deletedAt", null)]),
        sort: { defaults: createdDesc },
      });
    for (const condition of [
      (t: any) => sql`${t.status} <> ''`,
      (t: any) => sql`${t.deletedAt} is not null`,
      (t: any) => sql`${t.total} > 10`,
    ]) {
      expect(
        byRule(where(condition).resource.checkIndexes(), "default-sort-unindexed")[0]?.level,
      ).toBe("error");
    }
    // the same condition, about a column the scope does not mention
    const unmentioned = setup(
      (t) => [
        index("a")
          .on(t.orgId, t.createdAt.desc(), t.id.desc())
          .where(sql`${t.deletedAt} is null`),
      ],
      { sort: { defaults: createdDesc } },
    );
    expect(byRule(unmentioned.resource.checkIndexes(), "default-sort-unindexed")[0]?.level).toBe(
      "error",
    );
  });

  it("explains Drizzle's nulls placement on a nullable descending column", () => {
    const sort = { defaults: [{ key: "deletedAt", dir: "desc" }] };
    const drizzleStyle = setup((t) => [index("a").on(t.orgId, t.deletedAt.desc(), t.id.desc())], {
      sort,
    });
    const [finding] = byRule(drizzleStyle.resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.message).toContain("nullsFirst");
    expect(finding?.fix?.drizzle).toContain("t.deletedAt.desc().nullsFirst()");
    const fixed = setup(
      (t) => [index("a").on(t.orgId, t.deletedAt.desc().nullsFirst(), t.id.desc())],
      { sort },
    );
    expect(byRule(fixed.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
    const reverse = setup((t) => [index("a").on(t.orgId, t.deletedAt.asc(), t.id)], { sort });
    expect(byRule(reverse.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("compares text scope values without case, as the engine does", () => {
    const scope = (f: any, ctx: any) => f.is("tenant", ctx.tenant);
    const plain = setup((t) => [index("a").on(t.tenant, t.createdAt, t.id)], {
      scope,
      sort: { defaults: createdDesc },
    });
    const [finding] = byRule(plain.resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("error");
    expect(finding?.message).toContain("filters.caseSensitive");
    expect(finding?.fix?.drizzle).toContain("sql`lower(${t.tenant})`");
    expect(finding?.fix?.sql).toContain("lower(tenant)");

    const caseSensitive = setup((t) => [index("a").on(t.tenant, t.createdAt, t.id)], {
      scope,
      filters: { caseSensitive: ["tenant"] },
      sort: { defaults: createdDesc },
    });
    expect(byRule(caseSensitive.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);

    const expression = setup((t) => [index("a").on(sql`lower(${t.tenant})`, t.createdAt, t.id)], {
      scope,
      sort: { defaults: createdDesc },
    });
    expect(byRule(expression.resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("serves a default sort with no declared sort from the primary key when there is no scope", () => {
    const { resource } = setup(() => [], { scope: undefined });
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("warns that the primary key filters by scope when the default sort is id", () => {
    const { resource } = setup(() => []);
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("served by index orders_pkey");
    expect(finding?.message).toContain("orgId filters row by row");
  });

  it("stops at a unique column: nothing after it can tie", () => {
    const { resource } = setup(() => [], {
      scope: undefined,
      sort: { defaults: [{ key: "reference", dir: "desc" }] },
    });
    // `reference` is unique, so the unique constraint serves it backwards and no id column is needed
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("serves a sort by a scoped composite primary key without an id column", () => {
    const memberships = pgTable(
      "memberships",
      {
        orgId: uuid("org_id").notNull(),
        userId: uuid("user_id").notNull(),
        role: text("role").notNull(),
      },
      (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
    );
    const schema = { memberships };
    const relations = defineRelations(schema, () => ({}));
    const engine = createQueryEngine({
      db: drizzle.mock({ relations }),
      schema,
      relations,
    });
    const scoped = engine.defineResource("memberships", {
      query: {
        scope: (f: any) => f.is("orgId", "x"),
        sort: { defaults: [{ key: "userId", dir: "asc" }] },
      },
    } as never) as any;
    expect(byRule(scoped.checkIndexes(), "default-sort-unindexed")).toEqual([]);
    const unscoped = engine.defineResource("memberships", {
      query: { sort: { defaults: [{ key: "userId", dir: "asc" }] } },
    } as never) as any;
    expect(byRule(unscoped.checkIndexes(), "default-sort-unindexed")[0]?.level).toBe("error");
  });
});

describe("checkIndexes: mixed directions", () => {
  const mixed = [
    { key: "createdAt", dir: "desc" },
    { key: "status", dir: "asc" },
  ];

  it("reports a mixed sort that no index serves, with the exact index", () => {
    const { resource } = setup(
      (t) => [index("all_desc").on(t.orgId, t.createdAt.desc(), t.status.desc(), t.id.desc())],
      {
        sort: { defaults: mixed },
      },
    );
    const [finding] = byRule(resource.checkIndexes(), "mixed-direction-sort");
    expect(finding).toMatchObject({
      level: "warn",
      message:
        "default sort createdAt desc, status asc, id asc under scope orgId mixes directions: no index serves it",
      fix: {
        drizzle:
          'index("orders_org_id_created_at_status_id_idx").on(t.orgId, t.createdAt.desc(), t.status, t.id)',
        sql: "create index orders_org_id_created_at_status_id_idx on orders (org_id, created_at desc, status, id);",
      },
    });
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
  });

  it("accepts the exact mixed index and its mirror image", () => {
    for (const make of [
      (t: any) => index("a").on(t.orgId, t.createdAt.desc(), t.status, t.id),
      (t: any) => index("b").on(t.orgId, t.createdAt, t.status.desc(), t.id.desc()),
    ]) {
      const { resource } = setup((t) => [make(t)], { sort: { defaults: mixed } });
      expect(byRule(resource.checkIndexes(), "mixed-direction-sort")).toEqual([]);
    }
  });
});

describe("checkIndexes: other sorts", () => {
  it("lists sortable columns with no index in one finding, with one index each", () => {
    const { resource } = setup((t) => [index("a").on(t.orgId, t.status, t.id)], {
      sort: {
        disabled: [
          "deletedAt",
          "reference",
          "accountId",
          "tenant",
          "account.id",
          "account.name",
          "account.orgId",
        ],
      },
    });
    const [finding] = byRule(resource.checkIndexes(), "sort-unindexed");
    expect(finding?.fields).toEqual(["createdAt", "total"]);
    expect(finding?.fix?.sql.split("\n")).toEqual([
      "create index orders_org_id_created_at_id_idx on orders (org_id, created_at, id);",
      "create index orders_org_id_total_id_idx on orders (org_id, total, id);",
    ]);
  });

  it("does not repeat the default sort and its reverse", () => {
    const { resource } = setup(() => [], {
      sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
    });
    expect(byRule(resource.checkIndexes(), "sort-unindexed")[0]?.fields).not.toContain("createdAt");
  });

  it("reports sorts through a relation, and an error when it is the default", () => {
    const { resource } = setup(() => [], { sort: { disabled: [] } });
    const [finding] = byRule(resource.checkIndexes(), "relation-sort");
    expect(finding).toMatchObject({
      level: "warn",
      fields: ["account.id", "account.name", "account.orgId"],
    });
    expect(finding?.message).toBe(
      "sort account.id, account.name, account.orgId joins every row of orders first: disable it or copy id, name, orgId onto orders",
    );
    const asDefault = setup(() => [], {
      sort: { defaults: [{ key: "account.name", dir: "asc" }] },
    });
    expect(
      asDefault.resource
        .checkIndexes()
        .find((candidate: IndexFinding) => candidate.level === "error"),
    ).toMatchObject({ rule: "relation-sort", fields: ["account.name"] });
  });

  it("leaves a sort alone when it is disabled", () => {
    const { resource } = setup(() => [], {
      sort: {
        disabled: ["account.id", "account.name", "account.orgId", "createdAt", "total", "status"],
      },
    });
    expect(byRule(resource.checkIndexes(), "relation-sort")).toEqual([]);
    expect(byRule(resource.checkIndexes(), "sort-unindexed")[0]?.fields).not.toContain("createdAt");
  });
});

describe("checkIndexes: fixes", () => {
  it("quotes names PostgreSQL reserves", () => {
    const user = pgTable("user", {
      id: uuid("id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      order: integer("order").notNull(),
      group: text("group").notNull(),
    });
    const schema = { user };
    const relations = defineRelations(schema, () => ({}));
    const resource = createQueryEngine({
      db: drizzle.mock({ relations }),
      schema,
      relations,
    }).defineResource("user", {
      query: {
        scope: (f: any) => f.is("orgId", "x"),
        sort: { defaults: [{ key: "order", dir: "asc" }] },
      },
    } as never) as any;
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.fix?.sql).toBe(
      'create index user_org_id_order_id_idx on "user" (org_id, "order", id);',
    );
    const [unindexed] = byRule(resource.checkIndexes(), "sort-unindexed");
    expect(unindexed?.fix?.sql).toContain('(org_id, "group", id)');
  });

  it("never asks for the same index twice, and never to sort by a scope column", () => {
    const { resource } = setup(() => [], {
      sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
    });
    const findings = resource.checkIndexes();
    const [unindexed] = byRule(findings, "sort-unindexed");
    expect(unindexed?.fields).not.toContain("orgId");
    const statements = unindexed?.fix?.sql.split("\n") ?? [];
    expect(new Set(statements).size).toBe(statements.length);
  });

  it("keeps the id tie-breaker behind a unique column that can be null", () => {
    const codes = pgTable("codes", {
      id: uuid("id").primaryKey(),
      code: text("code").unique(),
    });
    const schema = { codes };
    const relations = defineRelations(schema, () => ({}));
    const resource = createQueryEngine({
      db: drizzle.mock({ relations }),
      schema,
      relations,
    }).defineResource("codes", {
      query: { sort: { defaults: [{ key: "code", dir: "asc" }] } },
    } as never) as any;
    const [finding] = byRule(resource.checkIndexes(), "default-sort-unindexed");
    expect(finding?.level).toBe("warn");
    expect(finding?.message).toContain("id tie-breaker");
  });

  it("does not report twice a resource defined twice the same way", () => {
    const orders = makeOrders();
    const schema = { orders };
    const relations = defineRelations(schema, () => ({}));
    const engine = createQueryEngine({ db: drizzle.mock({ relations }), schema, relations });
    const define = () =>
      engine.defineResource("orders", {
        query: { scope: (f: any) => f.is("orgId", "x") },
      } as never);
    const kept = [define(), define()];
    const findings = engine.checkIndexes();
    expect(byRule(findings, "default-sort-unindexed")).toHaveLength(1);
    expect(kept).toHaveLength(2);
  });
});

describe("checkIndexes: scope, facets and search", () => {
  it("reports a scope that reads a column through a join", () => {
    const { resource } = setup(() => [], {
      scope: (f: any, ctx: any) => f.and([f.is("account.orgId", ctx.orgId)]),
      filters: { hidden: ["account.orgId"] },
    });
    expect(byRule(resource.checkIndexes(), "scope-through-relation")).toMatchObject([
      {
        level: "warn",
        fields: ["account.orgId"],
        message: "scope account.orgId goes through a join: put orgId on orders",
      },
    ]);
  });

  it("reports a facet through a to-many relation, and the join column when it has no index", () => {
    const missing = setup(() => [], { facets: { allowed: ["status", "lines.sku"] } });
    const [finding] = byRule(missing.resource.checkIndexes(), "many-to-many-facet");
    expect(finding).toMatchObject({
      level: "warn",
      fields: ["lines.sku"],
      fix: {
        drizzle: 'index("order_lines_order_id_idx").on(t.orderId)',
        sql: "create index order_lines_order_id_idx on order_lines (order_id);",
      },
    });
    expect(finding?.message).toContain("to-many relation lines");
  });

  it("does not ask for a join index that exists", () => {
    const indexedLines = pgTable(
      "order_lines",
      {
        id: uuid("id").primaryKey(),
        orderId: uuid("order_id").notNull(),
        sku: text("sku").notNull(),
      },
      (t) => [index("by_order").on(t.orderId, t.sku)],
    );
    const orders = makeOrders();
    const schema = { accounts, lines: indexedLines, orders };
    const relations = defineRelations(schema, (r) => ({
      orders: { lines: r.many.lines({ from: r.orders.id, to: r.lines.orderId }) },
    }));
    const resource = createQueryEngine({
      db: drizzle.mock({ relations }),
      schema,
      relations,
    }).defineResource("orders", {
      relations: { lines: true },
      query: { facets: { allowed: ["lines.sku"] } },
    } as never) as any;
    const [finding] = byRule(resource.checkIndexes(), "many-to-many-facet");
    expect(finding?.fix).toBeUndefined();
  });

  it("says when search and facets are open to every field", () => {
    const { resource } = setup(() => [], { search: undefined, facets: undefined });
    const findings = byRule(resource.checkIndexes(), "open-surface");
    expect(findings.map((finding) => [finding.level, finding.message])).toEqual([
      [
        "info",
        "facets.allowed not set: all 15 fields can be requested as facets, 3 of them through to-many relations",
      ],
      [
        "info",
        "search.allowed not set: all 15 fields are searchable, including 10 that are not text",
      ],
    ]);
  });

  it("reports search fields that are not text", () => {
    const { resource } = setup(() => [], { search: { allowed: ["status", "total", "createdAt"] } });
    expect(byRule(resource.checkIndexes(), "search-numbers")).toMatchObject([
      { level: "info", fields: ["total", "createdAt"] },
    ]);
  });

  it("skips what a custom strategy replaces", () => {
    const { resource } = setup(
      () => [],
      {},
      { strategy: { ids: () => ({ ids: [], pageInfo: {} }) } },
    );
    expect(byRule(resource.checkIndexes(), "default-sort-unindexed")).toEqual([]);
    expect(byRule(resource.checkIndexes(), "sort-unindexed")).toEqual([]);
  });

  it("explains how to read a scope that throws", () => {
    const { resource } = setup(() => [], {
      scope: (_f: any, ctx: any) => ctx.user.orgId.deep.nope(),
    });
    expect(() => resource.checkIndexes()).not.toThrow();
    const strict = setup(() => [], {
      scope: (f: any, ctx: any) => {
        if (!ctx.orgId) throw new Error("no org");
        return f.is("orgId", ctx.orgId);
      },
    });
    expect(() => strict.resource.checkIndexes({ context: {} })).toThrow(/Pass \{ context \}/);
    expect(
      byRule(strict.resource.checkIndexes({ context: { orgId: "x" } }), "default-sort-unindexed"),
    ).toHaveLength(1);
  });
});

describe("engine.checkIndexes", () => {
  it("covers every resource of the engine, including those from withContext", () => {
    const orders = makeOrders();
    const schema = { accounts, orders };
    const relations = defineRelations(schema, () => ({}));
    const base = createQueryEngine({ db: drizzle.mock({ relations }), schema, relations });
    const scoped = base.withContext<{ orgId: string }>();
    scoped.defineResource("orders", {
      query: { scope: (f: any, ctx: any) => f.is("orgId", ctx.orgId) },
    } as never);
    base.defineResource("accounts", {} as never);
    const findings = base.checkIndexes();
    expect(new Set(findings.map((finding) => finding.resource))).toEqual(
      new Set(["orders", "accounts"]),
    );
    expect(scoped.checkIndexes()).toEqual(findings);
    expect(byRule(findings, "default-sort-unindexed").map((finding) => finding.resource)).toEqual([
      "orders",
    ]);
  });

  it("returns only plain data", () => {
    const { engine } = setup(() => [], {
      sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
    });
    const findings = engine.checkIndexes();
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);
    expect(findings.filter((finding) => finding.level === "error")).toHaveLength(1);
  });

  it("orders errors before warnings before information", () => {
    const { engine } = setup(() => [], { search: undefined });
    const levels = engine.checkIndexes().map((finding) => finding.level);
    expect(levels).toEqual(
      [...levels].sort(
        (a, b) => ["error", "warn", "info"].indexOf(a) - ["error", "warn", "info"].indexOf(b),
      ),
    );
  });
});

describe("formatIndexFindings", () => {
  it("prints the level, the resource, the message and the fix", () => {
    const { engine } = setup(() => [], {
      sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
      scope: (f: any, ctx: any) => f.is("account.orgId", ctx.orgId),
      filters: { hidden: ["account.orgId"] },
      facets: { allowed: ["status"] },
      search: { allowed: ["status", "total"] },
    });
    const output = formatIndexFindings(
      engine.checkIndexes().filter((finding) => finding.rule !== "sort-unindexed"),
    );
    expect(output).toBe(
      [
        "error  orders  default sort createdAt desc, id desc has no index",
        '               index("orders_created_at_id_idx").on(t.createdAt.desc(), t.id.desc())',
        "warn   orders  sort account.id, account.name joins every row of orders first: disable it or copy id, name onto orders",
        "warn   orders  scope account.orgId goes through a join: put orgId on orders",
        "info   orders  search field total is not text: it is cast to text and compared row by row, and no index can help",
      ].join("\n"),
    );
  });

  it("says so when there is nothing to report", () => {
    expect(formatIndexFindings([])).toBe("No index findings.");
  });
});

// The schema and resource of tools/benchmark-postgres.ts, which that file builds against a live
// database and so cannot be imported here.
describe("checkIndexes on the benchmark schema", () => {
  const namespace = pgSchema("resource_bench");
  const benchAccounts = namespace.table("accounts", {
    id: integer().primaryKey(),
    name: text().notNull(),
    type: text().notNull(),
  });
  const consumption = namespace.table(
    "consumption",
    {
      id: integer().primaryKey(),
      accountId: integer().notNull(),
      year: integer().notNull(),
      month: integer().notNull(),
      billed: boolean().notNull(),
      reference: text().notNull(),
    },
    (table) => [index().on(table.year, table.month, table.id), index().on(table.accountId)],
  );
  const schema = { accounts: benchAccounts, consumption };
  const relations = defineRelations(schema, (r) => ({
    consumption: { account: r.one.accounts({ from: r.consumption.accountId, to: r.accounts.id }) },
  }));
  const engine = createQueryEngine({ db: drizzle.mock({ relations }), schema, relations });
  const define = (defaults?: Array<{ key: string; dir: "asc" | "desc" }>) =>
    engine.defineResource("consumption", {
      relations: { account: true },
      query: {
        pagination: { modes: ["offset", "cursor"] },
        facets: { allowed: ["year", "month", "billed", "account.name", "account.type"] },
        ...(defaults ? { sort: { defaults } } : {}),
      },
    } as never) as any;

  it("does not flag the default sort that index(year, month, id) serves backwards", () => {
    const resource = define([
      { key: "year", dir: "desc" },
      { key: "month", dir: "desc" },
    ]);
    const findings = resource.checkIndexes();
    expect(byRule(findings, "default-sort-unindexed")).toEqual([]);
    expect(byRule(findings, "mixed-direction-sort")).toEqual([]);
  });

  it("reports the mixed-direction sort year desc, month desc, id asc", () => {
    const resource = define([
      { key: "year", dir: "desc" },
      { key: "month", dir: "desc" },
      { key: "id", dir: "asc" },
    ]);
    expect(byRule(resource.checkIndexes(), "mixed-direction-sort")).toMatchObject([
      {
        level: "warn",
        message: "default sort year desc, month desc, id asc mixes directions: no index serves it",
        fix: {
          drizzle: 'index("consumption_year_month_id_idx").on(t.year.desc(), t.month.desc(), t.id)',
          sql: "create index consumption_year_month_id_idx on resource_bench.consumption (year desc, month desc, id);",
        },
      },
    ]);
  });

  it("reports the relation sort on account.name", () => {
    const [finding] = byRule(define().checkIndexes(), "relation-sort");
    expect(finding?.fields).toContain("account.name");
    expect(finding?.message).toContain("joins every row of consumption first");
  });
});

describe("confirmDefaultSort", () => {
  const info = {
    label: "createdAt desc, id desc",
    scope: " under scope orgId",
    fields: ["createdAt", "id"],
  };
  const finding = (level: "error" | "warn") => ({
    resource: "orders",
    level,
    rule: "default-sort-unindexed" as const,
    message: "default sort createdAt desc, id desc under scope orgId has no index",
    fields: info.fields,
  });
  const scan = (...nodes: Array<[string, number, string?]>) => ({
    nodes: nodes.map(([type, rows, name]) => ({ type, rows, index: name })),
  });

  it("downgrades an error when PostgreSQL reads an index in order with no sort", () => {
    const found = finding("error");
    confirmDefaultSort(
      "orders",
      { ...info, finding: found },
      [found],
      scan(["Limit", 25], ["Index Scan", 900, "orders_pkey"]),
    );
    expect(found.level).toBe("warn");
    expect(found.message).toContain("reads index orders_pkey in order and filters row by row");
    expect(found.message).toContain("Confirmed by EXPLAIN");
  });

  it("upgrades a warning when PostgreSQL sorts every matching row", () => {
    const found = finding("warn");
    confirmDefaultSort(
      "orders",
      { ...info, finding: found },
      [found],
      scan(["Limit", 25], ["Sort", 900], ["Seq Scan", 900]),
    );
    expect(found.level).toBe("error");
  });

  it("raises a mixed-direction warning to an error when PostgreSQL sorts", () => {
    const found = { ...finding("warn"), rule: "mixed-direction-sort" as const };
    confirmDefaultSort(
      "orders",
      { ...info, finding: found },
      [found],
      scan(["Limit", 25], ["Sort", 900], ["Seq Scan", 900]),
    );
    expect(found.level).toBe("error");
    expect(found.message).toContain("Confirmed by EXPLAIN");
  });

  it("adds an error for an index that serves the sort on paper but is not used", () => {
    const findings: ReturnType<typeof finding>[] = [];
    confirmDefaultSort(
      "orders",
      { ...info, servedBy: "orders_a_idx" },
      findings,
      scan(["Sort", 900], ["Seq Scan", 900]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("looks served by index orders_a_idx");
    const none: ReturnType<typeof finding>[] = [];
    confirmDefaultSort(
      "orders",
      { ...info, servedBy: "a" },
      none,
      scan(["Sort", 1], ["Index Scan", 1, "a"]),
    );
    expect(none).toEqual([]);
  });
});
