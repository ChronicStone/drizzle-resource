import { defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../index.js";

const employees = pgTable("employees", {
  id: uuid().primaryKey(),
  fullName: varchar({ length: 255 }).notNull(),
});
const schema = { employees };
const relations = defineRelationsPart(schema, () => ({ employees: {} }));

interface QueryTrace {
  countQueries: number;
  limits: number[];
  offsets: number[];
  cursorBoundaries: number;
}

function createDatabase(pages: Array<Array<Record<string, unknown>>>, rowCount = 0) {
  const trace: QueryTrace = { countQueries: 0, limits: [], offsets: [], cursorBoundaries: 0 };

  class QueryBuilder implements PromiseLike<any[]> {
    constructor(
      private readonly selection: Record<string, unknown>,
      private readonly result: any[],
      private readonly tracksCursorWhere = false,
    ) {}

    from() {
      return this;
    }
    innerJoin() {
      return this;
    }
    where() {
      if (this.tracksCursorWhere) trace.cursorBoundaries += 1;
      return this;
    }
    orderBy() {
      return this;
    }
    limit(value: number) {
      trace.limits.push(value);
      return this;
    }
    offset(value: number) {
      trace.offsets.push(value);
      return this;
    }
    then<TResult1 = any[], TResult2 = never>(
      onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.result).then(onfulfilled, onrejected);
    }
  }

  const db = {
    query: {
      employees: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          [...where.id.in].reverse().map((id) => ({
            id,
            fullName: id === "emp_1" ? "Ada" : id === "emp_2" ? "Grace" : "Linus",
          })),
      },
    },
    selectDistinct: (selection: Record<string, unknown>) => new QueryBuilder(selection, []),
    $with: () => ({
      as: () => ({ id: employees.id }),
    }),
    with: () => ({
      select: (selection: Record<string, unknown>) => {
        if ("rowCount" in selection) {
          trace.countQueries += 1;
          return new QueryBuilder(selection, [{ rowCount }]);
        }
        return new QueryBuilder(selection, pages.shift() ?? [], true);
      },
    }),
  };

  return { db, trace };
}

function request(cursor: string | null = null, count: "none" | "exact" = "none") {
  return {
    pagination: { mode: "cursor" as const, cursor, pageSize: 2, count },
    sorting: [{ key: "fullName", dir: "asc" as const }],
    filters: [],
    search: { value: "", fields: [] },
  };
}

describe("built-in cursor pagination", () => {
  it("uses lookahead instead of a count and resumes from the returned cursor", async () => {
    const { db, trace } = createDatabase([
      [
        { id: "emp_1", __cursor_0: "Ada", __cursor_1: "emp_1" },
        { id: "emp_2", __cursor_0: "Grace", __cursor_1: "emp_2" },
        { id: "emp_3", __cursor_0: "Linus", __cursor_1: "emp_3" },
      ],
      [{ id: "emp_3", __cursor_0: "Linus", __cursor_1: "emp_3" }],
    ]);
    const resource = createQueryEngine({ db, schema, relations }).defineResource("employees", {
      query: { pagination: { modes: ["cursor"] }, defaults: { pagination: { mode: "cursor" } } },
    });

    const first = await resource.query({ request: request() });
    expect(first.rows.map(({ id }) => id)).toEqual(["emp_1", "emp_2"]);
    expect(first.pageInfo).toMatchObject({ mode: "cursor", count: "none", rowCount: null });
    expect(first.pageInfo.mode === "cursor" && first.pageInfo.nextCursor).toEqual(
      expect.any(String),
    );

    const cursor = first.pageInfo.mode === "cursor" ? first.pageInfo.nextCursor : null;
    const second = await resource.query({ request: request(cursor) });
    expect(second.rows.map(({ id }) => id)).toEqual(["emp_3"]);
    expect(second.pageInfo).toMatchObject({ mode: "cursor", nextCursor: null });
    expect(trace).toEqual({
      countQueries: 0,
      limits: [3, 3],
      offsets: [0, 0],
      cursorBoundaries: 1,
    });
  });

  it("runs the exact count only when requested", async () => {
    const { db, trace } = createDatabase(
      [
        [
          { id: "emp_1", __cursor_0: "Ada", __cursor_1: "emp_1" },
          { id: "emp_2", __cursor_0: "Grace", __cursor_1: "emp_2" },
          { id: "emp_3", __cursor_0: "Linus", __cursor_1: "emp_3" },
        ],
      ],
      3,
    );
    const resource = createQueryEngine({ db, schema, relations }).defineResource("employees", {
      query: { pagination: { modes: ["cursor"] }, defaults: { pagination: { mode: "cursor" } } },
    });

    const page = await resource.query({ request: request(null, "exact") });
    expect(page.pageInfo).toMatchObject({ mode: "cursor", count: "exact", rowCount: 3 });
    expect(trace.countQueries).toBe(1);
  });
});
