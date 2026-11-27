---
"drizzle-resource": minor
"@drizzle-resource/core": minor
"@drizzle-resource/zod": minor
"@drizzle-resource/valibot": minor
"@drizzle-resource/vine": minor
---

Add `capped` and `estimated` count modes, with `pagination.countCap` (10,000 by default) and typed `pageInfo` variants, so a page can show "10,000+" without reading every matching row. Offset pages read `hasNextPage` from a one-row lookahead whenever the count is not exact.

Add opt-in guards: `validation.maxPageIndex` (also enforced by the Zod, Valibot and Vine request schemas), `facets.whenCapped: "skip"` and per-stage `timeouts` for the count, facets and summary. A stage that times out degrades instead of failing the request. Every facet result now carries `status: "ok" | "skipped" | "timeout"`, and a summary carries `summaryStatus`.

Search without an exact count no longer trusts PostgreSQL's cost estimate, which took a rare term through the whole sort index. The count and the page each get bounded attempts: the ordinary plan under a time budget (`search.planBudget`, 25 ms by default), then the trigram-indexed plan under four times that budget, then the ordinary plan with no budget. A common term usually finishes in the first attempt. A term that matches nearly every row can miss the 25 ms budget and finish on a later attempt; raise `planBudget` if your ordinary search page takes longer than that. With a capped count, the count's result chooses where the page starts: a count under its cap starts it on the indexed plan, a count that hit the cap starts it on the ordinary plan. An `estimated` count over a search across tables falls back to `capped` and behaves the same way.

Type changes to check in your code:

- An exhaustive `switch (pageInfo.count)` must now handle `"capped"` and `"estimated"`.
- A `QueryCountMode` value no longer fits a parameter typed `"none" | "exact"`.
- `QueryFacetResult` gains an optional `status` and `reason`. Facets you write by hand keep compiling, and an absent `status` means `ok`. Use `QueryFacetOutcome` to narrow on `status`.
- `scan` accepts any `QueryCountMode` and rejects `"capped"` and `"estimated"` at runtime.
- `ResourceRuntimeQueryConfig` gains a required `timeouts` member. An object you build by hand and type as one needs it.

Search budgets and `timeouts` apply only when the engine owns the connection. With `db: tx` (your own transaction) the engine sets no `statement_timeout` and picks the search plan as before, because statements that overlap on one connection would share the limit.
