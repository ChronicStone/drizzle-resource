---
seo:
  title: Drizzle Resource
  description: One typed contract for filtering, sorting, search, pagination, hydration, and facets on top of Drizzle ORM. Define once, query consistently.
---

::div{class="landing-page relative"}
::div{class="landing-ambient pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-visible"}

<div class="absolute left-1/2 top-0 h-[400px] w-[70vw] max-w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/25 blur-[100px] dark:bg-amber-500/18 sm:h-[500px] lg:h-[600px]"></div>
<div class="dot-grid absolute inset-0 h-screen opacity-20"></div>

::

::div{class="mx-auto max-w-[80rem] px-4 sm:px-6 lg:px-8"}

::div{class="relative pb-12 pt-8"}
::landing-split{class="landing-two-col landing-two-col--hero relative py-10"}
:::landing-split-left{class="landing-hero-copy"}

<div class="landing-badge mb-8">For Drizzle ORM</div>

<h1 class="landing-hero-title mb-6">
  One contract.
  <br />
  <span class="text-primary">Every table</span>
  <br />
  endpoint.
</h1>

<p class="mb-10 max-w-lg text-lg leading-relaxed text-stone-600 dark:text-stone-400">
  <code class="rounded bg-stone-100 px-1.5 py-0.5 text-base text-stone-700 dark:bg-white/8 dark:text-stone-200">drizzle-resource</code>
  gives your server a typed query layer for filters, search, sorting, pagination, row hydration,
  and facets, all inferred from your Drizzle schema.
</p>

<div class="flex flex-wrap items-center gap-3">

::::u-button{color="primary" size="xl" to="/getting-started/quick-start" trailing-icon="i-lucide-arrow-right"}
Get started
::::

::::u-button{color="neutral" size="xl" to="/getting-started/introduction" variant="outline"}
Introduction
::::

</div>

:::

:::landing-split-right{class="landing-code-panel"}

```ts twoslash [orders.ts]
import { ordersResource } from "./orders.resource";

const orders = ordersResource;
// ---cut-before---
const result = await orders.query({
  context: { orgId: "acme" },
  request: {
    context: {},
    pagination: { pageIndex: 1, pageSize: 25 },
    sorting: [{ key: "createdAt", dir: "desc" }],
    search: { value: "laptop", fields: [] },
    filters: [
      {
        type: "condition",
        key: "status",
        operator: "isAnyOf",
        value: ["pending", "processing"],
      },
    ],
    facets: [{ key: "status", mode: "exclude-self", limit: 10 }],
  },
});
```

:::

::
::
::div{class="landing-section-pad py-12"}

<div class="mb-10 max-w-2xl">
  <h2 class="mb-4 text-3xl font-bold sm:text-4xl">The problem it solves</h2>
  <p class="text-lg leading-relaxed text-stone-600 dark:text-stone-400">
    Every table API ends up with the same ad-hoc logic: parse sort params, build <code>WHERE</code>
    clauses, run a count, hydrate rows, maybe group buckets for a filter sidebar. You rewrite it
    slightly differently each time, and the client has to learn a different shape each time.
    <span class="text-stone-800 dark:text-stone-200">drizzle-resource standardizes that entirely.</span>
  </p>
</div>

::landing-split{class="landing-two-col landing-two-col--problem"}
:::landing-split-left
::::u-page-card{:spotlight="true" class="landing-pipeline-card"}

<div>
  <p class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-primary">Staged pipeline</p>
  <h3 class="text-lg font-semibold text-stone-900 dark:text-white">Not a monolithic query</h3>
  <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
    Each stage runs in order. Any stage can be replaced independently.
  </p>
</div>

