---
"drizzle-resource": major
---

Add built-in cursor pagination with stable keyset ordering and optional exact counts. Pagination requests now use explicit offset or cursor modes, query responses expose mode-specific `pageInfo`, and the Zod and Valibot schemas validate the same discriminated contract.
