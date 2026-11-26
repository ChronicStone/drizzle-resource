---
"drizzle-resource": minor
"@drizzle-resource/core": minor
"@drizzle-resource/zod": minor
"@drizzle-resource/valibot": minor
"@drizzle-resource/vine": minor
---

Add `capped` and `estimated` count modes, with `pagination.countCap` (10,000 by default) and typed `pageInfo` variants, so a page can show "10,000+" without reading every matching row. Offset pages read `hasNextPage` from a one-row lookahead whenever the count is not exact.

Add opt-in guards: `validation.maxPageIndex` (also enforced by the Zod, Valibot and Vine request schemas), `facets.whenCapped: "skip"` and per-stage `timeouts` for the count, facets and summary. A stage that times out degrades instead of failing the request. Every facet result now carries `status: "ok" | "skipped" | "timeout"`, and a summary carries `summaryStatus`.

Search without an exact count now runs the ordinary plan with a small time budget (`search.planBudget`, 25 ms) and retries with the trigram-indexed plan only when the budget runs out, instead of trusting PostgreSQL's cost estimate, which took a rare term through the whole sort index. Common terms run as before.

One change can need your attention: an exhaustive `switch (pageInfo.count)` must now handle `"capped"` and `"estimated"`. `scan` accepts any `QueryCountMode` and rejects `"capped"` and `"estimated"` at runtime; facets built by hand keep compiling because `status` is optional in the type.
