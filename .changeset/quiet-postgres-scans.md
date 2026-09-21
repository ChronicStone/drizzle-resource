---
"drizzle-resource": minor
---

Reduce PostgreSQL CPU and temporary-memory work with schema-proven direct ID paging, distinct-free counts where safe, and compatible facet aggregation through GROUPING SETS. Aggregate facets without a matching-ID self-join and avoid retaining unbounded request-plan caches. Preserve access-scope filters when resolving exclude-self facets, retain distinct counting for multiplying joins, and return facet results in request order. Add real PostgreSQL regression coverage and a reproducible 200,000-row comparison harness.

Add `resource.scan(options, consume)` for bounded bulk reads with inferred hydration profiles, backpressure, cancellation, and automatic cleanup. PostgreSQL executes the selection once using a forward-only server cursor inside a repeatable-read snapshot; portable and custom-strategy resources retain bounded pagination. Trusted batch sizes do not change public request limits.

Keep sorting-only relation membership out of aggregate joins, share compatible exact counts with facet aggregates, and probe PostgreSQL trigram indexes before optimizing cross-table substring searches. Compare native PostgreSQL plan costs before selecting an indexed union, preserving the ordinary search plan for broad matches where it is estimated cheaper. Preserve search semantics and fall back when compatible capabilities are absent.
