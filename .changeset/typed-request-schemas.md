---
"drizzle-resource": patch
"@drizzle-resource/zod": patch
"@drizzle-resource/valibot": patch
---

`requestSchema` from `drizzle-resource/zod` and `drizzle-resource/valibot` now returns a typed schema instead of `any`. Parsing gives a `QueryRequestSchemaOutput` (the request with every default filled in, without `context`), the same shape the Vine schema already returned.