<div class="mt-6 flex flex-col">
  <div class="landing-pipeline-item">
    <div class="landing-pipeline-icon">1</div>
    <div class="landing-pipeline-copy">
      <div class="landing-pipeline-label">Scope merge</div>
      <div class="landing-pipeline-desc">Tenant filters run before any client filter.</div>
    </div>
  </div>
  <div class="landing-pipeline-item">
    <div class="landing-pipeline-icon">2</div>
    <div class="landing-pipeline-copy">
      <div class="landing-pipeline-label">Field validation</div>
      <div class="landing-pipeline-desc">Sort keys and filter paths checked against your schema.</div>
    </div>
  </div>
  <div class="landing-pipeline-item">
    <div class="landing-pipeline-icon">3</div>
    <div class="landing-pipeline-copy">
      <div class="landing-pipeline-label">ID select</div>
      <div class="landing-pipeline-desc">Paginated primary-key query with all filters applied.</div>
    </div>
  </div>
  <div class="landing-pipeline-item">
    <div class="landing-pipeline-icon">4</div>
    <div class="landing-pipeline-copy">
      <div class="landing-pipeline-label">Row hydration</div>
      <div class="landing-pipeline-desc">Rows loaded by ID with declared relations, in order.</div>
    </div>
  </div>
  <div class="landing-pipeline-item is-last">
    <div class="landing-pipeline-icon">5</div>
    <div class="landing-pipeline-copy">
      <div class="landing-pipeline-label">Facets</div>
      <div class="landing-pipeline-desc">Bucket counts resolved only when requested.</div>
    </div>
  </div>
</div>
::::
:::

:::landing-split-right{class="landing-code-panel"}

::::code-group

```ts twoslash [orders.resource.ts]
import { engine } from "./engine";
// ---cut-before---
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
    sort: { defaults: [{ key: "createdAt", dir: "desc" }] },
    facets: {
      allowed: ["status", "customer.name", "orderLines.product.category"],
    },
  },
});
```

```ts twoslash [request.ts]
import { ordersResource } from "./orders.resource";

const orders = ordersResource;
// ---cut-before---
await orders.query({
  context: { orgId: "acme" },
  request: {
    context: {},
    pagination: { pageIndex: 1, pageSize: 25 },
    sorting: [{ key: "customer.name", dir: "asc" }],
    search: { value: "laptop", fields: [] },
    filters: [
      {
        type: "condition",
        key: "orderLines.product.category",
        operator: "isAnyOf",
        value: ["laptops", "accessories"],
      },
      {
        type: "condition",
        key: "customer.billingCountry",
        operator: "is",
        value: "FR",
      },
    ],
    facets: [
      {
        key: "orderLines.product.category",
        mode: "exclude-self",
        limit: 10,
      },
    ],
  },
});
```

::::

:::
::
::

::div{class="landing-section-pad py-12"}

<div class="mb-8">
  <p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">Use cases</p>
  <h2 class="text-3xl font-bold sm:text-4xl">Where it fits in your stack</h2>
</div>

:::div{class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"}
::::u-page-card{:spotlight="true" to="/getting-started/introduction" title="Admin & data tables" description="One request shape drives filter bars, column sorting, search, pagination, and row selection. No bespoke API per table."}
::::

::::u-page-card{:spotlight="true" to="/query-contract/facets" title="Faceted explorer UIs" description="Facet requests travel in the same payload as the main query. No parallel API needed."}
::::

::::u-page-card{:spotlight="true" to="/resource-setup/strategies" title="IDs-first pipelines" description="Cache or delay row hydration by splitting into queryIds and queryRows. The contract stays identical."}
::::

::::u-page-card{:spotlight="true" to="/resource-setup/scope" title="Multi-tenant APIs" description="Scope filters merge before any client filter and cannot be bypassed. Tenancy is a structural guarantee."}
::::

::::u-page-card{:spotlight="true" to="/performance/overview" title="Tunable performance" description="Start with automatic execution. Replace only the expensive stage when benchmarks show a bottleneck."}
::::

::::u-page-card{:spotlight="true" to="/reference/methods" title="Fully typed field paths" description="Field paths inferred from your schema and relations. Typos in sort keys or filter fields are compile-time errors."}
::::
:::
::

::div{class="landing-section-pad pb-28 pt-8"}

:::u-page-card{:spotlight="true" class="landing-cta"}

<h2 class="mb-3 text-3xl font-bold text-stone-900 dark:text-white sm:text-4xl">
  Ready to standardize<br />your table APIs?
</h2>
<p class="mb-8 text-base text-stone-600 dark:text-stone-400">
  Define your engine, add a resource, run your first query.
</p>

<div class="flex justify-center">

::::u-button{color="primary" size="xl" to="/getting-started/quick-start" trailing-icon="i-lucide-arrow-right"}
Quick Start
::::

</div>

:::

::
::
