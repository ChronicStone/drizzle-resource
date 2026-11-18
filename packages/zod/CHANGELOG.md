# @drizzle-resource/zod

## 1.1.0

### Minor Changes

- [#42](https://github.com/ChronicStone/drizzle-resource/pull/42) [`92be268`](https://github.com/ChronicStone/drizzle-resource/commit/92be268ec42988643cd2c091d8bc8b4b25391d6a) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Add the `isEmpty` and `isNotEmpty` filter operators (null, `''` on text, empty arrays, or no related row on a relation path) and the facet `missing` count, requested with `missing: true`. A filter that tests a relation for emptiness reads every condition on that relation through `EXISTS`, so an `or` with a value keeps the rows without the relation.

  `isNot` now excludes every listed value instead of only the first, and on a to-many path reads « has none of the values » (`NOT EXISTS`) instead of « has one related row with another value ».

  To-one relations are now LEFT joined for sorting and selection: sorting on an optional linked field no longer hides the rows that have no linked row, and counts include them.

## 1.0.1

### Patch Changes

- [#39](https://github.com/ChronicStone/drizzle-resource/pull/39) [`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.
