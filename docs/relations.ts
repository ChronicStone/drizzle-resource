import { defineRelationsPart } from "drizzle-orm";

import { schema } from "./schema";

export const relations = defineRelationsPart(
  schema,
  ({ customers, orderLines, orderTags, orders, products, tags, many, one }) => ({
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
      // Many-to-many through the order_tags junction table.
      tags: many.tags({
        from: orders.id.through(orderTags.orderId),
        to: tags.id.through(orderTags.tagId),
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
    tags: {
      orders: many.orders({
        from: tags.id.through(orderTags.tagId),
        to: orders.id.through(orderTags.orderId),
      }),
    },
    orderTags: {},
  }),
);
