---
"drizzle-resource": patch
---

Avoid joining configured relation search fields when the search value is empty, preserving rows whose optional relations are not loaded.
