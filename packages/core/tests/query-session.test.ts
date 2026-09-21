import { defineRelationsPart } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import type { SQL } from "drizzle-orm";

import { createQueryEngine } from "../index.js";
import type { QueryFilterCondition, QueryRequest } from "../index.js";

const items = pgTable("items", {
  id: text().primaryKey(),
  name: text(),
});

const schema = { items };
const relations = defineRelationsPart(schema, () => ({ items: {} }));

const relationParents = pgTable("relation_parent", {
  id: text().primaryKey(),
});

const relationChildren = pgTable("relation_child", {
  id: text().primaryKey(),
  parentId: text("parent_id"),
});

const relationSchema = { relationParents, relationChildren };
const relationGraph = defineRelationsPart(
  relationSchema,
  ({ relationParents: parents, relationChildren: children, many }) => ({
    relationParents: {
      children: many.relationChildren({
        from: parents.id,
        to: children.parentId,
      }),
    },
    relationChildren: {},
  }),
);

type Item = { id: string; name: string };

function makeDatabase(label: string) {
  const calls: unknown[] = [];
  return {
    calls,
    query: {
      items: {
        findMany: async (args?: unknown): Promise<Item[]> => {
          calls.push(args);
          await new Promise((resolve) => setTimeout(resolve, label === "tx-a" ? 4 : 1));
          return [{ id: label, name: label }];
        },
      },
    },
  };
}

const baseRequest: QueryRequest = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 1, count: "none" },
  sorting: [],
  filters: [],
  search: { value: "", fields: [] },
  context: {},
};

const pageInfo = {
  mode: "offset" as const,
  pageIndex: 1,
  pageSize: 1,
  hasNextPage: false,
  count: "none" as const,
  rowCount: null,
};

describe("per-call query database", () => {
  it("keeps concurrent transaction overrides isolated across ids and rows stages", async () => {
    const defaultDb = makeDatabase("default");
    const txA = makeDatabase("tx-a");
    const txB = makeDatabase("tx-b");
    const engine = createQueryEngine({ db: defaultDb, schema, relations });
    const resource = engine.defineResource("items", {
      strategy: {
        ids: async ({ request, utils }) => {
          const rows = await utils.executeRowsQuery({ ids: ["selected"], request });
          return { ids: rows.map(({ id }) => id), pageInfo };
        },
        rows: async ({ request, ids, utils }) => utils.executeRowsQuery({ ids, request }),
      },
    });

    const [resultA, resultB, resultDefault] = await Promise.all([
      resource.query({ request: baseRequest, db: txA }),
      resource.query({ request: baseRequest, db: txB }),
      resource.query({ request: baseRequest }),
    ]);

    expect(resultA.rows).toEqual([{ id: "tx-a", name: "tx-a" }]);
    expect(resultB.rows).toEqual([{ id: "tx-b", name: "tx-b" }]);
    expect(resultDefault.rows).toEqual([{ id: "default", name: "default" }]);
    expect(txA.calls).toHaveLength(2);
    expect(txB.calls).toHaveLength(2);
    expect(defaultDb.calls).toHaveLength(2);

    const ids = await resource.queryIds({ request: baseRequest, db: txA });
    const rows = await resource.queryRows({ request: baseRequest, ids: ids.ids, db: txA });
    expect(ids.ids).toEqual(["tx-a"]);
    expect(rows).toEqual([{ id: "tx-a", name: "tx-a" }]);
    expect(txA.calls).toHaveLength(4);
    expect(defaultDb.calls).toHaveLength(2);
  });
});

describe("null filter SQL", () => {
  it("uses SQL null predicates instead of equality with a null parameter", async () => {
    const database = makeDatabase("null-test");
    const compiled: SQL[] = [];
    const engine = createQueryEngine({ db: database, schema, relations });
    const resource = engine.defineResource("items", {
      strategy: {
        query: async ({ utils }) => {
          const isNullCondition: QueryFilterCondition = {
            type: "condition",
            key: "name",
            operator: "is",
            value: null,
          };
          const isNotNullCondition: QueryFilterCondition = {
            type: "condition",
            key: "name",
            operator: "isNot",
            value: null,
          };
          const isNotTextCondition: QueryFilterCondition = {
            type: "condition",
            key: "name",
            operator: "isNot",
            value: "Ada",
          };
          const isAnyOfTextCondition: QueryFilterCondition = {
            type: "condition",
            key: "name",
            operator: "isAnyOf",
            value: ["Ada", "Grace"],
          };
          compiled.push(utils.compileCondition(isNullCondition));
          compiled.push(utils.compileCondition(isNotNullCondition));
          compiled.push(utils.compileCondition(isNotTextCondition));
          compiled.push(utils.compileCondition(isAnyOfTextCondition));
          return { rows: [], pageInfo };
        },
      },
    });

    await resource.query({ request: baseRequest });

    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(compiled[0]!)).toEqual({
      sql: '("items"."name" is null)',
      params: [],
    });
    expect(dialect.sqlToQuery(compiled[1]!)).toEqual({
      sql: '("items"."name" is not null)',
      params: [],
    });
    const isNotTextQuery = dialect.sqlToQuery(compiled[2]!);
    expect(isNotTextQuery.sql).toContain('not (lower("items"."name") = $1)');
    expect(isNotTextQuery.params).toEqual(["ada"]);
    const isAnyOfTextQuery = dialect.sqlToQuery(compiled[3]!);
    expect(isAnyOfTextQuery.sql).toContain('lower("items"."name") = $1');
    expect(isAnyOfTextQuery.params).toEqual(["ada", "grace"]);
  });
});

