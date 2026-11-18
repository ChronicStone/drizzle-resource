# @drizzle-resource/core

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
