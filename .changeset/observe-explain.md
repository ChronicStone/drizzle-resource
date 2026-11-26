---
"drizzle-resource": minor
"@drizzle-resource/core": minor
---

Add `onQuery` to `createQueryEngine`: one event per statement the engine runs, with its stage (`ids`, `count`, `rows`, `facets`, `summary`, `plan`, `scan`), a value-free request shape, its duration, the rows it returned and its SQL with placeholders. A hook that throws never reaches the request, and an engine without a hook pays one boolean check per statement.

Add `resource.explain({ request, context, analyze })` and `formatExplain(report)`. It runs `EXPLAIN` (or `EXPLAIN ANALYZE, BUFFERS` in a transaction that is rolled back) on the exact statements `query` would run, and reports `full-count`, `index-walk`, `seq-scan`, `deep-offset`, `misestimate`, `relation-sort` and `single-cpu-facets` in plain words, with the numbers from the plan and a fix. PostgreSQL only.
