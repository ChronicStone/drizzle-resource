import { defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { z } from "zod";
import { createQueryEngine } from "../../core/index.js";

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
  db: { query: { orders: { findMany: async () => [] } } },
  schema,
  relations,
}).defineResource("orders", {
  relations: { customer: true },
  query: {
    search: { allowed: ["reference"] },
    filters: { disabled: ["customerId"] },
    pagination: { modes: ["offset", "cursor"] },
    validation: { maxPageSize: 75 },
  },
});

describe("Zod schemas", () => {
  it("strictly validates the resource request contract and only narrows overrides", () => {
    const request = requestSchema(resource, {
      limits: { maxPageSize: 25, maxFilterDepth: 1 },
      allow: { filters: ["reference"] },
    });

    expect(
      request.safeParse({
        pagination: { pageIndex: 1, pageSize: 25 },
        sorting: [],
        filters: [{ type: "condition", key: "reference", operator: "contains", value: "ORD" }],
        search: { value: "", fields: [] },
      }).success,
    ).toBe(true);
    expect(request.safeParse({ pagination: { pageIndex: 1, pageSize: 26 } }).success).toBe(false);
    expect(request.safeParse({ context: { orgId: "acme" } }).success).toBe(false);
    expect(
      request.safeParse({
        filters: [{ type: "condition", key: "customerId", operator: "is", value: "x" }],
      }).success,
    ).toBe(false);
    expect(
      request.safeParse({
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

    expect(request.parse({}).pagination).toEqual({
      mode: "cursor",
      cursor: null,
      pageSize: 20,
      count: "none",
    });
    expect(
      request.parse({
        pagination: { mode: "cursor", cursor: "opaque", pageSize: 10, count: "exact" },
      }).pagination,
    ).toEqual({ mode: "cursor", cursor: "opaque", pageSize: 10, count: "exact" });
    expect(request.safeParse({ pagination: { pageIndex: 1, pageSize: 10 } }).success).toBe(false);
  });

  it("infers override inputs and carries their output through selected relations", () => {
    const responseContract = responseSchema(resource, {
      columns: {
        reference: (columnSchema) => columnSchema.transform((value) => value.length),
      },
      relations: {
        customer: {
          columns: {
            name: (columnSchema) => columnSchema.transform((value) => value.length),
          },
        },
      },
    });
    type Response = z.infer<typeof responseContract>;

    expectTypeOf<Response["rows"][number]["reference"]>().toEqualTypeOf<number>();
    expectTypeOf<Response["rows"][number]["customer"]["name"]>().toEqualTypeOf<number>();

    const response = responseContract.parse({
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
    expect(responseContract.safeParse({ rows: [{ id: "bad" }] }).success).toBe(false);
  });
});
