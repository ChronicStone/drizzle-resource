# @drizzle-resource/core

## 1.3.0

### Minor Changes

- [#50](https://github.com/ChronicStone/drizzle-resource/pull/50) [`55d2ff0`](https://github.com/ChronicStone/drizzle-resource/commit/55d2ff052a323dd0d1f5adfbaa24b15c9836ea31) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add `engine.checkIndexes()` and `resource.checkIndexes()`. They compare each resource's default sort, sortable columns, scope, search and facets with the indexes of its tables, and return findings with the Drizzle index and the SQL that fix them. `checkIndexes({ live: true })` reads the real btree and `pg_trgm` indexes and table sizes from PostgreSQL instead of the Drizzle schema. `formatIndexFindings(findings)` prints them for the console.

  `QueryEngine` and `QueryResource` gain a `checkIndexes` member, so a mock you build by hand and type as one of them needs it.

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

- [#50](https://github.com/ChronicStone/drizzle-resource/pull/50) [`654d343`](https://github.com/ChronicStone/drizzle-resource/commit/654d3439d58273c0aa2c14e73c4f6b31a8da1be5) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Run facets as separate statements on big tables. PostgreSQL cannot use parallel workers for a `GROUPING SETS` statement, so facets that shared one ran on a single CPU. Above `query.facets.splitAbove` estimated rows (default 100,000) each facet now gets its own statement, at most four at a time, and the exact count of a page is a statement of its own instead of riding in the shared one. Results, ordering, cursors, `missing` and `status` are unchanged; a timed-out facet no longer takes the facets that shared its statement with it, and a split exact count runs under `timeouts.count`.

  The estimate is the root table's `pg_class.reltuples`, read once per database object and reused for five minutes. A request that filters or searches on root columns is judged by the planner's estimate of the rows it matches, so a narrow request keeps one shared statement. `splitAbove: 0` always splits and `Infinity` never does. The row estimate is reported to `onQuery` as a `plan` statement; `explain()` still reports `single-cpu-facets` for a shared statement that reads many rows, now with `splitAbove` as its fix.

- [#50](https://github.com/ChronicStone/drizzle-resource/pull/50) [`becec96`](https://github.com/ChronicStone/drizzle-resource/commit/becec96c8aa2ff2c1ea6256b9d64cccdd98a0bbf) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add `onQuery` to `createQueryEngine`: one event per statement the engine runs, with its stage (`ids`, `count`, `rows`, `facets`, `summary`, `plan`, `scan`), a value-free request shape, its duration, the rows it returned and its SQL with placeholders. A hook that throws never reaches the request, and an engine without a hook pays one boolean check per statement.

  Add `resource.explain({ request, context, analyze })` and `formatExplain(report)`. It runs `EXPLAIN` (or `EXPLAIN ANALYZE, BUFFERS` in a transaction that is rolled back) on the exact statements `query` would run, and reports `full-count`, `index-walk`, `seq-scan`, `deep-offset`, `misestimate`, `relation-sort` and `single-cpu-facets` in plain words, with the numbers from the plan and a fix. PostgreSQL only. `QueryResource` gains the `explain` member, so a mock you build by hand and type as one needs it.

### Patch Changes

- [#50](https://github.com/ChronicStone/drizzle-resource/pull/50) [`64d5218`](https://github.com/ChronicStone/drizzle-resource/commit/64d5218682747f55ccc9228e4e7423bd6e3add46) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix wrong counts in the shared `GROUPING SETS` facet statement: a root-column facet that shared a statement with a relation facet lost the rows whose relation is empty, because the statement inner-joined the relation. Facets now share a statement only when they read the same relations, and the exact count only rides in a statement with no inner-joined relation.

## 1.2.1

### Patch Changes

- [#44](https://github.com/ChronicStone/drizzle-resource/pull/44) [`2062a7a`](https://github.com/ChronicStone/drizzle-resource/commit/2062a7af8ede024d46039eea28e20b2a6d3d7795) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Support drizzle-orm `1.0.0-rc.5`. Row, view and model field types were read from the return type of `db.query[table].findMany`, which resolves to `unknown` fields with rc.5. They now come from the table's `$inferSelect`. The minimum drizzle-orm version is `1.0.0-rc.5`.

- [#46](https://github.com/ChronicStone/drizzle-resource/pull/46) [`37357ed`](https://github.com/ChronicStone/drizzle-resource/commit/37357ed40499ba62adfe50a0fda2eedf14a487ea) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Reduce PostgreSQL work for cursor pages, multi-value filters, searches across fields on the same relation, and exact counts for bounded unique-key selections. Large unfiltered reports can count repeated foreign keys before joining related facets.

## 1.2.0

### Minor Changes

- [#42](https://github.com/ChronicStone/drizzle-resource/pull/42) [`92be268`](https://github.com/ChronicStone/drizzle-resource/commit/92be268ec42988643cd2c091d8bc8b4b25391d6a) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add the `isEmpty` and `isNotEmpty` filter operators (null, `''` on text, empty arrays, or no related row on a relation path) and the facet `missing` count, requested with `missing: true`. A filter that tests a relation for emptiness reads every condition on that relation through `EXISTS`, so an `or` with a value keeps the rows without the relation.

  `isNot` now excludes every listed value instead of only the first, and on a to-many path reads « has none of the values » (`NOT EXISTS`) instead of « has one related row with another value ».

  To-one relations are now LEFT joined for sorting and selection: sorting on an optional linked field no longer hides the rows that have no linked row, and counts include them.

## 1.1.3

### Patch Changes

- [#39](https://github.com/ChronicStone/drizzle-resource/pull/39) [`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.

## 1.1.2

### Patch Changes

- [#37](https://github.com/ChronicStone/drizzle-resource/pull/37) [`2463231`](https://github.com/ChronicStone/drizzle-resource/commit/246323199752ceb3e4feaf5b5dc9d8a04d29a881) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Normalize omitted pagination, sorting, filters, and search fields at the query engine boundary so valid sparse transport requests do not fail during list or summary queries.

## 1.1.1

### Patch Changes

- [#35](https://github.com/ChronicStone/drizzle-resource/pull/35) [`7ad770a`](https://github.com/ChronicStone/drizzle-resource/commit/7ad770aa1527c943f97d78435ff656ce68018f00) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Export the typed resource returned by `defineResource` so applications can type shared resource helpers with views, model policies, and summaries.

## 1.1.0

### Minor Changes

- [`771610c`](https://github.com/ChronicStone/drizzle-resource/commit/771610c9c992623fd2a0b413746067a57127e3b2) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Allow trusted server-side resource executions to raise the page-size limit without widening the public transport contract.

## 1.0.1

### Patch Changes

- [#6](https://github.com/ChronicStone/drizzle-resource/pull/6) [`ad80fe4`](https://github.com/ChronicStone/drizzle-resource/commit/ad80fe4d5e392b6f03240b38e80669210b11a0d5) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix SQLite compatibility in aggregate queries and improve the docs playground with a pre-seeded database, default facet showcase, and faster nested OR demos.
