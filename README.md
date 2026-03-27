# Drizzle Query Resource

`@exassess/drizzle-query-resource` is a schema-driven query layer for Drizzle ORM that standardizes filtering, search, sorting, pagination, row hydration, and facets behind a small typed API.

It is designed for server endpoints that need one reusable contract for:

- table/grid queries
- faceted search UIs
- "ids first, hydrate later" flows
- multi-tenant scoping
- custom SQL strategies without losing typed field paths

## Highlights

- Type-safe field paths inferred from your Drizzle schema and relations
- Declarative resource config for search, sort, filters, defaults, and facets
- Reusable typed scope builders for auth/tenant constraints
- Built-in SQL compiler for ids, counts, search, and facets
- Optional strategy overrides for custom ids, rows, full-query, or facet execution
- Default row typing derived from Drizzle `findMany({ with })`

## Installation

```sh
bun add @exassess/drizzle-query-resource drizzle-orm
```

`drizzle-orm` is a peer dependency.

## Quick Start

```ts
import { createQueryEngine } from '@exassess/drizzle-query-resource'
import db from '#db'
import * as schema from '#generated/db/schemas'
import { relations } from '#generated/db/relations'

const engine = createQueryEngine({
  db,
  schema,
  relations,
}).withContext<{ orgId: string }>()

export const employeesResource = engine.defineResource('employees', {
  relations: {
    department: {
      with: {
        company: true,
      },
    },
    employeeSkills: {
      with: {
        skill: true,
      },
    },
  },

  query: {
    scope: engine.defineScope(
      'employees',
      {
        department: {
          with: {
            company: true,
          },
        },
        employeeSkills: {
          with: {
            skill: true,
          },
        },
      },
      (ctx, filters) => filters.and([filters.is('department.company.country', ctx.orgId)]),
    ),

    search: {
      allowed: [
        'fullName',
        'email',
        'department.name',
        'department.company.name',
        'employeeSkills.skill.label',
      ],
      defaults: ['fullName', 'department.company.name', 'employeeSkills.skill.label'],
    },

    sort: {
      defaults: [{ key: 'id', dir: 'asc' }],
      disabled: ['employeeSkills.skill.label'],
    },

    filters: {
      hidden: [],
      disabled: [],
    },

    facets: {
      allowed: ['department.name', 'department.company.name', 'employeeSkills.skill.label'],
    },

    defaults: {
      pagination: {
        pageSize: 25,
      },
    },
  },
})
```

Then query it:

```ts
const result = await employeesResource.query({
  context: {
    orgId: 'fr',
  },
  request: {
    pagination: {
      pageIndex: 1,
      pageSize: 25,
    },
    sorting: [{ key: 'fullName', dir: 'asc' }],
    search: {
      value: 'ada',
      fields: [],
    },
    filters: {
      type: 'group',
      combinator: 'and',
      children: [],
    },
    context: {},
    facets: [
      {
        key: 'department.name',
        mode: 'exclude-self',
        limit: 10,
      },
    ],
  },
})
```

## Core Model

The package revolves around three pieces:

1. `createQueryEngine({ db, schema, relations })`
2. `engine.defineResource(root, options)`
3. `resource.query*({ request, context })`

Each resource has:

- a root table key such as `'employees'`
- an optional Drizzle `relations.with` tree
- declarative query rules under `query`
- optional execution overrides under `strategy`

## Public Methods

Each resource exposes four methods:

- `resource.query({ request, context })`
- `resource.queryIds({ request, context })`
- `resource.queryRows({ request, ids, context })`
- `resource.queryFacets({ request, facets, context })`

### `query`

Runs the full page pipeline:

- normalize request defaults
- merge scope filters
- validate requested fields
- resolve ids and row count
- hydrate rows
- optionally resolve facets

### `queryIds`

Runs only the ids stage. Useful when you want:

- separate page selection and hydration
- custom caching
- delayed hydration
- background row loading

### `queryRows`

Hydrates a known ordered id list. The built-in implementation:

