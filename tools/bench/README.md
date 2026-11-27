# Scaling benchmark

The numbers behind the docs' Scale pages and the landing chart: `orders` with a `customers`
relation at 200,000, 1 million and 10 million rows, measured through the engine in three setups.

```bash
bun run benchmark:scale                      # all sizes; publishes tools/results/profiles.json if complete
bun run benchmark:scale -- --final           # same, and publishes it as final only if the run was sound and quiet
BENCH_SIZES=50k bun run benchmark:scale      # a quick check; writes tools/results/scale-runs/profiles-50000.json
```

`bun run benchmark:postgres` is the older single-size harness (two engine versions, load, scans)
and still works. The two do not share results.

## What it needs

- Docker. Without `--url` or `TEST_DATABASE_URL` the command starts `postgres:18` as
  `drizzle-resource-bench-<random>` with `--cpus 4 --memory 4g`, `shared_buffers=1GB`,
  `work_mem=4MB`, `max_wal_size=1GB`, everything else default. The name is unique, so a second run
  never touches the first, and Docker picks a free port. The container and its volume are removed
  when the command finishes, fails, or is stopped with Ctrl-C, `kill` or a closed terminal
  (SIGINT, SIGTERM, SIGHUP). `--keep` leaves the container and the `scale_*` schemas in place and
  prints how to connect (`psql postgres://postgres:bench@127.0.0.1:<port>/bench`) and how to remove
  them (`docker rm -f -v <name>`).
- Another database: `--url postgres://…`. It creates and drops `scale_<size>*` schemas in it, also
  when interrupted. That server's settings apply and are recorded in the result; say what it has
  with `BENCH_DB_CPUS` and `BENCH_DB_MEMORY` (for example `4` and `4g`): `--final` refuses a result
  whose database it cannot describe.
- Bun, and `bun install` at the repository root.
- Time: the 50,000-row check takes under a minute. The full run, three sizes, takes a couple of
  hours (an estimate: every pair is at least 10 rounds with an untimed call before each timed one,
  and the 10,000,000-row step is most of it).
- Disk: two schemas are resident at a time, the out-of-the-box one and the one it is being compared
  with (see below). At 10 million rows the out-of-the-box schema is 1.5 GB and the largest other one
  about 2.2 GB, plus up to 1 GB of write-ahead log. Each schema is dropped as soon as its comparison
  is done. Docker's own disk image may not shrink afterwards.

Close other work before a run you mean to publish. The command records the one-minute load average
before every scenario.

## What it measures

Per size, the out-of-the-box schema is built once. Each of three more is built next to it,
measured against it, and dropped:

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

### What "tuned" is, and what it is not

`setup.tuning.changes` in the result lists every change, with the tool that asked for it, the
finding it answers, the SQL, and whether any timed request touches it:

- **A trigram index on `lower(status)`.** The one index `checkIndexes` asks for on the unchanged
  schema, because search is open to every column. No landing request searches `status`, so it
  changes no timed request. It is listed so nobody credits the tool with a gain it did not make.
- **The copied name** (`orders."customerName"`, with `(customerName, id)` and a trigram index on
  the new column). `checkIndexes` warns that a sort through `customer.name` joins every order
  first and says to copy the name onto `orders`; it gives no SQL for that, so the harness makes the
  copy while building the schema, and then the check's own `fix.sql` asks for the indexes.
- **`count: "capped"`.** Not an index: an engine option. `checkIndexes` reports
  `exact-count-large-table` from 1,000,000 rows. Most of the gain on every request with a count is this.
- **`facets.splitAbove: 0`.** An engine option from the facets guide; `checkIndexes` has no
  finding for it. Out of the box already runs the engine's default, `splitAbove` 100,000.
- **For the scoped setting only:** the check describes the missing `(orgId, …)` index in words and
  gives no SQL, so the harness applies it by hand (`byHand` in `setup.tuning`), and the check no
  longer reports it afterwards.

What the check produced is recorded per size in `setup.tuning.runs`: the findings before, the
statements applied, the findings after, and `noErrorRemains`. A `--final` run refuses when an error
remains. A `relation-sort` warning stays on the schema that still sorts through the relation, which
is the point of the copied-name setting.

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

