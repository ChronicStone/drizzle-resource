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

<div class="landing-badge mb-8">Typed query layer for Drizzle ORM</div>

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

::::u-button{color="neutral" size="xl" to="/playground" variant="outline"}
Playground
::::

</div>

<div class="landing-install mt-8">
  <span class="landing-install-prompt">$</span>
  <code>npm install drizzle-resource</code>
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

:::landing-pipeline
:::

::

::div{class="landing-section-pad py-12"}

::landing-split{class="landing-two-col landing-two-col--problem"}
:::landing-split-left

<p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">Define once</p>

<h2 class="mb-4 text-3xl font-bold sm:text-4xl">The resource is<br />the contract</h2>

<p class="mb-8 max-w-lg text-lg leading-relaxed text-stone-600 dark:text-stone-400">
  Declare relations, scope, search, sort, and facet policy next to your schema. Every endpoint
  speaks the same request shape — the server decides what is allowed.
</p>

<ul class="landing-ticks">
  <li>Scope filters merge server-side — clients cannot bypass tenancy</li>
  <li>Unknown sort keys and filter paths are rejected before any SQL runs</li>
  <li>The request shape never changes from one table to the next</li>
</ul>

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

<div class="mb-8 max-w-2xl">
  <p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">The contract</p>
  <h2 class="text-3xl font-bold sm:text-4xl">Six capabilities, one request</h2>
</div>

<div class="landing-spec">
  <div class="landing-spec-row">
    <div class="landing-spec-term">Filters</div>
    <div class="landing-spec-def">Nested AND/OR trees with 11 operators — <code>is</code>, <code>isAnyOf</code>, <code>contains</code>, <code>between</code>, <code>before</code>, <code>after</code>, and more.</div>
  </div>
  <div class="landing-spec-row">
    <div class="landing-spec-term">Search</div>
    <div class="landing-spec-def">Free-text matching across allowed field paths, with separate <code>allowed</code> and <code>defaults</code> lists per resource.</div>
  </div>
  <div class="landing-spec-row">
    <div class="landing-spec-term">Sorting</div>
    <div class="landing-spec-def">Multi-column with per-resource defaults. Disable expensive paths until they are benchmarked.</div>
  </div>
  <div class="landing-spec-row">
    <div class="landing-spec-term">Pagination</div>
    <div class="landing-spec-def">1-based page index and page size, with configurable defaults.</div>
  </div>
  <div class="landing-spec-row">
    <div class="landing-spec-term">Facets</div>
    <div class="landing-spec-def">Bucket counts for filter sidebars, traveling in the same payload as the main query.</div>
  </div>
  <div class="landing-spec-row">
    <div class="landing-spec-term">Scope</div>
    <div class="landing-spec-def">Context filters merged into every query before client input. Tenancy as a structural guarantee.</div>
  </div>
</div>

::

::div{class="landing-section-pad py-12"}

<div class="mb-8 max-w-2xl">
  <p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">Granular execution</p>
  <h2 class="text-3xl font-bold sm:text-4xl">Four methods, one pipeline</h2>
</div>

:::div{class="landing-methods"}
::::div{class="landing-method"}
<code class="landing-method-name">resource.query()</code>
<p class="landing-method-desc">The full pipeline — ids, rows, and optional facets in one call.</p>
::::

::::div{class="landing-method"}
<code class="landing-method-name">resource.queryIds()</code>
<p class="landing-method-desc">Page ids and total count only — cache or batch the rest.</p>
::::

::::div{class="landing-method"}
<code class="landing-method-name">resource.queryRows()</code>
<p class="landing-method-desc">Hydrate a known id list without re-running selection.</p>
::::

::::div{class="landing-method"}
<code class="landing-method-name">resource.queryFacets()</code>
<p class="landing-method-desc">Resolve facet buckets independently from the page.</p>
::::
:::

::

::div{class="landing-section-pad py-12"}

<div class="mb-8">
  <p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">Use cases</p>
  <h2 class="text-3xl font-bold sm:text-4xl">Where it fits in your stack</h2>
</div>

:::div{class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"}
::::u-page-card{:spotlight="true" icon="i-lucide-table-2" to="/getting-started/introduction" title="Admin & data tables" description="One request shape drives filter bars, column sorting, search, pagination, and row selection. No bespoke API per table."}
::::

::::u-page-card{:spotlight="true" icon="i-lucide-filter" to="/query-contract/facets" title="Faceted explorer UIs" description="Facet requests travel in the same payload as the main query. No parallel API needed."}
::::

::::u-page-card{:spotlight="true" icon="i-lucide-layers" to="/resource-setup/strategies" title="IDs-first pipelines" description="Cache or delay row hydration by splitting into queryIds and queryRows. The contract stays identical."}
::::

::::u-page-card{:spotlight="true" icon="i-lucide-shield-check" to="/resource-setup/scope" title="Multi-tenant APIs" description="Scope filters merge before any client filter and cannot be bypassed. Tenancy is a structural guarantee."}
::::

::::u-page-card{:spotlight="true" icon="i-lucide-gauge" to="/performance/overview" title="Tunable performance" description="Start with automatic execution. Replace only the expensive stage when benchmarks show a bottleneck."}
::::

::::u-page-card{:spotlight="true" icon="i-lucide-braces" to="/reference/methods" title="Fully typed field paths" description="Field paths inferred from your schema and relations. Typos in sort keys or filter fields are compile-time errors."}
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

<div class="flex flex-wrap justify-center gap-3">

::::u-button{color="primary" size="xl" to="/getting-started/quick-start" trailing-icon="i-lucide-arrow-right"}
Quick Start
::::

::::u-button{color="neutral" size="xl" to="/playground" variant="outline"}
Playground
::::

</div>

:::

::
::
