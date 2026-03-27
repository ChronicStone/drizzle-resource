---
seo:
  title: drizzle resource — typed query resources for Drizzle ORM
  description: One typed contract for filtering, sorting, search, pagination, hydration, and facets on top of Drizzle ORM. Define once, query consistently.
---

::u-page-hero
#headline
  :::u-badge
  ---
  color: primary
  variant: subtle
  icon: i-lucide-layers
  ---
  For Drizzle ORM
  :::

#title
One contract. Every table endpoint.

#description
`drizzle-resource` gives your server a single typed query layer for filters, search, sorting, pagination, row hydration, and facets — all inferred from your Drizzle schema and relations.

#links
  :::u-button
  ---
  color: primary
  size: xl
  to: /getting-started/quick-start
  trailing-icon: i-lucide-arrow-right
  ---
  Get started
  :::

  :::u-button
  ---
  color: neutral
  size: xl
  to: /query-contract/request-shape
  variant: outline
  ---
  See the request shape
  :::
::

::u-page-section
#title
The problem it solves

#description
Every table API you write ends up with the same ad-hoc logic: parse sort params, build WHERE clauses, run a count, hydrate rows, maybe group some buckets for a filter sidebar. You rewrite it slightly differently each time, and the client has to learn a different shape each time. `drizzle-resource` standardizes that entirely.

  :::u-page-grid
    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2
    ---
      <div class="overflow-hidden rounded-xl border border-default bg-(--ui-bg-elevated)">
        <img
          src="/hero-light.svg"
          alt="drizzle resource query pipeline"
          class="block w-full dark:hidden"
        >
        <img
          src="/hero-dark.svg"
          alt="drizzle resource query pipeline"
          class="hidden w-full dark:block"
        >
      </div>

    #title
    A staged pipeline, not a monolithic query

    #description
    Every request goes through the same stages: scope filters are merged, defaults are applied, field paths are validated against your schema, ids are selected, rows are hydrated, and facets are resolved only when requested. Each stage can be replaced independently.
    ::::

    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2 md:col-span-1
    to: /query-contract/request-shape
    ---
    #title
    Client-side: the query contract

    #description
    The request shape your frontend sends — filter trees, search fields, sort keys, facet requests, pagination. Documented separately so UI authors don't need to read server config.

    ```ts [request.ts]
    await orders.query({
      context: { orgId: 'acme' },
      request: {
        pagination: { pageIndex: 1, pageSize: 25 },
        sorting: [{ key: 'createdAt', dir: 'desc' }],
        search: { value: 'laptop', fields: [] },
        filters: {
          type: 'group',
          combinator: 'and',
          children: [
            {
              type: 'condition',
              key: 'status',
              operator: 'isAnyOf',
              value: ['pending', 'processing'],
            },
          ],
        },
        facets: [{ key: 'status', mode: 'exclude-self', limit: 10 }],
      },
    })
    ```
    ::::

    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2 md:col-span-1
    to: /resource-setup/defining-a-resource
    ---
    #title
    Server-side: resource setup

    #description
    Where you define which fields are searchable, sortable, facetable, hidden, or scoped — and optionally override any stage of the execution pipeline.

    ```ts [orders.resource.ts]
    export const ordersResource = engine.defineResource('orders', {
      relations: {
        customer: true,
        orderLines: { with: { product: true } },
      },
      query: {
        scope: engine.defineScope('orders', {}, (ctx, f) =>
          f.is('customer.orgId', ctx.orgId)
        ),
        search: {
          allowed: ['reference', 'customer.name', 'orderLines.product.name'],
          defaults: ['reference', 'customer.name'],
        },
        sort: {
          defaults: [{ key: 'createdAt', dir: 'desc' }],
        },
        facets: {
          allowed: ['status', 'customer.name'],
        },
      },
    })
    ```
    ::::
  :::
::

::u-page-section
#title
Where it fits in your stack

#features
  :::u-page-feature
  ---
  icon: i-lucide-table-2
  to: /getting-started/introduction
  ---
  #title
  Admin and data tables

  #description
  One request shape drives filter bars, column sorting, search inputs, pagination controls, and row selection. No bespoke API per table.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-filter
  to: /query-contract/facets
  ---
  #title
  Faceted explorer UIs

  #description
  Facet requests travel in the same payload as the main query. The engine resolves them against the same filter universe. No parallel API needed.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-split
  to: /resource-setup/strategies
  ---
  #title
  Ids-first pipelines

  #description
  When you need to cache, batch, or delay row hydration, split the query into separate `queryIds` and `queryRows` calls. The contract stays identical.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-shield-check
  to: /resource-setup/scope
  ---
  #title
  Multi-tenant APIs

  #description
  Scope filters merge automatically into every request. Your tenancy constraint runs before any client-supplied filter and cannot be bypassed.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-gauge
  to: /performance/overview
  ---
  #title
  Tunable performance

  #description
  Start with automatic execution. When benchmarks show a bottleneck, replace only the expensive stage using the built-in SQL helpers.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-code-2
  to: /reference/methods
  ---
  #title
  Fully typed field paths

  #description
  Field paths are inferred from your schema and declared relations. Typos in sort keys, filter fields, or facet paths are caught at compile time.
  :::
::
