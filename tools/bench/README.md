# Scaling benchmark

The numbers behind the docs' Scale pages and the landing chart: `orders` with a `customers`
relation at 200,000, 1 million and 10 million rows, measured through the engine in three setups.

```bash
bun run benchmark:scale                      # all sizes; publishes tools/results/profiles.json if complete
bun run benchmark:scale -- --final           # same, and publishes it as final only if every run was quiet
BENCH_SIZES=50k bun run benchmark:scale      # a quick check; writes tools/results/scale-runs/profiles-50000.json
```

`bun run benchmark:postgres` is the older single-size harness (two engine versions, load, scans)
and still works. The two do not share results.

## What it needs

- Docker. Without `--url` or `TEST_DATABASE_URL` the command starts `postgres:18` as
  `drizzle-resource-bench` with `--cpus 4 --memory 4g`, `shared_buffers=1GB`, `work_mem=4MB`,
  `max_wal_size=1GB`, everything else default. It removes the container and its volume when it
  finishes, fails, or is stopped with Ctrl-C or `kill`.
  `--keep` leaves the container and the `scale_*` schemas in place and prints how to connect
  (`psql postgres://postgres:bench@127.0.0.1:5617/bench`) and how to remove it
  (`docker rm -f -v drizzle-resource-bench`).
  Give another database with `--url postgres://…` (it creates and drops `scale_<size>*` schemas in
  it); then that server's settings apply and are recorded in the result.
- Bun, and `bun install` at the repository root.
- Time: the 50,000-row check takes under a minute. The full run, three sizes, is about an hour
  (an estimate; the 10,000,000-row step is most of it).
- Disk: the four schemas of one size live side by side (they are measured in turn, see below). At
  10 million rows the out-of-the-box schema is 1.5 GB and the four together are about 8 GB (an
  estimate from the earlier harness), plus up to 1 GB of write-ahead log. Each size's schemas are dropped before the next size is built.
  Docker's own disk image may not shrink afterwards.

Close other work before a run you mean to publish. The command records the one-minute load average
before every scenario.

## What it measures

Per size, four schemas are built from the same data:

| Schema             | State                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| out of the box     | primary keys, `orders (createdAt, id)`, `orders (customerId)`, trigram indexes on `lower(orders.reference)` and `lower(customers.name)` |
| tuned              | out of the box plus every `fix.sql` that `engine.checkIndexes({ live: true })` gives for an error or a warning, then checked again      |
| tuned, name copied | the same, with `orders."customerName"` copied from the customer, and the indexes the check then asks for                                |
| scoped             | tuned, plus the index the check describes for a default sort under the `orgId = 42` scope: `(orgId, createdAt, id)`, applied by hand    |

The resource is the same everywhere: default sort `createdAt desc`, sorts on `createdAt` and
`customer.name` (the copied name on the copied schema), every column searchable, facets on
`status`, `paid`, `customer.segment` and `customer.name`. The sorts nobody uses are switched off
with `sort.disabled`, the way the check suggests, so it only asks for indexes the requests need.

What the check produced is recorded in `setup.tuning` of the result, for every size: the findings
before, the statements applied, the findings after, and `noErrorRemains`. A `--final` run refuses
when an error remains. At 200,000 rows and above the check asks for a trigram index on
`status` (the search is open to every column); for the sort through `customer.name` it only says
to copy the name onto `orders`, which is what the copied schema does; there the check asks for
`(customerName, id)` and a trigram index on the new column. Under the scope it names the problem
in words without SQL; `byHand` records the one statement that follows its advice, and the check no
longer reports it afterwards. A warning about the relation sort stays on the schema that still
sorts through the relation, which is the point of that setting.

The data: `customers` has 20,000 rows. `orders` has n rows with `customerId = (n % 20000) + 1`,
`orgId = (n % 100) + 1`, `status` by `n % 5`, `paid = n % 2 = 0`, `createdAt` spread evenly over
seven years ending 2026-11-01 (so it grows with `id`), `reference = 'ORD-' || lpad(n, 8, '0')`.
`orgId`, `status` and `paid` are all functions of `n`, so inside tenant 42 every order has status
`paid` and `paid = false`.