- deduplicates ids
- calls Drizzle `findMany({ where: { id: { in: ids } }, with: relations })`
- restores the original id order in memory

### `queryFacets`

Resolves facets independently of the main page flow.

## Request Semantics

### Pagination

- `pageIndex` is one-based
- invalid `pageIndex` falls back to `query.defaults.pagination.pageIndex` or `1`
- invalid `pageSize` falls back to `query.defaults.pagination.pageSize` or `25`

### Search

- `request.search.value === ''` disables search compilation
- `request.search.fields.length === 0` falls back to `query.search.defaults`
- search is case-insensitive

### Filters

Filters are tree-shaped:

```ts
{
  type: 'group',
  combinator: 'and',
  children: [
    {
      type: 'condition',
      key: 'department.company.name',
      operator: 'contains',
      value: 'labs',
    },
  ],
}
```

Supported operators:

- `contains`
- `is`
- `isAnyOf`
- `isNot`
- `gt`
- `gte`
- `lt`
- `lte`
- `between`
- `before`
- `after`

## Built-in Execution Model

When no custom strategies are supplied:

- ids are resolved with the built-in SQL compiler
- row hydration uses Drizzle relational queries
- facets are resolved by grouped SQL queries per requested facet

This full automatic mode is the best starting point for most resources because it keeps the pipeline simple, typed, and consistent.

The default rows query is conceptually:

```ts
db.query[root].findMany({
  where: {
    id: {
      in: ids,
    },
  },
  with: resource.relations,
})
```

## Performance Guidance

The package supports a full automatic mode, but automatic does not always mean optimal.

Real-world performance depends heavily on:

- relation shape
- whether requests touch many-to-many paths
- whether facets are requested
- whether sorting or search force extra joins
- dataset size and concurrency

### Recommended approach

- start in full automatic mode
- benchmark real endpoints under realistic load
- override `strategy.ids` before touching `strategy.rows` or `strategy.query`
- treat facets as a separate performance concern from ids and hydration

### Auto mode vs custom `strategy.ids`

In this repo, the benchmarked `employees` resource showed a large performance gap between the generic ids planner and a tailored `strategy.ids` implementation, while keeping the same API contract and built-in row hydration.

Reference docs:

- [`docs/performance-guide.md`](./docs/performance-guide.md)
- [`docs/benchmark-results.md`](./docs/benchmark-results.md)

Selected results:

| Scenario | Auto RPS | Manual RPS | Auto p99 | Manual p99 |
|---|---:|---:|---:|---:|
| baseline, 10 concurrency | 17.2 | 219.7 | 928ms | 92ms |
| baseline, 25 concurrency | 15.1 | 229.6 | 2136ms | 183ms |
| baseline, 50 concurrency | 14.1 | 240.9 | 4504ms | 409ms |
| m2m skill facet, 25 concurrency | 4.7 | 8.2 | 6427ms | 3535ms |

Takeaway:

- yes, there is a full auto mode
- no, you should not assume the generic ids planner is always the fastest option
- for relation-heavy resources, a targeted `strategy.ids` can be materially faster

### Facets and query cost

Facets can increase query cost quickly, especially when they interact with relation-heavy search and sorting.

General rules of thumb:

- root-column facets are usually the cheapest
- single-valued relation facets are usually manageable
- many-to-many facets are usually the most expensive
- broad search + multiple facets + deep pagination is the most expensive combination

Practical guidance:

- benchmark faceted and non-faceted traffic separately
- keep an eye on concurrency, not just single-request latency
- consider limiting facet count per request on larger resources
- consider reducing DB pool size if facet-heavy traffic overloads Postgres

### Common gotchas

- relation-path sorting often forces extra joins in the ids stage
- many-to-many search or facets often introduce dedupe-heavy SQL
- deep offset pagination can dominate total cost even when hydration is fine
- default row hydration is convenient, but ids selection is often the first thing to optimize
- improving pool throughput can make expensive facet queries hit the database harder, not cheaper

