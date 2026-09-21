# drizzle-resource

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
