---
"drizzle-resource": patch
---

Preserve root matches when free-text search includes optional relation fields. Relation search predicates now use correlated existence checks, so missing relations cannot remove matches from other fields.
