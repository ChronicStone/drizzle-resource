---
"drizzle-resource": patch
"@drizzle-resource/core": patch
---

Support drizzle-orm `1.0.0-rc.5`. Row, view and model field types were read from the return type of `db.query[table].findMany`, which resolves to `unknown` fields with rc.5. They now come from the table's `$inferSelect`. The minimum drizzle-orm version is `1.0.0-rc.5`.
