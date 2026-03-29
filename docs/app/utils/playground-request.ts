import type { QueryRequest } from "drizzle-resource";

import { z } from "zod";

export const playgroundSeedSummary = {
  customers: 320,
  orders: 10_000,
  products: 180,
};

// Nuxt auto-import scanning mistakenly registers `query.search` from this file as a top-level export.
export const search = undefined;

const filterConditionSchema = z.object({
  type: z.literal("condition"),
  key: z.string().min(1),
  operator: z.enum([
    "contains",
    "is",
    "isAnyOf",
    "isNot",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "before",
    "after",
  ]),
  value: z.unknown(),
});

type FilterNode =
  | z.infer<typeof filterConditionSchema>
  | {
      type: "group";
      combinator: "and" | "or";
      children: FilterNode[];
    };

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterConditionSchema,
    z.object({
      type: z.literal("group"),
      combinator: z.enum(["and", "or"]),
      children: z.array(filterNodeSchema),
    }),
  ]),
);

export const playgroundRequestSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  pagination: z.object({
    pageIndex: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
  }),
  sorting: z.array(
    z.object({
      key: z.string().min(1),
      dir: z.enum(["asc", "desc"]),
    }),
  ),
  search: z.object({
    value: z.string(),
    fields: z.array(z.string().min(1)),
  }),
  filters: z.array(filterNodeSchema),
  facets: z
    .array(
      z.object({
        key: z.string().min(1),
        mode: z.enum(["exclude-self", "include-self"]).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().nullable().optional(),
      }),
    )
    .optional(),
}) satisfies z.ZodType<QueryRequest>;

export type PlaygroundRequest = z.infer<typeof playgroundRequestSchema>;

export const basePlaygroundRequest: QueryRequest = {
  context: {},
  pagination: {
    pageIndex: 1,
    pageSize: 25,
  },
  sorting: [{ key: "createdAt", dir: "desc" }],
  search: {
    value: "",
    fields: [],
  },
  filters: [],
  facets: [
    {
      key: "status",
      mode: "exclude-self",
      limit: 10,
    },
    {
      key: "orderLines.product.category",
      mode: "exclude-self",
      limit: 10,
    },
  ],
};

export const defaultPlaygroundRequest: QueryRequest = {
  context: {},
  pagination: {
    pageIndex: 1,
    pageSize: 25,
  },
  sorting: [{ key: "createdAt", dir: "desc" }],
  search: {
    value: "",
    fields: [],
  },
  filters: [
    {
      type: "condition",
      key: "status",
      operator: "isAnyOf",
      value: ["pending", "processing"],
    },
  ],
  facets: [
    {
      key: "status",
      mode: "exclude-self",
      limit: 10,
    },
    {
      key: "orderLines.product.category",
      mode: "exclude-self",
      limit: 10,
    },
  ],
};

export const playgroundContext = {
  orgId: "acme",
};

export const playgroundTableDefs = [
  {
    name: "orders",
    columns: [
      { name: "id", type: "text", primaryKey: true, notNull: true },
      { name: "created_at", type: "text", notNull: true },
      { name: "customer_id", type: "text", notNull: true, fk: "customers.id" },
      { name: "deleted_at", type: "text" },
      { name: "reference", type: "text", notNull: true },
      { name: "status", type: "text", notNull: true },
      { name: "total_amount", type: "integer", notNull: true },
    ],
  },
  {
    name: "customers",
    columns: [
      { name: "id", type: "text", primaryKey: true, notNull: true },
      { name: "name", type: "text", notNull: true },
      { name: "org_id", type: "text", notNull: true },
    ],
  },
  {
    name: "products",
    columns: [
      { name: "id", type: "text", primaryKey: true, notNull: true },
      { name: "category", type: "text", notNull: true },
      { name: "label", type: "text", notNull: true },
      { name: "name", type: "text", notNull: true },
      { name: "sku", type: "text", notNull: true },
    ],
  },
  {
    name: "order_lines",
    columns: [
      { name: "id", type: "text", primaryKey: true, notNull: true },
      { name: "order_id", type: "text", notNull: true, fk: "orders.id" },
      { name: "product_id", type: "text", notNull: true, fk: "products.id" },
      { name: "quantity", type: "integer", notNull: true },
    ],
  },
] as const;

export const playgroundContractDef = {
  resource: "orders",
  relations: {
    customer: { type: "one", table: "customers" },
    orderLines: {
      type: "many",
      table: "order_lines",
      with: { product: { type: "one", table: "products" } },
    },
  },
  query: {
    defaults: {
      pagination: { pageSize: 5 },
      sort: [{ key: "createdAt", dir: "desc" }],
    },
    scope: 'filters.is("customer.orgId", context.orgId)',
    facets: {
      allowed: ["status", "customer.name", "orderLines.product.category"],
    },
    filters: {
      disabled: ["deletedAt"],
      hidden: [] as string[],
    },
    search: {
      allowed: ["reference", "customer.name", "orderLines.product.name", "orderLines.product.sku"],
      defaults: ["reference", "customer.name"],
    },
    sort: {
      disabled: ["orderLines.product.name"],
    },
  },
} as const;

export const playgroundTablesSnippet = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull(),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  customerId: text("customer_id").notNull(),
  deletedAt: text("deleted_at"),
  reference: text("reference").notNull(),
  status: text("status").notNull(),
  totalAmount: integer("total_amount").notNull(),
});

export const orderLines = sqliteTable("order_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: integer("quantity").notNull(),
});`;

export const playgroundContractSnippet = `export const ordersResource = engine.defineResource("orders", {
  relations: {
    customer: true,
    orderLines: {
      with: {
        product: true,
      },
    },
  },
  query: {
    defaults: {
      pagination: { pageSize: 5 },
    },
    scope: (filters, context) => filters.is("customer.orgId", context.orgId),
    search: {
      allowed: [
        "reference",
        "customer.name",
        "orderLines.product.name",
        "orderLines.product.sku",
      ],
      defaults: ["reference", "customer.name"],
    },
    filters: {
      disabled: ["deletedAt"],
    },
    sort: {
      defaults: [{ key: "createdAt", dir: "desc" }],
      disabled: ["orderLines.product.name"],
    },
    facets: {
      allowed: ["status", "customer.name", "orderLines.product.category"],
    },
  },
});`;

export function formatValidationError(error: z.ZodError | Error) {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "request";
        return `${path}: ${issue.message}`;
      })
      .join("\n");
  }

  return error.message;
}
