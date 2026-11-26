# RFC: performance tools for drizzle-resource

Status: DX approved by the maintainer on 2026-11-26. Decisions: capped counts are opt-in (offset pages keep `exact` as their default, cursor pages keep `none`); the home chart becomes a scaling chart that animates from "out of the box" to "tuned".

## Why

Measured on the repo's harness (PostgreSQL 18, 4 CPUs, single client unless noted):

- Pages and cursors stay flat from 200k to 10M rows (0.3 ms). Counts, facets and summaries grow with the matching rows: exact count 5.5 ms -> 72 ms, 3 facets 26 ms -> 1.34 s, common-word search + count 0.2 s -> 6.7 s.
- Under 32 callers at 10M: page without count 5,577 req/s, page + exact count 8.4 req/s (3.3 s median).
- A count capped at 10,001 rows takes 1.3-1.6 ms where the exact count takes 90-209 ms on broad filters.
- Offset page 200,000 takes 167 ms; a cursor at the same depth 0.7 ms.
- A rare-term search without a count takes 515 ms (with a count: 5 ms): PostgreSQL estimates 5M matches for 500 real ones and walks the sort index.
- Facets sharing one GROUPING SETS statement run on one CPU (1.4 s of 1.7 s at 10M); a single-column facet statement runs in parallel (0.37 s).
- PostgreSQL's row estimate was 50x too low for a filter through a relation.

Raw results: /tmp/drizzle-bench-10m/results/ (single-200k.json, single-1m.json, single-10m.json, load-10m-c32.json, count-hand.json, explain-10m.txt).

## The workflow: see -> explain -> fix -> guard

Every tool returns plain data (usable in tests, logs and CI) and has a `format...()` helper for the console. All tools share one key, the request **shape**: resource, filter keys, sort keys with directions, search fields, facet keys, pagination mode and count mode, never values. Example: `orders · filter status,createdAt · sort createdAt desc · search customer.name · count exact`. Expose it as `shape` (string) and as a structured `shapeKey` object if useful.

### 1. See: `onQuery` on the engine

```ts
const engine = createQueryEngine({
  db,
  schema,
  relations,
  onQuery: (event) => {
    if (event.ms > 200) log.warn(`${event.resource} ${event.stage} ${event.ms}ms`, event.shape);
  },
});

type QueryEvent = {
  resource: string;
  stage: "ids" | "count" | "rows" | "facets" | "summary" | "plan" | "scan";
  shape: string;
  ms: number;
  rows: number; // rows returned by the statement
  sql: string; // with $1 placeholders; parameter values are never included
  error?: unknown;
};
```

Every statement the engine runs (including the EXPLAIN it runs to pick search plans: stage "plan") emits one event. The hook must never change results or throw into the request (catch and ignore hook errors).

### 2. Explain: `resource.explain()`

```ts
const report = await orders.explain({ request, context }); // EXPLAIN only, runs nothing
const report = await orders.explain({ request, context, analyze: true }); // EXPLAIN ANALYZE, real timings
console.log(formatExplain(report));
```

```
orders · filter status · sort createdAt desc · count exact
  ids     0.4 ms   index orders_created_at_idx, 51 rows read
  count   812 ms   reads 9,412,330 rows to return one number
                   fix: count "capped" shows "10,000+" in 1-2 ms
  facets  1.70 s   3 facets share one GROUPING SETS statement on 1 CPU
```

Report: `{ resource, shape, stages: [{ stage, sql, ms?, rowsRead?, rowsReturned?, plan, warnings: [{ code, message, fix? }] }] }`. First warning codes: `full-count`, `index-walk`, `seq-scan`, `deep-offset`, `misestimate`, `relation-sort`, `single-cpu-facets`. Messages are plain words with numbers from the plan.

### 3. Fix: `engine.checkIndexes()`

```ts
engine.checkIndexes(); // static: Drizzle schema + resource definitions, no database
await engine.checkIndexes({ live: true }); // also reads pg_index (btree and pg_trgm indexes)

test("sorts and scopes are indexed", () => {
  expect(engine.checkIndexes().filter((f) => f.level === "error")).toEqual([]);
});
```

