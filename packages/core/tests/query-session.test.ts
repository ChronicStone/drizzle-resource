import { defineRelationsPart } from "drizzle-orm";
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
const relations = { items: {} };

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
          compiled.push(utils.compileCondition(isNullCondition));
          compiled.push(utils.compileCondition(isNotNullCondition));
          compiled.push(utils.compileCondition(isNotTextCondition));
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
  });
});

describe("native relation SQL", () => {
  it("unwraps RC5 relation columns before compiling scope predicates", async () => {
    const compiled: SQL[] = [];
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
          compiled.push(condition);
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
      strategy: {
        query: async ({ utils }) => {
          utils.compileCondition({
            type: "condition",
            key: "children.parentId",
            operator: "is",
            value: "acct_1",
          });
          return { rows: [], pageInfo };
        },
      },
    });

    await resource.query({ request: baseRequest });

    expect(compiled).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(compiled[0]!);
    expect(query.sql).toContain('"relation_parent"."id" = "relation_child"."parent_id"');
    expect(query.sql).toContain('lower("relation_child"."parent_id") = $1');
    expect(query.params).toEqual(["acct_1"]);
    expect(query.params.every((param) => typeof param !== "object")).toBe(true);
  });
});
