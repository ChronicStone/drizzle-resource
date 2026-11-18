---
"@drizzle-resource/core": patch
"drizzle-resource": patch
---

Reduce PostgreSQL work for cursor pages, multi-value filters, searches across fields on the same relation, and exact counts for bounded unique-key selections. Large unfiltered reports can count repeated foreign keys before joining related facets.
