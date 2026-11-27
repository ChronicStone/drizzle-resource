---
"drizzle-resource": patch
"@drizzle-resource/core": patch
---

Fix wrong counts in the shared `GROUPING SETS` facet statement: a root-column facet that shared a statement with a relation facet lost the rows whose relation is empty, because the statement inner-joined the relation. Facets now share a statement only when they read the same relations, and the exact count only rides in a statement with no inner-joined relation.
