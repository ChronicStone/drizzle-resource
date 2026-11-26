# Scaling benchmark

The numbers behind the docs' Scale pages and the landing chart: `orders` with a `customers`
relation at 200,000, 1 million and 10 million rows, measured through the engine in three setups.

```bash
bun run benchmark:scale                      # all sizes, writes tools/results/profiles.json
bun run benchmark:scale -- --final           # same, and marks the file final only if every run was quiet
BENCH_SIZES=50k bun run benchmark:scale      # a quick check; writes tools/results/scale-runs/profiles-50000.json
```

`bun run benchmark:postgres` is the older single-size harness (two engine versions, load, scans)
and still works. The two do not share results.

## What it needs

- Docker. Without `--url` or `TEST_DATABASE_URL` the command starts `postgres:18` as
  `drizzle-resource-bench` with `--cpus 4 --memory 4g`, `shared_buffers=1GB`, `work_mem=4MB`,
  `max_wal_size=1GB`, everything else default, and removes the container and its volume afterwards.
  Give another database with `--url postgres://…` (it creates and drops `scale_<size>` schemas in it);
  then the machine's own settings apply and are recorded in the result.
- Bun, and `bun install` at the repository root.
- Time: the 50,000-row check takes under a minute. The full run, three sizes, is about an hour
  (an estimate from the first harness; the 10,000,000-row step is most of it).
- Disk: the base schema is 1.5 GB at 10 million rows. The step peaks near 4.5 GB, because the
  denormalised copy of the orders is built next to it. Each size's schemas are dropped before the
  next size, so the total never adds up. Docker's own disk image may not shrink afterwards.

Close other work before a run you mean to publish. The command records the one-minute load average
before every scenario; a run whose load went above 8 (`BENCH_LOAD_THRESHOLD`) is flagged `highLoad`.

## What it measures

Per size, one schema is built and measured through three states, then a copy for one more:

| Profile              | Schema state                                                                                                                            | Requests                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `out-of-the-box`     | primary keys, `orders (createdAt, id)`, `orders (customerId)`, trigram indexes on `lower(orders.reference)` and `lower(customers.name)` | every scenario, count `exact`; facets with the engine's default `splitAbove`                                                |
| `tuned`              | plus `customers (name)` and `orders (createdAt desc, id asc)`                                                                           | the landing requests with count `capped`; the count statement alone, exact and capped; the four ways to run facets; cursors |
| `tuned-denormalized` | a copy with `orders.customerName` and index `(customerName, id)`                                                                        | the sort by customer name on the root column; merged into `tuned`                                                           |
| `scoped`             | tuned plus `orders (orgId, createdAt, id)`, resource scoped to `orgId = 42`                                                             | page + count (capped and exact), relation search, two facets, inside one tenant of 100                                      |

The data: `customers` has 20,000 rows. `orders` has n rows with `customerId = (n % 20000) + 1`,
`orgId = (n % 100) + 1`, `status` by `n % 5`, `paid = n % 2 = 0`, `createdAt` spread evenly over
seven years ending 2026-11-01 (so it grows with `id`), `reference = 'ORD-' || lpad(n, 8, '0')`.
`orgId`, `status` and `paid` are all functions of `n`, so inside tenant 42 every order has status
`paid` and `paid = false`: scoped facets return one value each.

The requests whose names start with `landing/` are the ones the landing chart and the docs show:
page + count, sort by `customer.name` + count, searches (`ord`, `customer`, one reference, one
customer, `customer 1` on the relation) + count, two facets and four facets. Each is one engine
call, timed end to end. `parts` holds what its page and count statements took, `stages` every
statement kind, as the engine's `onQuery` hook reported them.

## Methods, and what is still hand SQL

Every timed number is an engine call: pages and counts through `resource.queryIds` (the capped
counts with `count: "capped"`), facets through `resource.queryFacets` with `facets.splitAbove`
set to `Infinity` (one `GROUPING SETS` statement) or `0` (one statement per facet), in a
transaction (the statements follow each other on one connection) or on the pool (up to four at a
time). `<scenario>:count-exact` and `<scenario>:count-capped` are the count statement alone, read
from `onQuery`'s `count` stage.

Nothing published is hand SQL. SQL is used to build the data (schema, indexes, `ANALYZE`) and to
find the cursor anchors; the first harness timed the capped counts and the facet alternatives with
hand-written SQL, because the engine could not run them.

Medians of 10 calls, 5 when the warm-up took over a second, 3 over twenty; a request whose
warm-up takes over 60 seconds is recorded as skipped.

## Output

`tools/results/scale-runs/<profile>-<size>-<time>.json` holds every run with the load it was
taken under (git-ignored). `assemble` publishes, for each profile and size, the run taken under
the lowest load into `tools/results/profiles.json`:

- `provisional`: `false` only with `--final` when every published run was at or below the load
  threshold and every profile has a run at every size. Otherwise `true`, with the reason first in `notes`
  (the command then exits with code 2).
- `setup.runs`: the load at start, end and its maximum for each published run, and `highLoad`.
- `profiles.<profile>.<scenario>.<rows>`: `medianMs`, `p95Ms`, `method`, `n`, and for landing
  requests `countMode`, `parts`, `verdict` and `ratio`.
- `verdict` is `improved`, `unchanged` or `worse`, from `ratio` = out-of-the-box median / tuned (or
  scoped) median: improved above 1.1, worse below 0.9, unchanged between or when the gap is under
  0.3 ms. A `worse` request is listed in `notes`; do not present it as an improvement.
- Facet landing values are the fastest of the four ways, with `uses`, `setting` and `all`.

To rerun only part of it: `--sizes 1m`, `--profiles tuned,scoped` (a later profile needs the
earlier schema state, so the schema is rebuilt each time), or `run` and `assemble` as separate steps
(`bun tools/bench/scale.ts run …`, then `bun tools/bench/scale.ts assemble --final`), which lets
you repeat a noisy run and keep the quietest.

## From results to the docs and the landing

```bash
bun run benchmark:scale -- --final        # tools/results/profiles.json
bun tools/scale-bench-data.ts             # docs/app/data/bench-scale.json, the Scale pages
bun tools/scale-bench-data.ts --check     # fails when the committed file no longer matches
```

`tools/scale-bench-data.ts` refuses a `profiles.json` that has no `provisional` flag, and a
provisional file should not be published as final.