```
error  orders  default sort createdAt desc, id desc under scope orgId has no index
               index("orders_org_created").on(t.orgId, t.createdAt.desc(), t.id.desc())
warn   orders  sort year desc, month desc, id asc mixes directions: no index serves it
warn   orders  sort customer.name joins every order first: disable it or copy name onto orders
warn   orders  scope customer.orgId goes through a join: put orgId on orders
info   orders  search.allowed not set: all 14 fields are searchable, numbers included
```

Finding: `{ resource, level: "error" | "warn" | "info", rule, message, fields, fix?: { drizzle: string; sql: string } }`. Rules to start with: `default-sort-unindexed` (error), `sort-unindexed`, `mixed-direction-sort`, `relation-sort`, `scope-through-relation`, `search-unindexed` (live only), `many-to-many-facet` (warn), `search-numbers`, `open-surface`, `exact-count-large-table` (live only, from pg_class.reltuples) (info). Strategies and virtual fields stay the escape hatches.

### 4. Guard: limits in the resource definition (all opt-in)

```ts
defineResource("orders", {
  query: {
    pagination: { modes: ["offset", "cursor"], countCap: 10_000 },
    defaults: { pagination: { count: "capped" } },
    validation: { maxPageIndex: 400 },
    facets: { allowed: [...], whenCapped: "skip" },
    timeouts: { count: 500, facets: 2_000, summary: 2_000 }, // ms
  },
});
```

```ts
pageInfo: { count: "capped", rowCount: 10_000, exact: false }  // UI shows "10,000+"
pageInfo: { count: "capped", rowCount: 412, exact: true }
pageInfo: { count: "estimated", rowCount: 8_549_540 }          // "about 8.5M"
facet:    { key: "status", status: "skipped", reason: "above-cap", options: [] }
facet:    { key: "status", status: "timeout", options: [] }
```

- `QueryCountMode` becomes `"none" | "exact" | "capped" | "estimated"`. Clients may request `capped`; the cap itself is resource-level (default 10,000), never client-controlled.
- Capped SQL: `select count(*) from (select 1 from ... where ... limit cap + 1) t`.
- `estimated` uses the planner's row estimate and falls back to `capped` when filters or search go through relations (the estimate was 50x off there); `pageInfo.count` reports what was actually used.
- `pageInfo.count` keeps narrowing `rowCount` (and `exact`) in TypeScript.
- Offset pages: `hasNextPage` from the exact count when the capped count is exact, otherwise from a one-row lookahead.
- `facets.whenCapped: "skip"`: when the request's count is capped and the cap is hit, facets are not computed and come back with `status: "skipped"`. Facets gain `status: "ok" | "skipped" | "timeout"` (always present).
- `validation.maxPageIndex`: default unlimited; enforced like `maxCursorLength`, including in the zod, valibot and vine request schemas.
- `timeouts`: per stage, applied with `SET LOCAL statement_timeout` inside a transaction only when configured. A timed-out stage degrades instead of failing the request: count -> no count (state it in pageInfo), facets -> `status: "timeout"`, summary -> a documented empty state. Design the exact types as discriminated unions that don't break existing fields.

### Engine fixes, no API change

- Search without a count: choose between the ordinary and the indexed search plan from a capped count of indexed matches (a 1-2 ms probe), not from PostgreSQL's cost estimate. Target at 10M: 515 ms -> about 5 ms, with no regression on common terms (`wide-search-account-none` stays about 7 ms).
- Facets on big tables: compare separate (parallel-capable) statements against one GROUPING SETS statement, and pick per table size. Measure before changing.

## Build order (one PR each)

1. Count modes, guards (countCap, maxPageIndex, whenCapped, timeouts) and the search-plan fix.
2. `checkIndexes`.
3. `onQuery` and `explain`.
4. Facets: parallel statements vs GROUPING SETS.
5. Benchmark harness for several sizes and profiles; results committed to `tools/results/`.
6. Docs Scale section and the home chart, reading numbers from `tools/results/*.json`.
