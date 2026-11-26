import { randomUUID } from "node:crypto";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";
import type { IndexFinding } from "../index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const namespace = pgSchema(`resource_idx_${randomUUID().replaceAll("-", "")}`);

function eventTable(name: string, extra?: (table: any) => any[]) {
  return namespace.table(
    name,
    {
      id: integer().primaryKey(),
      orgId: integer("org_id").notNull(),
      tenant: text().notNull(),
      createdAt: timestamp("created_at").notNull(),
      deletedAt: timestamp("deleted_at"),
      label: text().notNull(),
      slug: text(),
    },
    extra,
  );
}

/** One table per way an index can, or cannot, serve the sort. The indexes live only in the database. */
const variants = {
  fwd: "(org_id, created_at desc, id desc)",
  rev: "(org_id, created_at, id)",
  noid: "(org_id, created_at desc)",
  none: undefined,
  mixedall: "(org_id, created_at desc, label desc, id desc)",
  mixedexact: "(org_id, created_at desc, label, id)",
  nullslast: "(org_id, deleted_at desc nulls last, id desc)",
  nullsfirst: "(org_id, deleted_at desc, id desc)",
  lowerplain: "(tenant, created_at desc, id desc)",
  lowerexpr: "(lower(tenant), created_at desc, id desc)",
  extraeq: "(org_id, created_at desc, id desc)",
  partialimplied: "(org_id, created_at desc, id desc) where deleted_at is null",
  // the scope does not mention deleted_at: a request could, but the scope cannot promise it
  partialunverified: "(org_id, created_at desc, id desc) where deleted_at is null",
  extraeqvalue: "(org_id, created_at desc, id desc)",
  softnoid: "(org_id, created_at desc)",
  skipleading: "(deleted_at, created_at desc, id desc)",
  nullprefix: "(org_id, deleted_at, created_at desc, id desc)",
  unrelatedpartial: "(org_id, created_at desc, id desc) where label <> ''",
  contradicted: "(org_id, created_at desc, id desc) where deleted_at is not null",
  unverifiedlegit: "(org_id, created_at desc, id desc) where tenant = 't1'",
  uniquenullable: undefined,
  // the same equalities, listed in either order, served by either one
  orderflip: "(org_id, created_at desc, id desc)",
  tenantindex: "(tenant, created_at desc, id desc)",
} as const;
type Variant = keyof typeof variants;
const variantNames = Object.keys(variants) as Variant[];

const tables = Object.fromEntries(variantNames.map((name) => [name, eventTable(name)]));
// The schema declares an index that the database does not have, and the reverse.
const declared = eventTable("declared", (t) => [
  index("declared_idx").on(t.orgId, t.createdAt.desc(), t.id.desc()),
]);
const undeclared = eventTable("undeclared");
const searchable = eventTable("searchable");
const searchableIndexed = eventTable("searchable_indexed");
const neverAnalyzed = eventTable("never_analyzed");
const schema = {
  ...tables,
  declared,
  undeclared,
  searchable,
  searchableIndexed,
  neverAnalyzed,
} as Record<string, ReturnType<typeof eventTable>>;
const relations = defineRelations(schema as any, () => ({})) as any;

const pool = new Pool({ connectionString, max: 4 });
const statements: Array<{ query: string; params: unknown[] }> = [];
const db = drizzle({
  client: pool,
  relations,
  logger: {
    logQuery(query, params) {
      statements.push({ query, params });
    },
  },
});
const engine = createQueryEngine({ db, schema: schema as any, relations });

