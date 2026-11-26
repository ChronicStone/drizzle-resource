/**
 * The example of the Scale pages: the benchmark's orders and customers tables. Twoslash examples
 * import it from ./twoslash-support, and tools/scale-examples.ts runs it against PostgreSQL to
 * capture the output those pages show, so the code on the page is the code that ran.
 */
import { defineRelations } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const customers = pgTable("customers", {
  id: integer().primaryKey(),
  name: text().notNull(),
  segment: text().notNull(),
});

const orderColumns = {
  id: integer().primaryKey(),
  customerId: integer().notNull(),
  orgId: integer().notNull(),
  status: text().notNull(),
  paid: boolean().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  reference: text().notNull(),
};

/** Before: the indexes of the benchmark's out-of-the-box profile. */
export const orders = pgTable("orders", orderColumns, (t) => [
  index("orders_created_at_id_idx").on(t.createdAt, t.id),
  index("orders_customer_id_idx").on(t.customerId),
]);

/** After the fix: the customer's name copied onto orders, with an index to sort by it. */
export const ordersWithName = pgTable(
  "orders",
  { ...orderColumns, customerName: text().notNull() },
  (t) => [
    index("orders_created_at_id_idx").on(t.createdAt, t.id),
    index("orders_customer_id_idx").on(t.customerId),
    index("orders_customer_name_id_idx").on(t.customerName, t.id),
  ],
);

export const scaleSchema = { customers, orders };
export const scaleRelations = defineRelations(scaleSchema, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));

export const scaleSchemaAfter = { customers, orders: ordersWithName };
export const scaleRelationsAfter = defineRelations(scaleSchemaAfter, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));

/** The order list screen: a page, its count and three facets. */
export const listRequest = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count: "exact" },
  sorting: [],
  filters: [],
  search: { value: "", fields: [] },
  facets: [
    { key: "status", mode: "exclude-self", limit: 10 },
    { key: "paid", mode: "exclude-self", limit: 10 },
    { key: "customer.segment", mode: "exclude-self", limit: 10 },
  ],
} as const;

/** The same list sorted by customer name. */
export const byCustomerRequest = {
  pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count: "exact" },
  sorting: [{ key: "customer.name", dir: "asc" }],
  filters: [],
  search: { value: "", fields: [] },
} as const;

/** Page 4,000 of the list, without a count. */
export const deepRequest = {
  pagination: { mode: "offset", pageIndex: 4_000, pageSize: 50, count: "none" },
  sorting: [],
  filters: [],
  search: { value: "", fields: [] },
} as const;

// ---------- variants for the Indexes page: the same orders table with other indexes ----------

/** The tenant column first, then the default sort and id. */
export const ordersByTenant = pgTable("orders", orderColumns, (t) => [
  index("orders_org_id_created_at_id_idx").on(t.orgId, t.createdAt.desc(), t.id.desc()),
]);
export const tenantSchema = { customers, orders: ordersByTenant };
export const tenantRelations = defineRelations(tenantSchema, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));

/** A plain index on a text column that a scope compares. */
export const ordersByStatus = pgTable("orders", orderColumns, (t) => [
  index("orders_status_created_at_id_idx").on(t.status, t.createdAt.desc(), t.id.desc()),
]);
export const statusSchema = { customers, orders: ordersByStatus };
export const statusRelations = defineRelations(statusSchema, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));

/** Soft deletes: a nullable deletedAt that every query filters on. */
export const ordersSoftDelete = pgTable(
  "orders",
  { ...orderColumns, deletedAt: timestamp({ withTimezone: true }) },
  (t) => [
    index("orders_org_id_deleted_at_created_at_idx").on(t.orgId, t.deletedAt, t.createdAt, t.id),
  ],
);
export const softDeleteSchema = { customers, orders: ordersSoftDelete };
export const softDeleteRelations = defineRelations(softDeleteSchema, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));

/** The tenant on the related table only. */
export const customersWithTenant = pgTable("customers", {
  id: integer().primaryKey(),
  name: text().notNull(),
  segment: text().notNull(),
  orgId: integer().notNull(),
});
export const ordersNoTenant = pgTable(
  "orders",
  {
    id: integer().primaryKey(),
    customerId: integer().notNull(),
    status: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("orders_created_at_id_idx").on(t.createdAt, t.id)],
);
export const relationTenantSchema = { customers: customersWithTenant, orders: ordersNoTenant };
export const relationTenantRelations = defineRelations(relationTenantSchema, (r) => ({
  orders: {
    customer: r.one.customers({ from: r.orders.customerId, to: r.customers.id, optional: false }),
  },
}));
