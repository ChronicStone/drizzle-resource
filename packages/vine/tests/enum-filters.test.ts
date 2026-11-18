import vine from "@vinejs/vine";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { createQueryEngine } from "../../core/index.js";
import { requestSchema } from "../index.js";

const orderStatus = pgEnum("order_status", ["PENDING", "PAID", "CANCELLED"]);
const customerTier = pgEnum("customer_tier", { Gold: "GOLD", Silver: "SILVER" });
const customers = pgTable("customers", {
  id: uuid().primaryKey(),
  tier: customerTier().notNull(),
});
const orders = pgTable("orders", {
  id: uuid().primaryKey(),
  customerId: uuid().notNull(),
  status: orderStatus().notNull(),
  channel: text({ enum: ["web", "store"] }),
  reference: text().notNull(),
});
const schema = { customers, orders, orderStatus, customerTier };
const relations = defineRelations({ customers, orders }, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));
const resource = createQueryEngine({
  db: drizzle.mock({ relations }),
  schema,
  relations,
}).defineResource("orders", { relations: { customer: true } });
const validator = vine.compile(requestSchema(resource));

type Condition = readonly [key: string, operator: string, value: unknown];

const condition = ([key, operator, value]: Condition) => ({
  type: "condition",
  key,
  operator,
  value,
});

const accepted: Condition[] = [
  ["status", "is", "PAID"],
  ["status", "is", null],
  ["status", "is", ["PAID"]],
  ["status", "isNot", "PAID"],
  ["status", "isNot", null],
  ["status", "isAnyOf", ["PAID", "PENDING"]],
  ["status", "isAnyOf", "PAID"],
  ["status", "gt", "PENDING"],
  ["status", "gte", "PENDING"],
  ["status", "lt", "CANCELLED"],
  ["status", "lte", "CANCELLED"],
  ["status", "before", "CANCELLED"],
  ["status", "after", "PENDING"],
  ["status", "between", { from: "PENDING", to: "PAID" }],
  ["status", "between", { from: "PENDING" }],
  ["status", "contains", "PA"],
  ["customer.tier", "isAnyOf", ["GOLD", "SILVER"]],
  ["channel", "is", "other"],
  ["reference", "isAnyOf", ["NOPE"]],
];

const refused: Condition[] = [
  ["status", "is", "NOPE"],
  ["status", "is", "paid"],
  ["status", "is", 1],
  ["status", "is", ["NOPE"]],
  ["status", "isNot", "NOPE"],
  ["status", "isAnyOf", ["PAID", "NOPE"]],
  ["status", "isAnyOf", "NOPE"],
  ["status", "gt", "NOPE"],
  ["status", "gte", "NOPE"],
  ["status", "lt", "NOPE"],
  ["status", "lte", "NOPE"],
  ["status", "before", "NOPE"],
  ["status", "after", "NOPE"],
  ["status", "between", { from: "PAID", to: "NOPE" }],
  ["customer.tier", "isAnyOf", ["Gold"]],
  ["customer.tier", "is", "NOPE"],
];

describe("Vine enum filter values", () => {
  it.each(accepted)("accepts %s %s %j", async (...input) => {
    await expect(validator.validate({ filters: [condition(input)] })).resolves.toMatchObject({
      filters: [condition(input)],
    });
  });

  it.each(refused)("refuses %s %s %j before SQL runs", async (...input) => {
    await expect(validator.validate({ filters: [condition(input)] })).rejects.toMatchObject({
      messages: [expect.objectContaining({ field: "filters.0.value", rule: "enum" })],
    });
  });

  it("refuses invalid enum values inside filter groups", async () => {
    await expect(
      validator.validate({
        filters: [
          {
            type: "group",
            combinator: "or",
            children: [
              condition(["status", "is", "PAID"]),
              condition(["customer.tier", "isAnyOf", ["NOPE"]]),
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      messages: [expect.objectContaining({ field: "filters.0.children.1.value", rule: "enum" })],
    });
  });
});
