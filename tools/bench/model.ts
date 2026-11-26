import { defineRelations } from "drizzle-orm";
import { boolean, index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The benchmark's tables: orders with a customers relation. `denormalized` adds
 * `orders.customerName`, the copy of the customer's name the index check recommends for a sort
 * through a relation.
 */
export function makeModel(schemaName: string, denormalized: boolean) {
  const namespace = pgSchema(schemaName);
  const customers = namespace.table("customers", {
    id: integer().primaryKey(),
    name: text().notNull(),
    segment: text().notNull(),
  });
  const orders = namespace.table(
    "orders",
    {
      id: integer().primaryKey(),
      customerId: integer().notNull(),
      orgId: integer().notNull(),
      status: text().notNull(),
      paid: boolean().notNull(),
      createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
      reference: text().notNull(),
      ...(denormalized ? { customerName: text() } : {}),
    },
    (table) => [index().on(table.createdAt, table.id), index().on(table.customerId)],
  );
  const schema = { customers, orders };
  const relations = defineRelations(schema, (r) => ({
    orders: { customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id }) },
  }));
  return { schema, relations, orders, customers };
}
