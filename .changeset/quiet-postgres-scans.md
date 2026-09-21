---
"drizzle-resource": patch
---

Reduce PostgreSQL CPU and temporary-memory work with schema-proven direct ID paging, distinct-free counts where safe, and compatible facet aggregation through GROUPING SETS. Aggregate facets without a matching-ID self-join and avoid retaining unbounded request-plan caches. Preserve access-scope filters when resolving exclude-self facets, retain distinct counting for multiplying joins, and return facet results in request order. Add real PostgreSQL regression coverage and a reproducible 200,000-row comparison harness.
