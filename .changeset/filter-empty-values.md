---
"@drizzle-resource/core": minor
"@drizzle-resource/zod": minor
"@drizzle-resource/valibot": minor
"@drizzle-resource/vine": minor
"drizzle-resource": minor
---

Add the `isEmpty` and `isNotEmpty` filter operators (null, `''` on text, empty arrays, or no related row on a relation path) and the facet `missing` count, requested with `missing: true`. A filter that tests a relation for emptiness reads every condition on that relation through `EXISTS`, so an `or` with a value keeps the rows without the relation.

`isNot` now excludes every listed value instead of only the first, and on a to-many path reads « has none of the values » (`NOT EXISTS`) instead of « has one related row with another value ».
