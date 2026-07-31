import { engine } from "./engine";

/**
 * The relation tree is declared separately so documentation examples can derive
 * the resource's field-path union from it.
 */
export const ordersRelations = {
  customer: true,
  orderLines: {
    with: {
      product: true,
    },
  },
  tags: true,
} as const;

export const ordersResource = engine.defineResource("orders", {
  relations: ordersRelations,
  query: {
    defaults: {
      pagination: { mode: "cursor", pageSize: 25 },
    },
    pagination: { modes: ["cursor", "offset"] },
    facets: {
      allowed: ["status", "customer.name", "orderLines.product.category", "tags.name"],
    },
    filters: {
      // `deletedAt` stays out of client filters. Note that a scope filter may
      // not reference a disabled or hidden path — the field leaves the registry.
      disabled: ["deletedAt"],
    },
    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),
    search: {
      allowed: ["reference", "customer.name", "orderLines.product.name", "orderLines.product.sku"],
      defaults: ["reference", "customer.name"],
    },
    sort: {
      defaults: [{ dir: "desc", key: "createdAt" }],
    },
  },
});
