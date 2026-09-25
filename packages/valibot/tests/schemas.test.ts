import { drizzle } from "drizzle-orm/node-postgres";
import { count, sql, defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as v from "valibot";
import { createQueryEngine, virtual } from "../../core/index.js";

import { requestSchema, responseSchema } from "../index.js";

const customers = pgTable("customers", {
  id: uuid().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
});
const orders = pgTable("orders", {
  id: uuid().primaryKey(),
  customerId: uuid()
    .notNull()
    .references(() => customers.id),
  reference: varchar({ length: 255 }).notNull(),
});
const schema = { customers, orders };
const relations = defineRelationsPart(
  schema,
  ({ customers: customersTable, orders: ordersTable, many, one }) => ({
    customers: { orders: many.orders({ from: customersTable.id, to: ordersTable.customerId }) },
    orders: {
      customer: one.customers({
        from: ordersTable.customerId,
        to: customersTable.id,
        optional: false,
      }),
    },
  }),
);
const resource = createQueryEngine({
  db: drizzle({ connection: "postgres://localhost/unused", relations }),
  schema,
  relations,
}).defineResource("orders", {
  relations: { customer: true },
  hydration: {
    profiles: {
      list: {},
      detail: { customer: true },
    },
    defaults: { query: "list", findById: "detail" },
  },
  query: {
    search: { allowed: ["reference"] },
    pagination: { modes: ["offset", "cursor"] },
    validation: { maxPageSize: 75 },
  },
});

describe("Valibot schemas", () => {
  it("rejects context and values outside the narrowed request contract", () => {
    const request = requestSchema(resource, { limits: { maxPageSize: 25, maxFilterDepth: 1 } });
    expect(v.safeParse(request, { pagination: { pageIndex: 1, pageSize: 25 } }).success).toBe(true);
    expect(v.safeParse(request, { pagination: { pageIndex: 1, pageSize: 26 } }).success).toBe(
      false,
    );
    expect(v.safeParse(request, { context: { orgId: "acme" } }).success).toBe(false);
    expect(
      v.safeParse(request, {
        filters: [
          {
            type: "group",
            combinator: "and",
            children: [{ type: "group", combinator: "and", children: [] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates cursor pagination, defaults its count, and can require exact totals", () => {
    const request = requestSchema(resource, {
      defaults: { pagination: { mode: "cursor", pageSize: 20 } },
      allow: { pagination: ["cursor"] },
    });

    expect(v.parse(request, {}).pagination).toEqual({
      mode: "cursor",
      cursor: null,
      pageSize: 20,
      count: "none",
    });
    expect(
      v.parse(request, {
        pagination: { mode: "cursor", cursor: "opaque", pageSize: 10, count: "exact" },
      }).pagination,
    ).toEqual({ mode: "cursor", cursor: "opaque", pageSize: 10, count: "exact" });
    expect(v.safeParse(request, { pagination: { pageIndex: 1, pageSize: 10 } }).success).toBe(
      false,
    );
  });

  it("infers override inputs and carries their output through selected relations", () => {
    const responseContract = responseSchema(resource, {
      load: "detail",
      override: {
        columns: {
          reference: (columnSchema) =>
            v.pipe(
              columnSchema,
              v.transform((value) => value.length),
            ),
        },
        relations: {
          customer: {
            columns: {
              name: (columnSchema) =>
                v.pipe(
                  columnSchema,
                  v.transform((value) => value.length),
                ),
            },
          },
        },
      },
    });
    type Response = v.InferOutput<typeof responseContract>;

    expectTypeOf<Response["rows"][number]["reference"]>().toEqualTypeOf<number>();
    expectTypeOf<Response["rows"][number]["customer"]["name"]>().toEqualTypeOf<number>();

    const response = v.parse(responseContract, {
      rows: [
        {
          id: "018f2d22-2580-7c0b-8a9b-2195a619d8d4",
          customerId: "018f2d22-2580-7c0b-8a9b-2195a619d8d5",
          reference: "ord-1",
          customer: { id: "018f2d22-2580-7c0b-8a9b-2195a619d8d5", name: "Ada" },
        },
      ],
      pageInfo: {
        mode: "offset",
        pageIndex: 1,
        pageSize: 25,
        hasNextPage: false,
        count: "exact",
        rowCount: 1,
      },
    });

    expect(response.rows[0]?.reference).toBe(5);
    expect(response.rows[0]?.customer.name).toBe(3);
    expect(v.safeParse(responseContract, { rows: [{ id: "bad" }] }).success).toBe(false);
  });

  it("derives response rows from the default and selected hydration profiles", () => {
    const listResponse = responseSchema(resource);
    const detailResponse = responseSchema(resource, { load: "detail" });
    type ListRow = v.InferOutput<typeof listResponse>["rows"][number];
    type DetailRow = v.InferOutput<typeof detailResponse>["rows"][number];

    expectTypeOf<ListRow>().not.toHaveProperty("customer");
    expectTypeOf<DetailRow>().toHaveProperty("customer");

    const pageInfo = {
      mode: "offset" as const,
      pageIndex: 1,
      pageSize: 25,
      hasNextPage: false,
      count: "exact" as const,
      rowCount: 1,
    };
    const row = {
      id: "018f2d22-2580-7c0b-8a9b-2195a619d8d4",
      customerId: "018f2d22-2580-7c0b-8a9b-2195a619d8d5",
      reference: "ord-1",
      customer: { id: "018f2d22-2580-7c0b-8a9b-2195a619d8d5", name: "Ada" },
    };

    expect(v.parse(listResponse, { rows: [row], pageInfo }).rows[0]).not.toHaveProperty("customer");
    expect(v.parse(detailResponse, { rows: [row], pageInfo }).rows[0]).toHaveProperty("customer");
  });
});

describe("model-aware response schemas", () => {
  it("matches hidden defaults, exact nested views, virtuals and typed summaries", () => {
    const db = drizzle({ connection: "postgres://localhost/unused", relations });
    const engine = createQueryEngine({
      db,
      schema,
      relations,
      models: {
        orders: {
          private: ["customerId"],
          hidden: ["reference"],
          virtual: {
            upperReference: virtual.text((order: typeof orders) => sql`upper(${order.reference})`),
            latest: virtual.scalar(
              (_order: typeof orders, { db: executionDb }: { db: typeof db }) =>
                executionDb.select({ value: orders.reference }).from(orders).limit(1),
            ),
          },
        },
        customers: { hidden: ["name"] },
      },
    });
    const selected = engine.defineResource("orders", {
      relations: { customer: true },
      views: {
        list: { select: { reference: true, upperReference: true, customer: true } },
        scalar: { select: { latest: true } },
      },
      hydration: { profiles: { list: {} }, defaults: { query: "list" } },
      summary: () => ({ rows: count() }),
    });
    const defaults = responseSchema(selected);
    const id = "11111111-1111-4111-8111-111111111111";
    const pageInfo = {
      mode: "offset",
      pageIndex: 1,
      pageSize: 25,
      hasNextPage: false,
      count: "exact",
      rowCount: 1,
    };
    expect(v.parse(defaults, { rows: [{ id }], pageInfo }).rows).toEqual([{ id }]);
    const validator = responseSchema(selected, {
      view: "list",
      summary: v.object({ rows: v.number() }),
    });
    expectTypeOf<v.InferOutput<typeof validator>["rows"][number]>().toEqualTypeOf<{
      reference: string;
      upperReference: string;
      customer: { id: string };
    }>();
    expectTypeOf<v.InferOutput<typeof validator>["summary"]>().toEqualTypeOf<{ rows: number }>();
    const payload = {
      rows: [{ reference: "ORD", upperReference: "ORD", customer: { id } }],
      pageInfo,
      summary: { rows: 1 },
    };
    expect(v.parse(validator, payload)).toEqual(payload);
    expect(() => responseSchema(selected, { view: "scalar" })).toThrow("schema override");
    const scalar = responseSchema(selected, {
      view: "scalar",
      override: { columns: { latest: () => v.nullable(v.string()) } },
    });
    expect(v.parse(scalar, { rows: [{ latest: null }], pageInfo }).rows).toEqual([
      { latest: null },
    ]);
    const transformed = responseSchema(selected, {
      view: "list",
      override: {
        columns: {
          upperReference: (field) =>
            v.pipe(
              field,
              v.transform((value) => value.length),
            ),
        },
      },
    });
    expectTypeOf<
      v.InferOutput<typeof transformed>["rows"][number]["upperReference"]
    >().toEqualTypeOf<number>();
    expect(v.parse(transformed, { rows: payload.rows, pageInfo }).rows[0]?.upperReference).toBe(3);
    // @ts-expect-error summary schema must match the SQL aggregate result
    responseSchema(selected, { view: "list", summary: v.object({ rows: v.string() }) });
  });
});