const sortDefaults: Partial<Record<Variant, Array<{ key: string; dir: "asc" | "desc" }>>> = {
  mixedall: [
    { key: "createdAt", dir: "desc" },
    { key: "label", dir: "asc" },
  ],
  mixedexact: [
    { key: "createdAt", dir: "desc" },
    { key: "label", dir: "asc" },
  ],
  nullslast: [{ key: "deletedAt", dir: "desc" }],
  nullsfirst: [{ key: "deletedAt", dir: "desc" }],
};
const caseSensitive: Partial<Record<Variant, string[]>> = {
  extraeqvalue: ["tenant"],
  unverifiedlegit: ["tenant"],
  uniquenullable: ["slug"],
  orderflip: ["tenant"],
  tenantindex: ["tenant"],
};
const scopes: Partial<Record<Variant, (f: any, ctx: any) => any>> = {
  lowerplain: (f) => f.is("tenant", "t1"),
  lowerexpr: (f) => f.is("tenant", "t1"),
  // an index on the org and the sort serves this: the second equality only filters
  extraeq: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  partialimplied: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  extraeqvalue: (f) => f.and([f.is("orgId", 1), f.is("tenant", "t1")]),
  softnoid: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  skipleading: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  nullprefix: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  contradicted: (f) => f.and([f.is("orgId", 1), f.is("deletedAt", null)]),
  unverifiedlegit: (f, ctx) => f.and([f.is("orgId", 1), f.is("tenant", ctx.tenant)]),
  // at most one row matches: the unique key is complete once slug has a value
  orderflip: (f) => f.and([f.is("tenant", "t1"), f.is("orgId", 1)]),
  tenantindex: (f) => f.and([f.is("orgId", 1), f.is("tenant", "t1")]),
  uniquenullable: (f) => f.and([f.is("orgId", 1), f.is("slug", "s1")]),
};
const resources = Object.fromEntries(
  variantNames.map((name) => [
    name,
    (engine as any).defineResource(name, {
      query: {
        filters: { caseSensitive: caseSensitive[name] ?? [] },
        scope: scopes[name] ?? ((f: any) => f.is("orgId", 1)),
        sort: { defaults: sortDefaults[name] ?? [{ key: "createdAt", dir: "desc" }] },
        search: { allowed: ["label"] },
        facets: { allowed: ["label"] },
      },
    }),
  ]),
) as Record<Variant, any>;
const defineSimple = (key: string, query: Record<string, unknown> = {}) =>
  (engine as any).defineResource(key, {
    query: { facets: { allowed: ["label"] }, scope: (f: any) => f.is("orgId", 1), ...query },
  });
const declaredResource = defineSimple("declared", {
  sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
});
const undeclaredResource = defineSimple("undeclared", {
  sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
});
const searchableResource = defineSimple("searchable", {
  search: { allowed: ["label"], defaults: ["label"] },
});
const searchableIndexedResource = defineSimple("searchableIndexed", {
  search: { allowed: ["label"], defaults: ["label"] },
});
const neverAnalyzedResource = defineSimple("neverAnalyzed", {
  search: { allowed: ["label"], defaults: ["label"] },
});

function fill(table: string, rows: number) {
  return sql`
    insert into ${sql.identifier(namespace.schemaName)}.${sql.identifier(table)}
      (id, org_id, tenant, created_at, deleted_at, label, slug)
    select i, i % 5, 't' || (i % 3),
      timestamp '2025-01-01' + i * interval '1 minute',
      case when i % 2 = 0 then null else timestamp '2026-01-01' + i * interval '1 minute' end,
      md5(i::text), 's' || i
    from generate_series(1, ${rows}) as i`;
}

const qualified = (table: string) => `${namespace.schemaName}."${table}"`;

/** Sorting one row costs nothing: only sort nodes that read more than a row count. */
function planNodes(plan: any): string[] {
  return [
    ...(plan["Plan Rows"] > 1 || !/Sort$/.test(plan["Node Type"])
      ? [plan["Node Type"] as string]
      : []),
    ...((plan.Plans ?? []) as any[]).flatMap((child) => planNodes(child)),
  ];
}

/** The plan PostgreSQL picks for the page query the engine runs. */
async function pagePlan(resource: any) {
  statements.length = 0;
  await resource.queryIds({
    request: {
      pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "none" },
      filters: [],
      search: { value: "", fields: [] },
      sorting: [],
    },
    context: { tenant: "t1" },
  });
  const page = statements.find((statement) => /order by/i.test(statement.query));
  if (!page) throw new Error("The engine did not run a page query");
  const result = await pool.query(`explain (format json) ${page.query}`, page.params as any[]);
  return planNodes(result.rows[0]["QUERY PLAN"][0].Plan);
}

function verdictOf(findings: IndexFinding[], resource: string) {
  const own = findings.filter(
    (finding) =>
      finding.resource === resource &&
      (finding.rule === "default-sort-unindexed" || finding.rule === "mixed-direction-sort"),
  );
  if (own.length === 0) return "served";
  if (own.some((finding) => finding.message.includes("row by row"))) return "filtered";
  if (own.some((finding) => finding.message.includes("cannot confirm"))) return "partial";
  if (own.some((finding) => finding.rule === "mixed-direction-sort")) return "mixed";
  return own[0]!.level === "error" ? "none" : "near";
}

