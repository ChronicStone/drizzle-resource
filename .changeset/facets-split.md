---
"drizzle-resource": minor
"@drizzle-resource/core": minor
---

Run facets as separate statements on big tables. PostgreSQL cannot use parallel workers for a `GROUPING SETS` statement, so facets that shared one ran on a single CPU. Above `query.facets.splitAbove` estimated rows (default 100,000) each facet now gets its own statement, at most four at a time, and the exact count of a page is a statement of its own instead of riding in the shared one. Results, ordering, cursors, `missing`, `status` and per-facet timeouts are unchanged; a timed-out facet no longer takes the facets that shared its statement with it.

The estimate is the root table's `pg_class.reltuples`, read once and reused for five minutes. A request that filters or searches is judged by the planner's estimate of the rows it matches, so a narrow request keeps one shared statement. `splitAbove: 0` always splits and `Infinity` never does. The row estimate is reported to `onQuery` as a `plan` statement; `explain()` still reports `single-cpu-facets` for a shared statement that reads many rows, now with `splitAbove` as its fix.
