# Configuration Reference

This page is a release-oriented reference for `@exassess/drizzle-query-resource`.

## Engine Setup

```ts
const engine = createQueryEngine({
  db,
  schema,
  relations,
})
```

### `db`

Your Drizzle database instance. It must expose:

- relational queries at `db.query.<table>.findMany(...)`
- SQL builder methods used by the default engine

### `schema`

Your Drizzle schema map keyed by table name.

### `relations`

Your Drizzle relations map built from the same schema. It is used for:

- nested field-path inference
- relation traversal
- built-in rows hydration typing
- many-path SQL compilation

## `defineResource(root, options)`

```ts
const resource = engine.defineResource('employees', {
  relations: { ... },
  query: { ... },
  strategy: { ... },
})
```

### `root`

The schema/query key for the root table, for example:

- `'employees'`
- `'departments'`
- `'companies'`

### `options.relations`

Optional Drizzle `with` tree. This controls:

- which nested field paths become valid
- the default row type
- what the built-in rows query hydrates

Example:

```ts
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
}
```

## `options.query`

Declarative query behavior.

### `query.scope`

Function that returns extra filters automatically merged into every request.

Best used for:

- tenancy
- authorization
- soft-delete constraints
- record visibility rules

Example:

```ts
scope: (ctx, filters) => filters.and([filters.is('department.company.country', ctx.orgId)])
```

### `query.search.allowed`

Restricts which fields can be used in `request.search.fields`.

If omitted, every registered field is considered searchable.

### `query.search.defaults`

Fallback fields used when `request.search.fields` is empty.

Example:

```ts
search: {
  defaults: ['fullName', 'department.company.name'],
}
```

### `query.sort.disabled`

Fields that remain known to the resource but cannot be sorted.

Useful for:

- many-to-many relation paths
- non-deterministic SQL expressions
- fields that would require a custom sort strategy

### `query.sort.defaults`

Fallback sort list when `request.sorting` is empty.

Example:

```ts
sort: {
  defaults: [{ key: 'id', dir: 'asc' }],
}
```

### `query.filters.hidden`

Fields removed from the field registry entirely.

Use this when a field should be invisible to the public querying contract.

### `query.filters.disabled`

Fields that are still known, but rejected as filters.

Use this when:

- search is okay but explicit filtering is not
- the field is returned in docs/metadata but not supported for filters

### `query.facets.allowed`

Restricts which fields may appear in facet requests.

If omitted, every registered field is considered facetable.

### `query.defaults.pagination`

Fallbacks for invalid or missing pagination values.

Example:

```ts
defaults: {
  pagination: {
    pageIndex: 1,
    pageSize: 50,
  },
}
```

## `options.strategy`

Imperative escape hatches.

### `strategy.query(args)`

Full override for `resource.query(...)`.

Choose this when:

- ids/rows/facets should come from one custom backend call
- you need a custom row shape plus custom counts
- the default pipeline no longer maps well to the endpoint

### `strategy.ids(args)`

Override only the ids + count stage.

Recommended when:

- the default SQL plan is close but not enough
- you need custom joins, CTEs, or ranking
- you still want built-in row hydration

Performance note:

- this is usually the highest-leverage override for relation-heavy resources
- it preserves the package contract while letting you tailor count and page-id selection
- benchmark ids/count cost before replacing rows hydration or the full query pipeline

### `strategy.rows(args)`

Override only hydration.

Recommended when:

- you want a projection instead of Drizzle relational rows
- you want batched service calls
- you need denormalized rows

### `strategy.facets(args)`

Override facet resolution.

Recommended when:

- the built-in per-facet grouped SQL is too expensive
- you need precomputed buckets
- you need custom aggregation semantics

Performance note:

- facet cost grows quickly on many-to-many paths and broad requests
- concurrency often exposes facet problems sooner than single-request benchmarks
- optimize `strategy.ids` first, then evaluate whether `strategy.facets` is still necessary

## Request Reference

```ts
type QueryRequest = {
  pagination: {
    pageIndex: number
    pageSize: number
  }
  sorting: Array<{
    key: string
    dir: 'asc' | 'desc'
  }>
  filters: QueryFilterGroup
  search: {
    value: string
    fields: string[]
  }
  context: Record<string, unknown>
  facets?: QueryFacetRequest[]
}
```

### Request validation behavior

- unknown sort fields throw
- unknown search fields throw
- unknown filter fields throw
- unknown facet fields throw
- empty `search.fields` uses configured defaults
- invalid pagination values are normalized before strategies run

## Utility Helpers

Inside strategies, `args.utils` exposes:

- `compileCondition`
- `compileFilterNode`
- `compileSearch`
- `compileOrderBy`
- `buildWhereClause`
- `executeIdsQuery`
- `executeRowsQuery`

## Performance Checklist

Before reaching for `strategy.query`, check these first:

- Are the relevant search/filter/sort columns indexed?
- Does the resource really need all currently allowed relation-path sorts?
- Are many-to-many paths exposing avoidable ids-stage cost?
- Would a custom `strategy.ids` remove unnecessary joins or dedupe work?
- Is the DB pool too large for facet-heavy traffic?
- Are page size and deep offsets making the ids stage worse than it needs to be?
- `executeHydratedPage`
- `resolveFacets`
- `resolveField`

Practical pattern:

```ts
strategy: {
  ids: async ({ request, utils }) => {
    const whereClause = utils.buildWhereClause(request)
    const orderBy = utils.compileOrderBy(request.sorting)

    // use whereClause and orderBy in custom SQL
    return {
      ids: [],
      rowCount: 0,
    }
  },
}
```

## Recommended Defaults

For a first release:

- define `query.search.defaults`
- define `query.sort.defaults`
- explicitly define `query.facets.allowed`
- hide fields you never want exposed publicly
- start with built-in execution before overriding strategies
