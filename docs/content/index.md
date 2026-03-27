---
seo:
  title: Drizzle Query Resource Documentation
  description: Schema-driven query resources for Drizzle ORM with one reusable contract for filters, search, sorting, pagination, hydration, and facets.
---

::u-page-hero
#headline
  :::u-badge
  ---
  color: primary
  variant: subtle
  icon: i-lucide-network
  ---
  Drizzle ORM query layer
  :::

#title
One typed contract for every table, explorer, and faceted search screen

#description
Drizzle Query Resource gives your backend one reusable request language for filters, search, sorting, pagination, hydration, and facets, while keeping field paths typed against your schema and relations.

#links
  :::u-button
  ---
  color: neutral
  size: xl
  to: /getting-started/quick-start
  trailing-icon: i-lucide-arrow-right
  ---
  Build your first resource
  :::

  :::u-button
  ---
  color: neutral
  size: xl
  to: /query-contract/overview
  variant: outline
  ---
  Learn the query contract
  :::

  :::u-button
  ---
  color: neutral
  size: xl
  to: /configuration/overview
  variant: outline
  ---
  Configure behavior
  :::
::

::u-page-section
#title
See the package the way you actually use it

#description
The docs are split into the same two tracks your codebase cares about: what the client can send, and how the resource definition shapes or overrides that behavior.

  :::u-page-grid
    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2
    ---
      <div class="overflow-hidden rounded-xl border border-default bg-(--ui-bg-elevated)">
        <img
          src="/hero-light.svg"
          alt="Drizzle Query Resource request pipeline diagram"
          class="block w-full dark:hidden"
        >
        <img
          src="/hero-dark.svg"
          alt="Drizzle Query Resource request pipeline diagram"
          class="hidden w-full dark:block"
        >
      </div>

    #title
    One request goes through a consistent pipeline

    #description
    Scope filters are merged, defaults are normalized, fields are validated, ids are selected, rows are hydrated, and facets are resolved only when requested.
    ::::

    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2 md:col-span-1
    to: /query-contract/overview
    ---
    #title
    Query Contract

    #description
    Start here if you are building the client payload. It explains the request shape, filter trees, search fields, sorting, facets, and pagination semantics.

    ```ts [query.ts]
    await employees.query({
      context: { orgId: 'fr' },
      request: {
        pagination: { pageIndex: 1, pageSize: 25 },
        sorting: [{ key: 'fullName', dir: 'asc' }],
        search: { value: 'ada', fields: [] },
        filters: {
          type: 'group',
          combinator: 'and',
          children: [],
        },
        context: {},
      },
    })
    ```
    ::::

    ::::u-page-card
    ---
    spotlight: true
    class: col-span-2 md:col-span-1
    to: /configuration/overview
    ---
    #title
    Configuration

    #description
    Start here if you are defining the table-level behavior. It explains which fields are allowed, hidden, defaulted, disabled, or overridden by strategy hooks.

    ```ts [resource.ts]
    const employees = engine.defineResource('employees', {
      relations: {
        department: {
          with: {
            company: true,
          },
        },
      },
      query: {
        search: {
          defaults: ['fullName', 'department.company.name'],
        },
      },
    })
    ```
    ::::
  :::
::

::u-page-section
#title
Follow the path that matches the problem in front of you

#features
  :::u-page-feature
  ---
  icon: i-lucide-rocket
  to: /getting-started/quick-start
  ---
  #title
  Stand up a first resource

  #description
  Create the engine, define a resource, and run a complete query from a real Drizzle setup.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-send
  to: /query-contract/request-object
  ---
  #title
  Model the client payload

  #description
  Learn exactly what the client can send and how the engine interprets each request field.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-sliders-horizontal
  to: /configuration/filters
  ---
  #title
  Shape resource policy

  #description
  Decide which fields are hidden, searchable, sortable, facetable, or defaulted for a given table.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-wrench
  to: /configuration/strategies
  ---
  #title
  Override execution safely

  #description
  Replace only the stage that needs customization and reuse the built-in helpers when the contract should stay the same.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-book-open
  to: /api/resource-methods
  ---
  #title
  Read the runtime API

  #description
  Jump straight to method signatures, strategy hooks, request shapes, and public types when you need exact reference material.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-gauge
  to: /guide/tune-performance
  ---
  #title
  Measure before overriding

  #description
  Use the performance notes and benchmark guidance to decide whether `ids`, `rows`, `facets`, or `query` is the right override.
  :::
::

::u-page-section
#title
Use the package where table APIs usually get messy

  :::u-page-grid
    ::::u-page-card
    ---
    class: col-span-2 md:col-span-1
    ---
    #title
    Admin tables

    #description
    Reuse one request contract across filters, search bars, sorting, bulk lists, and pagination controls.
    ::::

    ::::u-page-card
    ---
    class: col-span-2 md:col-span-1
    ---
    #title
    Faceted explorer UIs

    #description
    Add facet requests to the same contract instead of inventing a parallel API shape for filters and buckets.
    ::::

    ::::u-page-card
    ---
    class: col-span-2 md:col-span-1
    ---
    #title
    Ids-first pipelines

    #description
    Split page selection from row hydration when caching, batching, or delayed hydration makes more sense.
    ::::
  :::
::
