import { defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
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

  it("uses Drizzle column schemas and recurses through selected relations", () => {
    const responseContract = responseSchema(resource, {
      columns: { reference: () => z.string().transform((value) => value.toUpperCase()) },
    });
    const response = responseContract.parse({
      rows: [
        {
          id: "018f2d22-2580-7c0b-8a9b-2195a619d8d4",
          customerId: "018f2d22-2580-7c0b-8a9b-2195a619d8d5",
          reference: "ord-1",
          customer: { id: "018f2d22-2580-7c0b-8a9b-2195a619d8d5", name: "Ada" },
        },
      ],
      rowCount: 1,
    });

    expect(response.rows[0]?.reference).toBe("ORD-1");
    expect(responseContract.safeParse({ rows: [{ id: "bad" }], rowCount: 1 }).success).toBe(false);
  });
});
