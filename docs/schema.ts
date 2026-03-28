import { integer, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

export const customers = pgTable("customers", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  orgId: varchar({ length: 255 }).notNull(),
});

export const products = pgTable("products", {
  id: uuid().defaultRandom().primaryKey(),
  category: varchar({ length: 255 }).notNull(),
  label: varchar({ length: 255 }).notNull(),
  name: varchar({ length: 255 }).notNull(),
  sku: varchar({ length: 255 }).notNull(),
});

export const orders = pgTable("orders", {
  id: uuid().defaultRandom().primaryKey(),
  createdAt: varchar({ length: 255 }).notNull(),
  customerId: uuid()
    .notNull()
    .references(() => customers.id),
  deletedAt: varchar({ length: 255 }),
  reference: varchar({ length: 255 }).notNull(),
  status: varchar({ length: 64 }).notNull(),
  totalAmount: integer().notNull(),
});

export const orderLines = pgTable("order_lines", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid()
    .notNull()
    .references(() => orders.id),
  productId: uuid()
    .notNull()
    .references(() => products.id),
  quantity: integer().notNull(),
});

export const tags = pgTable("tags", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
});

export const schema = {
  customers,
  orderLines,
  orders,
  products,
  tags,
};