A request is run against the setups it is compared with **in turn**: one call of each per round, at
least 10 rounds whatever the weight of the request (12 when three setups are compared), in a
carryover-balanced order (a Williams design: every setup follows every other setup equally often,
which a plain rotation does not give). Each ratio therefore compares calls made seconds apart, so a
busy minute hits both sides. Every timed call is preceded by an untimed call of the same request,
so it finds its own pages in memory whatever the other setup's calls have evicted since. The
verdict is read from the per-round ratios (out-of-the-box time / this time):

- `improved`: the ratio is above 1 in at least 80% of the rounds and its median is at least 1.15.
- `worse`: the ratio is below 1 in at least 80% of the rounds and its median is at most 1/1.15.
- `unchanged`: anything else, so a gain inside the noise is not claimed.

`ratio` is the median, `pairs` the rounds and `pairsFaster` how many were above 1. A `worse`
request is listed in `notes`; do not present it as an improvement. Each pair has its own
out-of-the-box calls and its ratios are against those; the out-of-the-box time published for a
request is the first pair's. The four ways to run facets
(`<facets>/grouping-sets|separate/sequential|concurrent`) and the count statements
(`<scenario>:count-exact`, `:count-capped`) are measured on the tuned schema on their own, as
information, and carry no verdict. The tuned facets setting is fixed before measuring:
`facets.splitAbove: 0` on the pool.

**The null pair.** Each run also times one request against itself, as two arms: `page-plus-count`,
exact, out of the box on one schema. It must read `unchanged`. The range of its ratios is in
`setup.nullPairs`: the noise a verdict has to rise above on that run. If it does not read
unchanged, the run is flagged in `notes` and `--final` refuses it.

**Resident schemas.** Only two schemas are resident at a time, at every size, so the memory of the
container is shared by the same two every time. `bun tools/bench/cache-check.ts` shows what extra
resident copies do: with `BENCH_DB_MEMORY=512m BENCH_SHARED_BUFFERS=128MB` and 1,000,000 rows it
times the out-of-the-box side of five requests alone, next to one other schema, and next to three.

## Methods, and what is still hand SQL

Every timed number is an engine call: pages and counts through `resource.queryIds` (the capped
counts with `count: "capped"`), facets through `resource.queryFacets`. Nothing published is hand
SQL. SQL is used to build the data, to apply the statements the check names, and to find the
cursor anchors.

Medians of 10 calls for requests that are not paired (the mean of the two middle values for an
even count), 5 when the warm-up took over a second, 3 over twenty. `maxMs` is the slowest sample:
with ten samples a 95th percentile would be the same number, so none is reported. A call that
takes over 60 seconds, or that the pool's 61-second `statement_timeout` cancels, marks only that
setup's cell as `skipped: "over-limit"`; the other setups of the pair carry on. Over-limit is a
result and does not stop the file from being published (any other failure does).

## Output and publishing

`tools/results/scale-runs/run-<size>-<time>.json` holds every run (git-ignored): the load average
sampled before each scenario (start, end, maximum), what `checkIndexes` did, the null pair, and a
fingerprint: the engine commit, whether `packages/core` was modified, the harness (a version and a
hash of its sources), the database (version, `current_setting` of the settings that matter,
CPUs and memory), `BENCH_ITERATIONS`, `BENCH_TIMEOUT_MS` and the minimum rounds. `assemble` uses
runs of one fingerprint only: it takes the newest, says how many others it left out, and publishes
for each size the run taken under the lowest load. The load is judged again at that moment from the
stored numbers.

`tools/results/profiles.json` is written only when every default size (200k, 1m, 10m) has a run
and no cell failed (over-limit is not a failure). With `--final` the run must also be sound:

- every chosen run's maximum load at most 8 (`BENCH_LOAD_THRESHOLD` cannot change that: the
  command refuses), `packages/core` unmodified, and no `checkIndexes` error left;
- the null pair reads `unchanged` at every size;
- every cell that `tools/scale-bench-data.ts` reads is there at every size (`contract.ts`), landing
  cells have at least 10 samples and the others at least 3;
- the database's CPUs and memory are known.

Otherwise the file goes to `tools/results/scale-runs/profiles-<sizes>.json`, the reasons are
printed, and `--final` exits with code 2. A provisional result never replaces a `profiles.json`
that is final: that needs `--force`.

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

`tools/scale-bench-data.ts` refuses a `profiles.json` that has no `provisional` flag, writes the
profile definitions on the Benchmarks page from `setup.tuning`, and passes `setup.tuning` and
`setup.nullPairs` through to the page. A provisional file should not be published as final.