The requests whose names start with `landing/` are the ones the landing chart and the docs show:
page + count, sort by `customer.name` + count, searches (`ord`, `customer`, one reference, one
customer, `customer 1` on the relation) + count, two facets and four facets. Each is one engine
call, timed end to end. Out of the box asks for an exact count, tuned and scoped for a capped one.
`parts` holds what its page and count statements took, `stages` every statement kind, as the
engine's `onQuery` hook reported them. Every other request the harness knows is measured out of
the box only.

## Pairs and verdicts

A request is run against every setup that applies **in turn**: out of the box, then tuned, then
scoped, then out of the box again, the order rotating every round. Each ratio therefore compares
calls made seconds apart, so a busy minute hits both sides. The verdict is read from the
per-round ratios (out-of-the-box time / this time):

- `improved`: the ratio is above 1 in at least 80% of the rounds and its median is at least 1.15.
- `worse`: the ratio is below 1 in at least 80% of the rounds and its median is at most 1/1.15.
- `unchanged`: anything else, so a gain inside the noise is not claimed.

`ratio` is the median, `pairs` the rounds and `pairsFaster` how many were above 1. A `worse`
request is listed in `notes`; do not present it as an improvement. The four ways to run facets
(`<facets>/grouping-sets|separate/sequential|concurrent`) and the count statements
(`<scenario>:count-exact`, `:count-capped`) are measured on the tuned schema on their own, as
information, and carry no verdict. The tuned facets setting is fixed before measuring:
`facets.splitAbove: 0` on the pool.

All four schemas share the container's memory, so each call finds some of the others' pages
evicted. That holds for both sides of every pair.

## Methods, and what is still hand SQL

Every timed number is an engine call: pages and counts through `resource.queryIds` (the capped
counts with `count: "capped"`), facets through `resource.queryFacets`. Nothing published is hand
SQL. SQL is used to build the data, to apply the statements the check names, and to find the
cursor anchors.

Medians of 10 calls (the mean of the two middle values for an even count), 5 when the warm-up took
over a second, 3 over twenty. `maxMs` is the slowest sample: with ten samples a 95th percentile
would be the same number, so none is reported. A call that takes over 60 seconds, or that the
pool's 61-second `statement_timeout` cancels, is recorded as `skipped: "over-limit"`.

## Output and publishing

`tools/results/scale-runs/run-<size>-<time>.json` holds every run (git-ignored): the load average
sampled before each scenario (start, end, maximum), what `checkIndexes` did, and a fingerprint of
the engine commit, whether `packages/core` was modified, the harness (a version and a hash of its
sources) and the database. `assemble` uses runs of one fingerprint only: it takes the newest, says
how many others it left out, and publishes for each size the run taken under the lowest load. The
load is judged again at that moment from the stored numbers.

`tools/results/profiles.json` is written only when every default size (200k, 1m, 10m) has a run
and no cell was skipped. With `--final` the machine must also have been quiet: every chosen run's
maximum load at most 8, `packages/core` unmodified, and no `checkIndexes` error left. The
threshold is 8 and `BENCH_LOAD_THRESHOLD` cannot change it for `--final` (the command refuses).
Otherwise the file goes to `tools/results/scale-runs/profiles-<sizes>.json`, the reason is
printed, and `--final` exits with code 2.

- `provisional`: `false` only for a `--final` run that passed all of that.
- `setup.runs`: start, end and maximum load of each published run, and whether it was above the
  threshold. `setup.engineCommit` is the commit the runs were made with.
- `profiles.<profile>.<scenario>.<rows>`: `medianMs`, `maxMs`, `method`, `n`, and for landing
  requests `countMode`, `parts`, `verdict`, `ratio`, `pairs`, `pairsFaster`.

To rerun only part of it: `--sizes 1m` (writes next to the runs), or `run` and `assemble` as
separate steps (`bun tools/bench/scale.ts run …`, then `bun tools/bench/scale.ts assemble --final`),
which lets you repeat a noisy size and keep the quietest.

## From results to the docs and the landing

```bash
bun run benchmark:scale -- --final        # tools/results/profiles.json
bun tools/scale-bench-data.ts             # docs/app/data/bench-scale.json, the Scale pages
bun tools/scale-bench-data.ts --check     # fails when the committed file no longer matches
```

`tools/scale-bench-data.ts` refuses a `profiles.json` that has no `provisional` flag, and a
provisional file should not be published as final.
