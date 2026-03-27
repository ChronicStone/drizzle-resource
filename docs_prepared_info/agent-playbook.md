# Agent Playbook

This guide is for AI agents and automation tooling that need to create or modify resources built with `@exassess/drizzle-query-resource`.

## Primary Goal

When working on a resource, preserve these guarantees:

- public field paths stay valid and intentional
- scopes enforce tenant/auth constraints by default
- query defaults remain predictable
- custom strategies reuse built-in helpers where possible
- performance tradeoffs are documented when deviating from defaults

## Safe Workflow

1. Identify the root table, Drizzle schema entry, and relations object.
2. Inspect the existing `relations` tree on the resource.
3. Enumerate the public query contract:
   - searchable fields
   - sortable fields
   - filterable fields
   - facetable fields
4. Add or update tests before changing strategy behavior.
5. Prefer declarative `query` config first.
6. Introduce `strategy.*` overrides only when there is a concrete SQL or shape requirement.
7. Document any performance-sensitive decision in the package or app docs.

## Preferred Patterns

### Use `defineScope` for shared constraints

Good:

```ts
const employeeScope = engine.defineScope('employees', employeeWith, (ctx, filters) =>
  filters.and([filters.is('department.company.country', ctx.orgId)]),
)
```

Why:

- keeps field paths typed
- makes auth/tenant logic reusable
- reduces copy-paste across resources

### Override `strategy.ids` before `strategy.query`

Prefer:

- `strategy.ids` when only page selection/count SQL is special
- `strategy.rows` when only hydration is special

Avoid jumping directly to `strategy.query` unless the full pipeline truly needs replacing.

When the motivation is performance:

- compare the built-in ids plan with a tailored ids query before replacing hydration
- keep the public API contract unchanged whenever possible
- document why the generic planner was not sufficient for that resource

### Reuse `utils`

Inside strategies, prefer:

- `utils.buildWhereClause(request)`
- `utils.compileOrderBy(request.sorting)`
- `utils.executeRowsQuery({ ids, request })`
- `utils.resolveFacets({ request, facets })`

This keeps custom behavior aligned with the standard request contract.

## Common Mistakes

### Exposing too many fields

If a field should never be publicly queryable, place it in `query.filters.hidden`.

### Allowing unsupported many-path sorting

Many-to-many or unstable relation paths often need `query.sort.disabled` or a custom ids strategy.

### Forgetting default search fields

If the client sends `search.fields: []`, the package falls back to `query.search.defaults`. Agents should usually configure this explicitly.

### Using full-query overrides too early

A custom `strategy.query` is powerful, but it also bypasses the clearer staged model of ids, rows, and facets.

## Minimum Test Expectations For A Resource Change

When changing or adding a resource, cover:

- default pagination/sorting normalization
- scope merging
- accepted and rejected field paths
- ids-only flow if custom ids logic exists
- row ordering after hydration
- facets behavior if the endpoint exposes them
- type inference if the change affects relations or row shape

## Performance Escalation Rules

Reach for custom strategies when one of these is true:

- explain plans show relation-heavy sorts or facets are too expensive
- many simultaneous facets multiply SQL cost too much
- offset pagination is too slow for the target dataset
- row hydration fetches more relational data than the endpoint needs

If you change strategy behavior for performance, add:

- a code comment or doc note explaining why
- a test covering the intended behavior
- a benchmark or follow-up note when the change is substantial

## Auto Mode Guidance

Agents should treat the built-in automatic mode as the preferred starting point, not as a guarantee of optimal SQL.

Use automatic mode first when:

- the resource is small or moderate in size
- queries mostly stay on root fields or single-valued relations
- facets are absent or lightweight

Escalate earlier to `strategy.ids` when:

- ids/count queries are clearly slower than row hydration
- the resource sorts or filters through relation paths
- many-to-many search or facets are in the hot path
- benchmark evidence shows a large gap between automatic and tailored ids plans

Be cautious with facets when:

- multiple facets are resolved in one request
- one of the facets is many-to-many
- search, facets, and deep pagination are combined
- raising pool size increases DB pressure more than it improves latency

## Release Hygiene

Before considering the package or a resource change release-ready:

- tests pass
- typecheck passes
- build passes
- README/docs examples still match the code
- public JSDoc explains the changed surface
