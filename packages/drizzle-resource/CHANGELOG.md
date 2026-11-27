# drizzle-resource

## 2.8.0

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

## 2.7.1

### Patch Changes

- [#44](https://github.com/ChronicStone/drizzle-resource/pull/44) [`2062a7a`](https://github.com/ChronicStone/drizzle-resource/commit/2062a7af8ede024d46039eea28e20b2a6d3d7795) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Support drizzle-orm `1.0.0-rc.5`. Row, view and model field types were read from the return type of `db.query[table].findMany`, which resolves to `unknown` fields with rc.5. They now come from the table's `$inferSelect`. The minimum drizzle-orm version is `1.0.0-rc.5`.

- [#46](https://github.com/ChronicStone/drizzle-resource/pull/46) [`37357ed`](https://github.com/ChronicStone/drizzle-resource/commit/37357ed40499ba62adfe50a0fda2eedf14a487ea) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Reduce PostgreSQL work for cursor pages, multi-value filters, searches across fields on the same relation, and exact counts for bounded unique-key selections. Large unfiltered reports can count repeated foreign keys before joining related facets.

- [#44](https://github.com/ChronicStone/drizzle-resource/pull/44) [`2062a7a`](https://github.com/ChronicStone/drizzle-resource/commit/2062a7af8ede024d46039eea28e20b2a6d3d7795) Thanks [@ChronicStone](https://github.com/ChronicStone)! - `requestSchema` from `drizzle-resource/zod` and `drizzle-resource/valibot` now returns a typed schema instead of `any`. Parsing gives a `QueryRequestSchemaOutput` (the request with every default filled in, without `context`), the same shape the Vine schema already returned.

## 2.7.0

### Minor Changes

- [#42](https://github.com/ChronicStone/drizzle-resource/pull/42) [`92be268`](https://github.com/ChronicStone/drizzle-resource/commit/92be268ec42988643cd2c091d8bc8b4b25391d6a) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add the `isEmpty` and `isNotEmpty` filter operators (null, `''` on text, empty arrays, or no related row on a relation path) and the facet `missing` count, requested with `missing: true`. A filter that tests a relation for emptiness reads every condition on that relation through `EXISTS`, so an `or` with a value keeps the rows without the relation.

  `isNot` now excludes every listed value instead of only the first, and on a to-many path reads « has none of the values » (`NOT EXISTS`) instead of « has one related row with another value ».

  To-one relations are now LEFT joined for sorting and selection: sorting on an optional linked field no longer hides the rows that have no linked row, and counts include them.

## 2.6.3

### Patch Changes

- [#39](https://github.com/ChronicStone/drizzle-resource/pull/39) [`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.

## 2.6.2

### Patch Changes

- [#37](https://github.com/ChronicStone/drizzle-resource/pull/37) [`2463231`](https://github.com/ChronicStone/drizzle-resource/commit/246323199752ceb3e4feaf5b5dc9d8a04d29a881) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Normalize omitted pagination, sorting, filters, and search fields at the query engine boundary so valid sparse transport requests do not fail during list or summary queries.

## 2.6.1

### Patch Changes

- [#35](https://github.com/ChronicStone/drizzle-resource/pull/35) [`7ad770a`](https://github.com/ChronicStone/drizzle-resource/commit/7ad770aa1527c943f97d78435ff656ce68018f00) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Export the typed resource returned by `defineResource` so applications can type shared resource helpers with views, model policies, and summaries.

## 2.6.0

### Minor Changes

- [#33](https://github.com/ChronicStone/drizzle-resource/pull/33) [`9a36c61`](https://github.com/ChronicStone/drizzle-resource/commit/9a36c612279e0a561a096cf3a4094a89ee75ba50) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add engine model definitions for private, hidden, and SQL virtual fields, exact typed resource views, and typed summaries over the complete scoped and filtered dataset. Summaries execute in one SQL statement and share their count with exact pagination. Virtual callbacks infer their owning table and database. Zod and Valibot response schemas support views and automatically derive validators for standard Drizzle aggregates.

## 2.5.1

### Patch Changes

- [#31](https://github.com/ChronicStone/drizzle-resource/pull/31) [`930c369`](https://github.com/ChronicStone/drizzle-resource/commit/930c369b977a633779ec5214413f96d7600ef96c) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Preserve root matches when free-text search includes optional relation fields. Relation search predicates now use correlated existence checks, so missing relations cannot remove matches from other fields.

## 2.5.0

### Minor Changes

- [#29](https://github.com/ChronicStone/drizzle-resource/pull/29) [`ab04689`](https://github.com/ChronicStone/drizzle-resource/commit/ab046896f18d333a840cf357ab70dc3bd468cd15) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Reduce PostgreSQL CPU and temporary-memory work with schema-proven direct ID paging, distinct-free counts where safe, and compatible facet aggregation through GROUPING SETS. Aggregate facets without a matching-ID self-join and avoid retaining unbounded request-plan caches. Preserve access-scope filters when resolving exclude-self facets, retain distinct counting for multiplying joins, and return facet results in request order. Add real PostgreSQL regression coverage and a reproducible 200,000-row comparison harness.

  Add `resource.scan(options, consume)` for bounded bulk reads with inferred hydration profiles, backpressure, cancellation, and automatic cleanup. PostgreSQL executes the selection once using a forward-only server cursor inside a repeatable-read snapshot; portable and custom-strategy resources retain bounded pagination. Trusted batch sizes do not change public request limits.

  Keep sorting-only relation membership out of aggregate joins, share compatible exact counts with facet aggregates, and probe PostgreSQL trigram indexes before optimizing cross-table substring searches. Compare native PostgreSQL plan costs before selecting an indexed union, preserving the ordinary search plan for broad matches where it is estimated cheaper. Preserve search semantics and fall back when compatible capabilities are absent.

## 2.4.1

### Patch Changes

- [#27](https://github.com/ChronicStone/drizzle-resource/pull/27) [`8cab0f5`](https://github.com/ChronicStone/drizzle-resource/commit/8cab0f573bcf1ce81c9a574c8ddeb3b324146610) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Keep offset-paginated results deterministic by appending the root ID as a stable sorting tiebreaker.

## 2.4.0

### Minor Changes

- [`771610c`](https://github.com/ChronicStone/drizzle-resource/commit/771610c9c992623fd2a0b413746067a57127e3b2) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Allow trusted server-side resource executions to raise the page-size limit without widening the public transport contract.

### Patch Changes

- [`3327018`](https://github.com/ChronicStone/drizzle-resource/commit/3327018398852f53b3af97d51372176a570c226a) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Infer hydrated result rows structurally so relation profiles remain typed when applications and linked packages resolve separate Drizzle installations.

## 2.3.0

### Minor Changes

- [#24](https://github.com/ChronicStone/drizzle-resource/pull/24) [`2227bff`](https://github.com/ChronicStone/drizzle-resource/commit/2227bffa40cc83f1a3d350dd2b235a2febc3ed21) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add typed hydration profiles with per-operation defaults, inferred row shapes, inline overrides, strategy propagation, and profile-aware Zod and Valibot response schemas.

## 2.2.0

### Minor Changes

- [#22](https://github.com/ChronicStone/drizzle-resource/pull/22) [`cf740ea`](https://github.com/ChronicStone/drizzle-resource/commit/cf740eacc1379e69d53f76e6a1dfab7d443e272e) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add `resource.findById(...)` for scoped, relation-complete single-record lookups without constructing a paginated collection request.

## 2.1.1

### Patch Changes

- [#20](https://github.com/ChronicStone/drizzle-resource/pull/20) [`a765860`](https://github.com/ChronicStone/drizzle-resource/commit/a76586057b1e7ce72ebbe8452879f1da11942cb8) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Avoid joining configured relation search fields when the search value is empty, preserving rows whose optional relations are not loaded.

## 2.1.0

### Minor Changes

- [#18](https://github.com/ChronicStone/drizzle-resource/pull/18) [`530ba08`](https://github.com/ChronicStone/drizzle-resource/commit/530ba0868cdfd0a008b4e8d9ac1d242cda94dcc9) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add VineJS request schemas, per-query database overrides, and case-sensitive filter configuration.

### Patch Changes

- [#18](https://github.com/ChronicStone/drizzle-resource/pull/18) [`530ba08`](https://github.com/ChronicStone/drizzle-resource/commit/530ba0868cdfd0a008b4e8d9ac1d242cda94dcc9) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix Drizzle RC5 relation columns, numeric HTTP query inputs, and deterministic cursor pagination for duplicate sort values.

- [#18](https://github.com/ChronicStone/drizzle-resource/pull/18) [`530ba08`](https://github.com/ChronicStone/drizzle-resource/commit/530ba0868cdfd0a008b4e8d9ac1d242cda94dcc9) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Allow trusted resource scopes to filter on fields hidden from public query contracts.

## 2.0.0

### Major Changes

- [#14](https://github.com/ChronicStone/drizzle-resource/pull/14) [`2cbe73b`](https://github.com/ChronicStone/drizzle-resource/commit/2cbe73b89c3e9068c6caea2c3ff1f576f44ec8fa) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add built-in cursor pagination with stable keyset ordering and optional exact counts. Pagination requests now use explicit offset or cursor modes, query responses expose mode-specific `pageInfo`, and the Zod and Valibot schemas validate the same discriminated contract.

## 1.1.1

### Patch Changes

- [`17b5e36`](https://github.com/ChronicStone/drizzle-resource/commit/17b5e366a97c11bd40d3b1ffc7b48c4c4c8bbad2) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Preserve typed Zod and Valibot response-schema overrides, including nested relation transforms, in the generated declaration files.

## 1.1.0

### Minor Changes

- [#11](https://github.com/ChronicStone/drizzle-resource/pull/11) [`c4e5476`](https://github.com/ChronicStone/drizzle-resource/commit/c4e5476521e4b28a064191c1127258cb552ff213) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add resource-derived Zod and Valibot request and response schemas, including relation-aware response validation and defensive request limits.

## 1.0.3

### Patch Changes

- [#8](https://github.com/ChronicStone/drizzle-resource/pull/8) [`b8e55ce`](https://github.com/ChronicStone/drizzle-resource/commit/b8e55ce1eee2c9d37252eceab5366f2042040654) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Upgrade dependencies, including Drizzle ORM 1.0.0-rc.4.

## 1.0.2

### Patch Changes

- [#6](https://github.com/ChronicStone/drizzle-resource/pull/6) [`ad80fe4`](https://github.com/ChronicStone/drizzle-resource/commit/ad80fe4d5e392b6f03240b38e80669210b11a0d5) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix SQLite compatibility in aggregate queries and improve the docs playground with a pre-seeded database, default facet showcase, and faster nested OR demos.

## 1.0.1

### Patch Changes

- [#1](https://github.com/ChronicStone/drizzle-resource/pull/1) [`ef1ae28`](https://github.com/ChronicStone/drizzle-resource/commit/ef1ae28d4fca6d4e4ad45290f6e436fc99bd82f1) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Simplify the filtering request API so top-level filters are passed as an array instead of requiring a root group wrapper, and update the docs/examples to match.
