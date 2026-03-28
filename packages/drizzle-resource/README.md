# drizzle-resource

**Schema-driven query resources for [Drizzle ORM](https://orm.drizzle.team).** One typed contract for filtering, sorting, search, pagination, hydration, and facets — define it once, query it consistently across every table endpoint.

Instead of reimplementing sort params, WHERE builders, count queries, and filter sidebars for each endpoint, you declare a resource and get a stable, typed API that handles the entire query pipeline.

## Packages and exports

This repository is organized as a workspace monorepo:

- `packages/core` contains the core query engine
- `packages/zod` and `packages/valibot` are integration packages
- `packages/drizzle-resource` is the single published npm package

Consumers install just `drizzle-resource` and use subpath exports:

```ts
import { createQueryEngine } from "drizzle-resource";
import { queryZodIntegration } from "drizzle-resource/zod";
import { queryValibotIntegration } from "drizzle-resource/valibot";
```

## Features

- **🔒 Type-safe field paths** — sort keys, filter fields, search fields, and facet paths are all inferred from your Drizzle schema and declared relations. Typos fail at compile time.
- **🔍 Filter trees** — AND/OR nested conditions with 11 operators (`is`, `isAnyOf`, `contains`, `between`, `before`, `after`, …)
- **📄 Pagination** — 1-based page + size with configurable defaults
- **↕️ Sorting** — multi-column, default sort, per-resource disabled paths
- **🔎 Free-text search** — ILIKE across configurable field paths, with separate `allowed` and `defaults` lists
- **🗂️ Facets** — bucket counts for filter sidebars, traveling in the same request as the main query
- **🛡️ Scope enforcement** — tenant constraints and auth filters that merge into every request and cannot be bypassed
- **⚙️ Staged pipeline** — ids → rows → facets, each stage replaceable independently via `strategy.*`
- **🚀 Performance tuning** — built-in SQL helpers for custom `strategy.ids` when you need a hand-tuned query

## Install

```sh
npm install drizzle-resource    # npm
pnpm add drizzle-resource       # pnpm
bun add drizzle-resource        # bun
```

Requires `drizzle-orm >= 1.0.0-beta` as a peer dependency.

## Quick start

```ts
import { createQueryEngine } from "drizzle-resource";
import { db, relations, schema } from "./db";

const engine = createQueryEngine({ db, schema, relations }).withContext<{ orgId: string }>();

export const ordersResource = engine.defineResource("orders", {
  relations: {
    customer: true,
    orderLines: { with: { product: true } },
  },
  query: {
    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),
    search: {
      allowed: ["reference", "customer.name", "orderLines.product.name"],
      defaults: ["reference", "customer.name"],
    },
    sort: {
      defaults: [{ key: "createdAt", dir: "desc" }],
      disabled: ["orderLines.product.name"],
    },
    facets: {
      allowed: ["status", "customer.name"],
    },
    defaults: {
      pagination: { pageSize: 25 },
    },
  },
});

const result = await ordersResource.query({
  context: { orgId: "acme" },
  request: {
    pagination: { pageIndex: 1, pageSize: 25 },
    sorting: [{ key: "createdAt", dir: "desc" }],
    search: { value: "laptop", fields: [] },
    filters: [
      { type: "condition", key: "status", operator: "isAnyOf", value: ["pending", "processing"] },
    ],
    facets: [{ key: "status", mode: "exclude-self", limit: 10 }],
  },
});
```

## Documentation

Full docs, benchmark results, and performance guide at **[drizzle-resource.vercel.app](https://drizzle-resource.vercel.app)**.

## License

MIT