describe.skipIf(!connectionString)("checkIndexes against PostgreSQL", () => {
  beforeAll(async () => {
    await db.execute(sql`create schema ${sql.identifier(namespace.schemaName)}`);
    await db.execute(sql`create extension if not exists pg_trgm`);
    const everyTable = [
      ...variantNames,
      "declared",
      "undeclared",
      "searchable",
      "searchable_indexed",
      "never_analyzed",
    ];
    for (const name of everyTable) {
      await db.execute(
        sql.raw(`create table ${qualified(name)} (
          id integer primary key, org_id integer not null, tenant text not null,
          created_at timestamp not null, deleted_at timestamp, label text not null, slug text)`),
      );
    }
    await db.execute(
      sql.raw(`create unique index on ${qualified("uniquenullable")} (org_id, slug)`),
    );
    for (const name of variantNames) {
      const columns = variants[name];
      if (columns) await db.execute(sql.raw(`create index on ${qualified(name)} ${columns}`));
    }
    await db.execute(
      sql.raw(`create index on ${qualified("undeclared")} (org_id, created_at desc, id desc)`),
    );
    await db.execute(
      sql.raw(
        `create index on ${qualified("searchable_indexed")} using gin (lower(label) gin_trgm_ops)`,
      ),
    );
    for (const name of [...variantNames, "declared", "undeclared"]) {
      await db.execute(fill(name, 20_000));
      await db.execute(sql.raw(`analyze ${qualified(name)}`));
    }
    for (const name of ["searchable", "searchable_indexed"]) {
      await db.execute(fill(name, 2_000));
      await db.execute(sql.raw(`analyze ${qualified(name)}`));
    }
    // loaded after the last analyse: PostgreSQL does not know its size yet
    await db.execute(fill("never_analyzed", 2_000));
  });

  afterAll(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(namespace.schemaName)} cascade`);
    await pool.end();
  });

  it("agrees with the plan PostgreSQL picks for the page query", async () => {
    const findings = await engine.checkIndexes({ live: true, context: { tenant: "t1" } });
    const observed: Record<string, { verdict: string; sorts: string[] }> = {};
    for (const name of variantNames) {
      observed[name] = {
        verdict: verdictOf(findings, name),
        sorts: (await pagePlan(resources[name])).filter((node) => /Sort$/.test(node)),
      };
    }
    expect(observed).toEqual({
      fwd: { verdict: "served", sorts: [] },
      rev: { verdict: "served", sorts: [] },
      noid: { verdict: "near", sorts: ["Incremental Sort"] },
      none: { verdict: "none", sorts: ["Sort"] },
      // the index serves created_at, so PostgreSQL only sorts the ties within it
      mixedall: { verdict: "mixed", sorts: ["Incremental Sort"] },
      mixedexact: { verdict: "served", sorts: [] },
      nullslast: { verdict: "none", sorts: ["Sort"] },
      nullsfirst: { verdict: "served", sorts: [] },
      lowerplain: { verdict: "none", sorts: ["Sort"] },
      lowerexpr: { verdict: "served", sorts: [] },
      // is null is not a column the index needs: it is a filter on the rows it reads
      extraeq: { verdict: "served", sorts: [] },
      extraeqvalue: { verdict: "filtered", sorts: [] },
      softnoid: { verdict: "near", sorts: ["Incremental Sort"] },
      skipleading: { verdict: "none", sorts: ["Sort"] },
      nullprefix: { verdict: "none", sorts: ["Sort"] },
      unrelatedpartial: { verdict: "none", sorts: ["Sort"] },
      contradicted: { verdict: "none", sorts: ["Sort"] },
      // the context gives the value, so the scope does state the partial index's condition
      unverifiedlegit: { verdict: "served", sorts: [] },
      orderflip: { verdict: "filtered", sorts: [] },
      tenantindex: { verdict: "filtered", sorts: [] },
      uniquenullable: { verdict: "served", sorts: [] },
      partialimplied: { verdict: "served", sorts: [] },
      partialunverified: { verdict: "none", sorts: ["Sort"] },
    });
  });

  it("reads the indexes of the database, not the ones of the schema", async () => {
    expect(
      declaredResource.checkIndexes().filter((finding: IndexFinding) => finding.level === "error"),
    ).toEqual([]);
    expect(
      undeclaredResource
        .checkIndexes()
        .filter((finding: IndexFinding) => finding.level === "error"),
    ).toHaveLength(1);
    const live = (resource: any) =>
      resource.checkIndexes({ live: true }) as Promise<IndexFinding[]>;
    expect(
      (await live(declaredResource)).filter((finding) => finding.level === "error"),
    ).toHaveLength(1);
    expect((await live(undeclaredResource)).filter((finding) => finding.level === "error")).toEqual(
      [],
    );
  });

  it("asks for a trigram index on a large table that has none", async () => {
    const options = { live: true, largeTable: { search: 1_000 } } as const;
    const [finding] = (await searchableResource.checkIndexes(options)).filter(
      (candidate: IndexFinding) => candidate.rule === "search-unindexed",
    );
    expect(finding).toMatchObject({
      level: "warn",
      fields: ["label"],
      message:
        "searching label has no trigram index and searchable has about 2k rows: each search reads all of them",
      fix: {
        sql: `create extension if not exists pg_trgm;\ncreate index searchable_label_trgm_idx on ${namespace.schemaName}.searchable using gin (lower(label) gin_trgm_ops);`,
      },
    });
    expect(finding?.fix?.drizzle).toBe(
      'index("searchable_label_trgm_idx").using("gin", sql`lower(${t.label}) gin_trgm_ops`)',
    );
    const indexed = await searchableIndexedResource.checkIndexes(options);
    expect(
      indexed.filter((candidate: IndexFinding) => candidate.rule === "search-unindexed"),
    ).toEqual([]);
    const small = await searchableResource.checkIndexes({ live: true });
    expect(
      small.filter((candidate: IndexFinding) => candidate.rule === "search-unindexed"),
    ).toEqual([]);
  });

  it("warns about an exact count only when the table is large and its size is known", async () => {
    const find = (findings: IndexFinding[]) =>
      findings.filter((finding) => finding.rule === "exact-count-large-table");
    const large = await searchableResource.checkIndexes({
      live: true,
      largeTable: { count: 1_000 },
    });
    expect(find(large)).toMatchObject([
      {
        level: "info",
        message: expect.stringContaining("searchable has about 2k rows"),
      },
    ]);
    expect(find(await searchableResource.checkIndexes({ live: true }))).toEqual([]);
    expect(
      find(await neverAnalyzedResource.checkIndexes({ live: true, largeTable: { count: 10 } })),
    ).toEqual([]);
    const cursor = (engine as any).defineResource("searchable", {
      query: {
        pagination: { modes: ["cursor"] },
        defaults: { pagination: { mode: "cursor" } },
      },
    });
    expect(find(await cursor.checkIndexes({ live: true, largeTable: { count: 10 } }))).toEqual([]);
  });

  it("says EXPLAIN confirmed a verdict, and still reads a partial index it cannot confirm", async () => {
    const findings = await engine.checkIndexes({ live: true, context: { tenant: "t1" } });
    const own = (name: string) =>
      findings.find(
        (finding) => finding.resource === name && finding.rule === "default-sort-unindexed",
      );
    expect(own("none")?.message).toContain(
      "Confirmed by EXPLAIN: PostgreSQL sorts every matching row",
    );
    expect(own("noid")?.message).toContain(
      "Confirmed by EXPLAIN: PostgreSQL uses an incremental sort",
    );
    expect(own("orderflip")?.message).toContain(
      "Confirmed by EXPLAIN: PostgreSQL reads an index in order, with no sort",
    );
    const noContext = (await resources.unverifiedlegit.checkIndexes({
      live: true,
    })) as IndexFinding[];
    expect(
      noContext.find((finding) => finding.rule === "default-sort-unindexed")?.message,
    ).toContain("cannot confirm");
  });

  it("explains a missing table", async () => {
    const ghost = namespace.table("ghost", { id: integer().primaryKey() });
    const ghostSchema = { ghost };
    const ghostRelations = defineRelations(ghostSchema, () => ({}));
    const ghostEngine = createQueryEngine({
      db: drizzle({ client: pool, relations: ghostRelations }),
      schema: ghostSchema,
      relations: ghostRelations,
    });
    ghostEngine.defineResource("ghost", {} as never);
    await expect(ghostEngine.checkIndexes({ live: true })).rejects.toThrow(/was not found/);
  });
});
