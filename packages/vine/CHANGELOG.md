# @drizzle-resource/vine

## 1.0.4

### Patch Changes

- [#39](https://github.com/ChronicStone/drizzle-resource/pull/39) [`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d) Thanks [@ChronicStone](https://github.com/ChronicStone)! - Fix facets on virtual fields, which failed with a Drizzle alias error, or a PostgreSQL `GROUP BY` error when the virtual's SQL carried parameters. The Vine, Zod and Valibot request schemas now refuse filter values outside a PostgreSQL enum column's values, directly or through a relation path, so the request fails validation instead of reaching PostgreSQL as an invalid enum input.

- Updated dependencies [[`f0b0539`](https://github.com/ChronicStone/drizzle-resource/commit/f0b05396f88dcf5be4cdb2f0e44385a7c5bef62d)]:
  - @drizzle-resource/core@1.1.3

## 1.0.3

### Patch Changes

- Updated dependencies [[`2463231`](https://github.com/ChronicStone/drizzle-resource/commit/246323199752ceb3e4feaf5b5dc9d8a04d29a881)]:
  - @drizzle-resource/core@1.1.2

## 1.0.2

### Patch Changes

- Updated dependencies [[`7ad770a`](https://github.com/ChronicStone/drizzle-resource/commit/7ad770aa1527c943f97d78435ff656ce68018f00)]:
  - @drizzle-resource/core@1.1.1

## 1.0.1

### Patch Changes

- Updated dependencies [[`771610c`](https://github.com/ChronicStone/drizzle-resource/commit/771610c9c992623fd2a0b413746067a57127e3b2)]:
  - @drizzle-resource/core@1.1.0
