---
"drizzle-resource": patch
"@drizzle-resource/core": patch
"@drizzle-resource/vine": patch
"@drizzle-resource/zod": patch
"@drizzle-resource/valibot": patch
---

Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.
