import { defineRelationsPart } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
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

  it("infers override inputs and carries their output through selected relations", () => {
    const responseContract = responseSchema(resource, {
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
      rowCount: 1,
    });

    expect(response.rows[0]?.reference).toBe(5);
    expect(response.rows[0]?.customer.name).toBe(3);
    expect(v.safeParse(responseContract, { rows: [{ id: "bad" }], rowCount: 1 }).success).toBe(
      false,
    );
  });
});
