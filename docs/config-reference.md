# Configuration Reference

This page captures the release-oriented configuration surface for `@exassess/drizzle-query-resource`.

## Engine Setup

```ts
const engine = createQueryEngine({
  db,
  schema,
  relations,
})
```

### `db`

Your Drizzle database instance. It must expose relational queries at `db.query.<table>.findMany(...)` and the SQL builder methods used by the default engine.

### `schema`

Your Drizzle schema map keyed by table name.

### `relations`

Your Drizzle relations map built from the same schema. It is used for nested field-path inference, relation traversal, built-in hydration typing, and many-path SQL compilation.

## `defineResource(root, options)`

```ts
const resource = engine.defineResource('employees', {
  relations: { ... },
  query: { ... },
  strategy: { ... },
})
```

### `options.relations`

The optional Drizzle `with` tree controls:

- which nested field paths become valid
- the default row type
- what the built-in rows query hydrates

### `options.query`

Use `query` for declarative behavior:

- `scope`
- `search.allowed`
- `search.defaults`
- `sort.defaults`
- `sort.disabled`
- `filters.hidden`
- `filters.disabled`
- `facets.allowed`
- `defaults.pagination`

### `options.strategy`

Use strategy overrides as escape hatches:

- `strategy.query(args)` for a full override
- `strategy.ids(args)` for ids and count only
- `strategy.rows(args)` for custom hydration
- `strategy.facets(args)` for custom facet execution

## Request Validation Behavior

The package rejects:

- unknown sort fields
- unknown search fields
- unknown filter fields
- unknown facet fields

It also normalizes invalid pagination values and uses `query.search.defaults` when `search.fields` is empty.