### Suggested rollout path

For a new resource:

1. Start in full automatic mode.
2. Add indexes for filter/search/sort hot paths.
3. Benchmark:
   - non-faceted queries
   - cheap facets
   - many-to-many facets
   - deep-page cases
4. If ids/count is the bottleneck, add `strategy.ids`.
5. If facets remain the bottleneck, evaluate `strategy.facets` or a more specialized backend strategy later.

## Strategy Overrides

You can override one stage or all stages.

### Override only ids

Use this when you need custom SQL for pagination/counting but still want default hydration:

```ts
const resource = engine.defineResource('employees', {
  relations: {
    department: {
      with: {
        company: true,
      },
    },
  },
  strategy: {
    ids: async ({ request, utils }) => {
      const whereClause = utils.buildWhereClause(request)
      const orderBy = utils.compileOrderBy(request.sorting)

      // custom Drizzle SQL here...
      return {
        ids: ['emp_1', 'emp_2'],
        rowCount: 2,
      }
    },
  },
})
```

### Override rows

Use this when:

- default `findMany` hydration is too expensive
- you want a custom projection
- you want non-Drizzle row assembly

### Override query

Use `strategy.query` when you want total control. If `strategy.query` returns `facets`, the package will not call `strategy.facets` again.

### Override facets

Use `strategy.facets` when:

- you want a different facet SQL plan
- you need custom bucket transforms
- you want to delegate facets to another service

## Type Inference

The default row type for `resource.query(...)` and `resource.queryRows(...)` is derived from:

- the resource root table
- the declared `relations`
- Drizzle relational query result typing

You can still override the row type manually:

```ts
const resource = engine.defineResource<
  'employees',
  typeof employeeWith,
  { orgId: string },
  { id: string; fullName: string; skillCount: number }
>('employees', {
  relations: employeeWith,
  strategy: {
    rows: async ({ ids }) =>
      ids.map((id) => ({
        id,
        fullName: 'Ada',
        skillCount: 4,
      })),
  },
})
```

## Scope Builders

`engine.defineScope(...)` exists so scope handlers stay typed and reusable.

```ts
const employeeScope = engine.defineScope('employees', employeeWith, (ctx, filters) =>
  filters.and([filters.is('department.company.country', ctx.orgId), filters.isNot('email', '')]),
)
```

Then reuse it:

```ts
const employees = engine.defineResource('employees', {
  relations: employeeWith,
  query: {
    scope: employeeScope,
  },
})
```

## Field Visibility Rules

### `filters.hidden`

Hidden fields are removed from the field registry entirely. That means they cannot be:

- filtered
- searched
- sorted
- faceted

### `filters.disabled`

Disabled filter fields remain known to the resource, but filtering on them is rejected.

### `sort.disabled`

Sort-disabled fields remain available for filters/search/facets, but sort compilation skips them.

## Facet Notes

The built-in facet resolver supports:

- `exclude-self` mode by default
- optional bucket search
- optional bucket pagination via `limit` + `nextCursor`
- relation and many-to-many field paths

Facet requests are validated against `query.facets.allowed`.

## Performance Notes

The built-in path is ergonomic, but release users should still think about database shape:

- add indexes for join/filter/sort columns
- watch deep offset pagination on large datasets
- many simultaneous facets multiply SQL work
- relation-heavy row hydration can dominate baseline latency

For high-scale screens, start with the default pipeline, measure it, and then override `strategy.ids`, `strategy.rows`, or `strategy.facets` selectively.

## Migration Alias

`defineQueryResource(...)` remains available as an alias of `defineResource(...)` for compatibility, but `defineResource(...)` is the intended long-term surface.

## Docs

- [Configuration reference](./docs/config-reference.md)
- [Agent integration playbook](./docs/agent-playbook.md)

## Release Checklist

Before publishing:

- run `bun run test`
- run `bun run typecheck`
- run `bun run build`
- verify README examples still match the current API
- confirm peer dependency compatibility with the Drizzle version you support
