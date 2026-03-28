import { engine } from "./engine";

export const ordersResource = engine.defineResource("orders", {
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
      pagination: { pageSize: 25 },
    },
    facets: {
      allowed: [
        "status",
        "customer.name",
        "orderLines.product.category",
        "orderLines.product.category.label",
      ],
    },
    filters: {
      disabled: ["deletedAt"],
      hidden: ["customer.orgId"],
    },
    scope: (f, ctx) => f.and([f.is("customer.orgId", ctx.orgId)]),
    search: {
      allowed: ["reference", "customer.name", "orderLines.product.name", "orderLines.product.sku"],
      defaults: ["reference", "customer.name"],
    },
    sort: {
      defaults: [{ dir: "desc", key: "createdAt" }],
      disabled: ["orderLines.product.name", "tags.name"],
    },
  },
});
