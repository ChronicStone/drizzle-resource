---
"@drizzle-resource/core": minor
"drizzle-resource": minor
---

Add `engine.checkIndexes()` and `resource.checkIndexes()`. They compare each resource's default sort, sortable columns, scope, search and facets with the indexes of its tables, and return findings with the Drizzle index and the SQL that fix them. `checkIndexes({ live: true })` reads the real btree and `pg_trgm` indexes and table sizes from PostgreSQL instead of the Drizzle schema. `formatIndexFindings(findings)` prints them for the console.
