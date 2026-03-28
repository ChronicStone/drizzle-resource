import { defineRelationsPart } from "drizzle-orm";

import { schema } from "./schema";

export const relations = defineRelationsPart(
  schema,
  ({ customers, orderLines, orders, products, many, one }) => ({
    customers: {
      orders: many.orders({
        from: customers.id,
        to: orders.customerId,
      }),
    },
    orders: {
      customer: one.customers({
        from: orders.customerId,
        optional: false,
        to: customers.id,
      }),
      orderLines: many.orderLines({
        from: orders.id,
        to: orderLines.orderId,
      }),
    },
    orderLines: {
      order: one.orders({
        from: orderLines.orderId,
        optional: false,
        to: orders.id,
      }),
      product: one.products({
        from: orderLines.productId,
        optional: false,
        to: products.id,
      }),
    },
    products: {
      orderLines: many.orderLines({
        from: products.id,
        to: orderLines.productId,
      }),
    },
    tags: {},
  }),
);
