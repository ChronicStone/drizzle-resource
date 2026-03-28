---
seo:
  title: Drizzle Resource
  description: One typed contract for filtering, sorting, search, pagination, hydration, and facets on top of Drizzle ORM. Define once, query consistently.
---

::div{class="landing-page relative"}
::div{class="landing-ambient pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-visible"}

<div class="absolute left-1/2 top-0 h-[400px] w-[70vw] max-w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[100px] bg-amber-400/25 dark:bg-amber-500/18 sm:h-[500px] lg:h-[600px]"></div>
<div class="dot-grid absolute inset-0 h-screen opacity-20"></div>
::

::div{class="mx-auto max-w-[80rem] px-4 sm:px-6 lg:px-8"}
::div{class="grid gap-10 pb-12 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center"}
::div

<div class="mb-8 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-700 dark:border-primary/20 dark:bg-primary/8 dark:text-primary">
  For Drizzle ORM
</div>

# One contract.

<span class="text-primary">Every table</span>  
endpoint.

<p class="mt-6 max-w-xl text-lg leading-relaxed text-stone-600 dark:text-stone-400">
  <code class="rounded bg-stone-100 px-1.5 py-0.5 text-base text-stone-700 dark:bg-white/8 dark:text-stone-200">drizzle-resource</code>
  gives your server a typed query layer for filters, search, sorting, pagination, row hydration, and facets, all inferred from your Drizzle schema.
</p>

<div class="mt-8 flex flex-wrap items-center gap-3">
  <a class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95" href="/getting-started/quick-start">
    Get started
    <span aria-hidden="true">→</span>
  </a>
  <a class="inline-flex items-center gap-2 rounded-xl border border-stone-300 px-5 py-3 text-sm font-semibold text-stone-900 transition hover:border-stone-400 dark:border-white/10 dark:text-white dark:hover:border-white/20" href="/getting-started/introduction">
    Introduction
  </a>
</div>
::

```ts twoslash
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

::

::div{class="py-12"}

## The problem it solves

Every table API ends up with the same ad-hoc logic: parse sort params, build `WHERE` clauses, run a count, hydrate rows, maybe group buckets for a filter sidebar. You rewrite it slightly differently each time, and the client has to learn a different shape each time. **drizzle-resource standardizes that entirely.**

::div{class="mt-8 grid gap-6 lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)] lg:items-start"}
::div{class="rounded-3xl border border-stone-200 bg-white/80 p-6 shadow-sm dark:border-white/10 dark:bg-white/5"}

<p class="mb-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">Staged pipeline</p>
<h3 class="text-lg font-semibold text-stone-900 dark:text-white">Not a monolithic query</h3>
<p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Each stage runs in order. Any stage can be replaced independently.</p>

<ol class="mt-6 space-y-4">
  <li class="flex gap-3">
    <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-primary dark:bg-primary/10">1</div>
    <div>
      <div class="text-sm font-medium text-stone-900 dark:text-white">Scope merge</div>
      <div class="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">Tenant filters run before any client filter.</div>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-primary dark:bg-primary/10">2</div>
    <div>
      <div class="text-sm font-medium text-stone-900 dark:text-white">Field validation</div>
      <div class="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">Sort keys and filter paths are checked against your schema.</div>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-primary dark:bg-primary/10">3</div>
    <div>
      <div class="text-sm font-medium text-stone-900 dark:text-white">ID select</div>
      <div class="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">Paginated primary-key query with all filters applied.</div>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-primary dark:bg-primary/10">4</div>
    <div>
      <div class="text-sm font-medium text-stone-900 dark:text-white">Row hydration</div>
      <div class="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">Rows load by ID with declared relations, in order.</div>
    </div>
  </li>
  <li class="flex gap-3">
    <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-primary dark:bg-primary/10">5</div>
    <div>
      <div class="text-sm font-medium text-stone-900 dark:text-white">Facets</div>
      <div class="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">Bucket counts resolve only when requested.</div>
    </div>
  </li>
</ol>
::

::div

```ts twoslash
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

```ts twoslash
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

::
::
::

::div{class="py-12"}

<p class="mb-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">Use cases</p>
## Where it fits in your stack

::div{class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}
<a class="landing-card" href="/getting-started/introduction">

  <h3>Admin &amp; data tables</h3>
  <p>One request shape drives filter bars, column sorting, search, pagination, and row selection.</p>
</a>
<a class="landing-card" href="/query-contract/facets">
  <h3>Faceted explorer UIs</h3>
  <p>Facet requests travel in the same payload as the main query. No parallel API needed.</p>
</a>
<a class="landing-card" href="/resource-setup/strategies">
  <h3>IDs-first pipelines</h3>
  <p>Cache or delay row hydration by splitting into <code>queryIds</code> and <code>queryRows</code>.</p>
</a>
<a class="landing-card" href="/resource-setup/scope">
  <h3>Multi-tenant APIs</h3>
  <p>Scope filters merge before any client filter and cannot be bypassed. Tenancy is structural.</p>
</a>
<a class="landing-card" href="/performance/overview">
  <h3>Tunable performance</h3>
  <p>Start with automatic execution. Replace only the expensive stage when benchmarks show a bottleneck.</p>
</a>
<a class="landing-card" href="/reference/methods">
  <h3>Typed field paths</h3>
  <p>Sort keys and filter paths are inferred from your schema and relations at compile time.</p>
</a>
::
::

::div{class="pb-28 pt-8"}

<div class="mx-auto max-w-2xl rounded-3xl border border-amber-200 bg-amber-50 p-12 text-center dark:border-primary/15 dark:bg-primary/5">
  <h2 class="mb-3 text-3xl font-bold text-stone-900 dark:text-white sm:text-4xl">Ready to standardize your table APIs?</h2>
  <p class="mb-8 text-base text-stone-600 dark:text-stone-400">Define your engine, add a resource, run your first query.</p>
  <a class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95" href="/getting-started/quick-start">
    Quick Start
    <span aria-hidden="true">→</span>
  </a>
</div>
::
::
::
