# Benchmark Results

This page captures measured benchmark results for `@exassess/drizzle-query-resource` using the `employees` resource in this repo.

## Scope

Compared modes:

- automatic ids strategy
- manual `strategy.ids`

The public API contract stayed the same in both modes.

## Selected Comparison

| Scenario | Auto RPS | Manual RPS | Auto p99 | Manual p99 |
|---|---:|---:|---:|---:|
| baseline, 10 concurrency | 17.2 | 219.7 | 928ms | 92ms |
| baseline, 25 concurrency | 15.1 | 229.6 | 2136ms | 183ms |
| baseline, 50 concurrency | 14.1 | 240.9 | 4504ms | 409ms |
| m2m skill facet, 25 concurrency | 4.7 | 8.2 | 6427ms | 3535ms |

## What To Take From This

These results do not mean the built-in automatic mode is bad.

They do mean:

- automatic mode is the right default starting point
- relation-heavy resources still need benchmarking
- a tailored `strategy.ids` can produce a very large improvement without changing the public API
- many-to-many facets remain expensive even after ids optimization
