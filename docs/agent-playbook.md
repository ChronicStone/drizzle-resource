# Agent Playbook

This guide is for AI agents and automation tooling that create or modify resources built with `@exassess/drizzle-query-resource`.

## Primary Goal

When working on a resource, preserve these guarantees:

- public field paths stay valid and intentional
- scopes enforce tenant and auth constraints by default
- query defaults remain predictable
- custom strategies reuse built-in helpers where possible
- performance tradeoffs are documented when deviating from defaults

## Safe Workflow

1. Identify the root table, Drizzle schema entry, and relations object.
2. Inspect the existing `relations` tree on the resource.
3. Enumerate the public query contract for searchable, sortable, filterable, and facetable fields.
4. Add or update tests before changing strategy behavior.
5. Prefer declarative `query` config first.
6. Introduce `strategy.*` overrides only when there is a concrete SQL or shape requirement.
7. Document any performance-sensitive decision in the package or app docs.

## Preferred Patterns

### Use `defineScope` for shared constraints

```ts
const employeeScope = engine.defineScope('employees', employeeWith, (ctx, filters) =>
  filters.and([filters.is('department.company.country', ctx.orgId)]),
)
```

### Override `strategy.ids` before `strategy.query`

Prefer:

- `strategy.ids` when only page selection and count SQL is special
- `strategy.rows` when only hydration is special

Avoid jumping directly to `strategy.query` unless the full pipeline truly needs replacing.

### Reuse `utils`

Inside custom strategies, prefer:

- `utils.buildWhereClause(request)`
- `utils.compileOrderBy(request.sorting)`
- `utils.executeRowsQuery({ ids, request })`
- `utils.resolveFacets({ request, facets })`

## Minimum Test Expectations

When changing or adding a resource, cover:

- default pagination and sorting normalization
- scope merging
- accepted and rejected field paths
- ids-only flow if custom ids logic exists
- row ordering after hydration
- facets behavior if the endpoint exposes them
- type inference if the change affects relations or row shape
