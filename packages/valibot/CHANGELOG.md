# @drizzle-resource/valibot

## 1.2.0

### Minor Changes

- [#50](https://github.com/ChronicStone/drizzle-resource/pull/50) [`9c3bf97`](https://github.com/ChronicStone/drizzle-resource/commit/9c3bf97cfdca8f0ac3fac49e8ea25b00ec5a143d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add `capped` and `estimated` count modes, with `pagination.countCap` (10,000 by default) and typed `pageInfo` variants, so a page can show "10,000+" without reading every matching row. Offset pages read `hasNextPage` from a one-row lookahead whenever the count is not exact.

  Add opt-in guards: `validation.maxPageIndex` (also enforced by the Zod, Valibot and Vine request schemas), `facets.whenCapped: "skip"` and per-stage `timeouts` for the count, facets and summary. A stage that times out degrades instead of failing the request. Every facet result now carries `status: "ok" | "skipped" | "timeout"`, and a summary carries `summaryStatus`.

  Search without an exact count no longer trusts PostgreSQL's cost estimate, which took a rare term through the whole sort index. The count and the page each get bounded attempts: the ordinary plan under a time budget (`search.planBudget`, 25 ms by default), then the trigram-indexed plan under four times that budget, then the ordinary plan with no budget. A common term usually finishes in the first attempt. A term that matches nearly every row can miss the 25 ms budget and finish on a later attempt; raise `planBudget` if your ordinary search page takes longer than that. With a capped count, the count's result chooses where the page starts: a count under its cap starts it on the indexed plan, a count that hit the cap starts it on the ordinary plan. An `estimated` count over a search across tables falls back to `capped` and behaves the same way.

  Type changes to check in your code:

  - An exhaustive `switch (pageInfo.count)` must now handle `"capped"` and `"estimated"`.
  - A `QueryCountMode` value no longer fits a parameter typed `"none" | "exact"`.
  - `QueryFacetResult` gains an optional `status` and `reason`. Facets you write by hand keep compiling, and an absent `status` means `ok`. Use `QueryFacetOutcome` to narrow on `status`.
  - `scan` accepts any `QueryCountMode` and rejects `"capped"` and `"estimated"` at runtime.
  - `ResourceRuntimeQueryConfig` gains a required `timeouts` member. An object you build by hand and type as one needs it.

  Search budgets and `timeouts` apply only when the engine owns the connection. With `db: tx` (your own transaction) the engine sets no `statement_timeout` and picks the search plan as before, because statements that overlap on one connection would share the limit.

### Patch Changes

- Updated dependencies [[`55d2ff0`](https://github.com/ChronicStone/drizzle-resource/commit/55d2ff052a323dd0d1f5adfbaa24b15c9836ea31), [`9c3bf97`](https://github.com/ChronicStone/drizzle-resource/commit/9c3bf97cfdca8f0ac3fac49e8ea25b00ec5a143d), [`64d5218`](https://github.com/ChronicStone/drizzle-resource/commit/64d5218682747f55ccc9228e4e7423bd6e3add46), [`654d343`](https://github.com/ChronicStone/drizzle-resource/commit/654d3439d58273c0aa2c14e73c4f6b31a8da1be5), [`becec96`](https://github.com/ChronicStone/drizzle-resource/commit/becec96c8aa2ff2c1ea6256b9d64cccdd98a0bbf)]:
  - @drizzle-resource/core@1.3.0

## 1.1.1

### Patch Changes

- [#44](https://github.com/ChronicStone/drizzle-resource/pull/44) [`2062a7a`](https://github.com/ChronicStone/drizzle-resource/commit/2062a7af8ede024d46039eea28e20b2a6d3d7795) Thanks [@ChronicStone](https://github.com/ChronicStone)! - `requestSchema` from `drizzle-resource/zod` and `drizzle-resource/valibot` now returns a typed schema instead of `any`. Parsing gives a `QueryRequestSchemaOutput` (the request with every default filled in, without `context`), the same shape the Vine schema already returned.
- Updated dependencies [[`2062a7a`](https://github.com/ChronicStone/drizzle-resource/commit/2062a7af8ede024d46039eea28e20b2a6d3d7795), [`37357ed`](https://github.com/ChronicStone/drizzle-resource/commit/37357ed40499ba62adfe50a0fda2eedf14a487ea)]:
  - @drizzle-resource/core@1.2.1

## 1.1.0

### Minor Changes

- [#42](https://github.com/ChronicStone/drizzle-resource/pull/42) [`92be268`](https://github.com/ChronicStone/drizzle-resource/commit/92be268ec42988643cd2c091d8bc8b4b25391d6a) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add the `isEmpty` and `isNotEmpty` filter operators (null, `''` on text, empty arrays, or no related row on a relation path) and the facet `missing` count, requested with `missing: true`. A filter that tests a relation for emptiness reads every condition on that relation through `EXISTS`, so an `or` with a value keeps the rows without the relation.

  `isNot` now excludes every listed value instead of only the first, and on a to-many path reads « has none of the values » (`NOT EXISTS`) instead of « has one related row with another value ».

  To-one relations are now LEFT joined for sorting and selection: sorting on an optional linked field no longer hides the rows that have no linked row, and counts include them.

## 1.0.1

### Patch Changes

- [#39](https://github.com/ChronicStone/drizzle-resource/pull/39) [`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.
