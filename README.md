# drizzle-resource

**Schema-driven query resources for [Drizzle ORM](https://orm.drizzle.team).** One typed contract for filtering, sorting, search, pagination, hydration, and facets — define it once, query it consistently across every table endpoint.

Instead of reimplementing sort params, WHERE builders, count queries, and filter sidebars for each endpoint, you declare a resource and get a stable, typed API that handles the entire query pipeline.

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
import { db, schema, relations } from "./db";

// 1. Create the engine — once, shared across all resources
const engine = createQueryEngine({ db, schema, relations }).withContext<{ orgId: string }>();

// 2. Define a resource
export const ordersResource = engine.defineResource("orders", {
  relations: {
    customer: true,
    orderLines: { with: { product: true } },
  },
  query: {
    // Scope merges into every request — client cannot bypass it
    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),
    search: {
      allowed: ["reference", "customer.name", "orderLines.product.name"],
      defaults: ["reference", "customer.name"],
    },
    sort: {
      defaults: [{ key: "createdAt", dir: "desc" }],
      disabled: ["orderLines.product.name"], // m2m sort paths — disable until benchmarked
    },
    facets: {
      allowed: ["status", "customer.name"],
    },
    defaults: {
      pagination: { pageSize: 25 },
    },
  },
});

// 3. Query it
const result = await ordersResource.query({
  context: { orgId: "acme" },
  request: {
    pagination: { pageIndex: 1, pageSize: 25 },
    sorting: [{ key: "createdAt", dir: "desc" }],
    search: { value: "laptop", fields: [] },
    filters: {
      type: "group",
      combinator: "and",
      children: [
        { type: "condition", key: "status", operator: "isAnyOf", value: ["pending", "processing"] },
      ],
    },
    facets: [{ key: "status", mode: "exclude-self", limit: 10 }],
  },
});

// result.rows     — typed hydrated rows
// result.rowCount — total matching rows before pagination
// result.facets   — bucket counts per requested facet
```

## Four query methods

| Method                      | Use when                                     |
| --------------------------- | -------------------------------------------- |
| `resource.query(...)`       | Full pipeline — ids + rows + optional facets |
| `resource.queryIds(...)`    | Page ids + count only (caching, batching)    |
| `resource.queryRows(...)`   | Hydrate a known id list without re-selecting |
| `resource.queryFacets(...)` | Facets independently from the page           |

## Documentation

Full docs, benchmark results, and performance guide at **[drizzle-resource.vercel.app](https://drizzle-resource.vercel.app)**.

## Quality checks

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
bun run ci
```

`bun run ci` runs the package checks plus Twoslash verification for the docs.

## Release workflow

This repository now uses Changesets for versioning and changelog generation.

```sh
# add a release note
bun run changeset

# inspect pending releases
bun run release:status
```

On GitHub, `.github/workflows/release.yml` creates or updates a release PR from pending changesets. Once that PR is merged into `main`, the workflow publishes to npm and generates GitHub releases.

To keep npm provenance enabled, configure npm trusted publishing for this repository/workflow in npm settings.

## License

MIT
