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
          compiled.push(utils.compileCondition(isNullCondition));
          compiled.push(utils.compileCondition(isNotNullCondition));
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
  });
});
