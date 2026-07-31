import { defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
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
  query: { search: { allowed: ["reference"] }, validation: { maxPageSize: 75 } },
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

  it("uses Drizzle column schemas and selected relation cardinality", () => {
    const responseContract = responseSchema(resource, {
      columns: { reference: () => v.pipe(v.string(), v.toUpperCase()) },
    });
    const response = v.parse(responseContract, {
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
    expect(v.safeParse(responseContract, { rows: [{ id: "bad" }], rowCount: 1 }).success).toBe(
      false,
    );
  });
});