describe("native relation SQL", () => {
  it("preserves configured casing for root and relation equality filters", async () => {
    const rootCompiled: SQL[] = [];
    const relationCompiled: SQL[] = [];
    const database = {
      query: {
        relationParents: { findMany: async () => [] },
        relationChildren: { findMany: async () => [] },
      },
      select: () => ({
        from() {
          return this;
        },
        where(condition: SQL) {
          relationCompiled.push(condition);
          return this;
        },
      }),
    };

    const resource = createQueryEngine({
      db: database,
      schema: relationSchema,
      relations: relationGraph,
    }).defineResource("relationParents", {
      relations: {
        children: true,
      },
      query: {
        filters: {
          caseSensitive: ["id", "children.parentId"],
        },
      },
      strategy: {
        query: async ({ utils }) => {
          rootCompiled.push(
            utils.compileCondition({
              type: "condition",
              key: "id",
              operator: "is",
              value: "Acct_1",
            }),
          );
          rootCompiled.push(
            utils.compileCondition({
              type: "condition",
              key: "id",
              operator: "isAnyOf",
              value: ["Acct_1", "Acct_2"],
            }),
          );
          rootCompiled.push(
            utils.compileCondition({
              type: "condition",
              key: "id",
              operator: "isNot",
              value: "Acct_1",
            }),
          );
          utils.compileCondition({
            type: "condition",
            key: "children.parentId",
            operator: "is",
            value: "Acct_1",
          });
          utils.compileCondition({
            type: "condition",
            key: "children.parentId",
            operator: "isAnyOf",
            value: ["Acct_1", "Acct_2"],
          });
          utils.compileCondition({
            type: "condition",
            key: "children.parentId",
            operator: "isNot",
            value: "Acct_1",
          });
          return { rows: [], pageInfo };
        },
      },
    });

    await resource.query({ request: baseRequest });

    expect(rootCompiled).toHaveLength(3);
    expect(relationCompiled).toHaveLength(3);

    const dialect = new PgDialect();
    const rootIsQuery = dialect.sqlToQuery(rootCompiled[0]!);
    expect(rootIsQuery).toEqual({
      sql: '"relation_parent"."id" = $1',
      params: ["Acct_1"],
    });

    const rootAnyOfQuery = dialect.sqlToQuery(rootCompiled[1]!);
    expect(rootAnyOfQuery.sql).not.toContain("lower(");
    expect(rootAnyOfQuery.params).toEqual(["Acct_1", "Acct_2"]);

    const rootIsNotQuery = dialect.sqlToQuery(rootCompiled[2]!);
    expect(rootIsNotQuery.sql).toContain('not ("relation_parent"."id" = $1)');
    expect(rootIsNotQuery.params).toEqual(["Acct_1"]);

    const relationIsQuery = dialect.sqlToQuery(relationCompiled[0]!);
    expect(relationIsQuery.sql).toContain('"relation_parent"."id" = "relation_child"."parent_id"');
    expect(relationIsQuery.sql).toContain('"relation_child"."parent_id" = $1');
    expect(relationIsQuery.sql).not.toContain("lower(");
    expect(relationIsQuery.params).toEqual(["Acct_1"]);

    const relationAnyOfQuery = dialect.sqlToQuery(relationCompiled[1]!);
    expect(relationAnyOfQuery.sql).not.toContain("lower(");
    expect(relationAnyOfQuery.params).toEqual(["Acct_1", "Acct_2"]);

    const relationIsNotQuery = dialect.sqlToQuery(relationCompiled[2]!);
    expect(relationIsNotQuery.sql).toContain('not ("relation_child"."parent_id" = $1)');
    expect(relationIsNotQuery.sql).not.toContain("lower(");
    expect(relationIsNotQuery.params).toEqual(["Acct_1"]);
  });
});

describe("facet SQL", () => {
  it("aggregates the filtered root query without materializing matching ids", async () => {
    const statements: string[] = [];
    const database = drizzle({
      client: {
        query: async (query: { text: string }) => {
          statements.push(query.text);
          return { rows: [["Ada", 2, 1]] };
        },
      } as never,
      schema,
      relations,
    });
    const resource = createQueryEngine({ db: database, schema, relations }).defineResource(
      "items",
      {
        query: { facets: { allowed: ["name"] } },
      },
    );

    const result = await resource.queryFacets({
      request: baseRequest,
      facets: [{ key: "name", mode: "exclude-self", limit: 10 }],
    });

    expect(result.facets).toEqual([
      {
        key: "name",
        options: [{ value: "Ada", count: 2 }],
        nextCursor: null,
        total: 1,
      },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("facet_matching_ids");
    expect(statements[0]).toContain("count(*)");
  });
});
