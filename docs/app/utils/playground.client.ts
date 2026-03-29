import { asc, defineRelationsPart, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sql-js";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createQueryEngine } from "drizzle-resource";
import { createQueryFilterBuilder } from "drizzle-resource";
import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import playgroundDbUrl from "../assets/playground.sqlite?url";

import { playgroundContext } from "./playground-request";
import type { PlaygroundRequest } from "./playground-request";

const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull(),
});

const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
});

const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  customerId: text("customer_id").notNull(),
  deletedAt: text("deleted_at"),
  reference: text("reference").notNull(),
  status: text("status").notNull(),
  totalAmount: integer("total_amount").notNull(),
});

const orderLines = sqliteTable("order_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: integer("quantity").notNull(),
});

const schema = {
  customers,
  orderLines,
  orders,
  products,
};

const relations = defineRelationsPart(
  schema,
  ({
    customers: customersTable,
    many,
    one,
    orderLines: orderLinesTable,
    orders: ordersTable,
    products: productsTable,
  }) => ({
    customers: {
      orders: many.orders({
        from: customersTable.id,
        to: ordersTable.customerId,
      }),
    },
    orders: {
      customer: one.customers({
        from: ordersTable.customerId,
        optional: false,
        to: customersTable.id,
      }),
      orderLines: many.orderLines({
        from: ordersTable.id,
        to: orderLinesTable.orderId,
      }),
    },
    orderLines: {
      order: one.orders({
        from: orderLinesTable.orderId,
        optional: false,
        to: ordersTable.id,
      }),
      product: one.products({
        from: orderLinesTable.productId,
        optional: false,
        to: productsTable.id,
      }),
    },
    products: {
      orderLines: many.orderLines({
        from: productsTable.id,
        to: orderLinesTable.productId,
      }),
    },
  }),
);

async function loadDatabaseBytes(databaseUrl: string) {
  console.debug("[playground] fetching pre-seeded database", { databaseUrl });
  const response = await fetch(databaseUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      `Failed to load playground database (${response.status} ${response.statusText})`,
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  console.debug("[playground] database bytes loaded", { byteLength: bytes.byteLength });
  return bytes;
}

function definePlaygroundResource(sqlite: SqlJsDatabase) {
  const db = drizzle(sqlite, { schema });

  async function fetchRowsByIds(ids: unknown[]) {
    const orderIds = ids.filter((id): id is string => typeof id === "string");

    if (orderIds.length === 0) {
      return [];
    }

    const joinedRows = await db
      .select({
        customerId: customers.id,
        customerName: customers.name,
        customerOrgId: customers.orgId,
        lineId: orderLines.id,
        orderCreatedAt: orders.createdAt,
        orderDeletedAt: orders.deletedAt,
        orderId: orders.id,
        orderReference: orders.reference,
        orderStatus: orders.status,
        orderTotalAmount: orders.totalAmount,
        productCategory: products.category,
        productId: products.id,
        productLabel: products.label,
        productName: products.name,
        productSku: products.sku,
        quantity: orderLines.quantity,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
      .leftJoin(products, eq(products.id, orderLines.productId))
      .where(inArray(orders.id, orderIds))
      .orderBy(asc(orders.createdAt), asc(orders.id), asc(orderLines.id));

    const grouped = new Map<
      string,
      {
        createdAt: string;
        customer: { id: string; name: string; orgId: string };
        deletedAt: string | null;
        id: string;
        orderLines: Array<{
          id: string;
          product: { category: string; id: string; label: string; name: string; sku: string };
          quantity: number;
        }>;
        reference: string;
        status: string;
        totalAmount: number;
      }
    >();

    for (const row of joinedRows) {
      const current = grouped.get(row.orderId) ?? {
        createdAt: row.orderCreatedAt,
        customer: {
          id: row.customerId,
          name: row.customerName,
          orgId: row.customerOrgId,
        },
        deletedAt: row.orderDeletedAt,
        id: row.orderId,
        orderLines: [],
        reference: row.orderReference,
        status: row.orderStatus,
        totalAmount: row.orderTotalAmount,
      };

      if (row.lineId && row.productId) {
        current.orderLines.push({
          id: row.lineId,
          product: {
            category: row.productCategory ?? "",
            id: row.productId,
            label: row.productLabel ?? "",
            name: row.productName ?? "",
            sku: row.productSku ?? "",
          },
          quantity: row.quantity ?? 0,
        });
      }

      grouped.set(row.orderId, current);
    }

    const orderIndex = new Map(orderIds.map((id, index) => [id, index]));
    return [...grouped.values()].sort(
      (left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0),
    );
  }

  type PlaygroundRow = Awaited<ReturnType<typeof fetchRowsByIds>>[number];
  const engine = createQueryEngine({
    db: db as never,
    schema,
    relations,
  }).withContext<typeof playgroundContext>();

  const resource = (engine as any).defineResource("orders", {
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
      facets: {
        allowed: ["status", "customer.name", "orderLines.product.category"],
      },
      filters: {
        disabled: ["deletedAt"],
      },
      scope: (
        filters: ReturnType<typeof createQueryFilterBuilder>,
        context: typeof playgroundContext,
      ) => filters.is("customer.orgId", context.orgId),
      search: {
        allowed: [
          "reference",
          "customer.name",
          "orderLines.product.name",
          "orderLines.product.sku",
        ],
        defaults: ["reference", "customer.name"],
      },
      sort: {
        defaults: [{ dir: "desc", key: "createdAt" }],
        disabled: ["orderLines.product.name"],
      },
    },
    strategy: {
      rows: async ({ ids }: { ids: unknown[] }) => {
        console.debug("[playground] hydrating rows with sql.js adapter", { idCount: ids.length });
        return fetchRowsByIds(ids);
      },
    },
  });

  return resource as {
    query(args: { context: typeof playgroundContext; request: PlaygroundRequest }): Promise<{
      rowCount: number;
      rows: PlaygroundRow[];
      facets?: Array<{
        key: string;
        options: Array<{ count: number; value: unknown }>;
        nextCursor?: string | null;
        total?: number;
      }>;
    }>;
  };
}

export async function createPlaygroundClient() {
  const databaseUrl = playgroundDbUrl;
  console.debug("[playground] booting sql.js playground", { databaseUrl });

  const SQL = await initSqlJs({
    locateFile: () => sqlWasmUrl,
  });
  const bytes = await loadDatabaseBytes(databaseUrl);
  const sqlite = new SQL.Database(bytes);

  const resource = definePlaygroundResource(sqlite);
  console.debug("[playground] resource ready");

  return {
    dispose() {
      console.debug("[playground] disposing sql.js database");
      sqlite.close();
    },
    async run(request: PlaygroundRequest) {
      console.debug("[playground] running request", request);
      const result = (await resource.query({
        context: playgroundContext,
        request,
      })) as Awaited<ReturnType<typeof resource.query>>;
      console.debug("[playground] request complete", {
        rowCount: result.rowCount,
        pageRows: result.rows.length,
        facetCount: result.facets?.length ?? 0,
      });
      return result;
    },
  };
}
