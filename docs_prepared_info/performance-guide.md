# Performance Guide

This guide explains how to think about performance when using `@exassess/drizzle-query-resource`.

The package supports a full automatic mode, and that is the right default for most resources. It gives you:

- typed field paths
- a consistent request contract
- built-in ids, rows, and facet execution
- fewer moving parts to maintain

However, automatic does not always mean optimal.

## The Short Version

- Start with the built-in automatic mode.
- Benchmark real endpoints under realistic load.
- Optimize indexes and connection pooling first.
- If ids/count becomes the bottleneck, override `strategy.ids`.
- If facets are still the hotspot, evaluate `strategy.facets` or a more specialized design later.

## What Usually Drives Cost

Performance depends far more on query shape than on the package alone.

The biggest cost drivers are usually:

- relation-heavy sorting
- many-to-many search paths
- many-to-many facets
- broad search combined with multiple facets
- deep offset pagination
- high concurrency against expensive SQL

## Automatic Mode

Automatic mode is the package default:

- built-in ids SQL planning
- built-in row hydration through Drizzle relational queries
- built-in SQL facet resolution

This is usually a good fit when:

- the table is small or moderate in size
- queries mostly stay on root fields
- relation paths are single-valued
- facets are absent or light

## When To Reach For `strategy.ids`

`strategy.ids` is the first override to consider when the built-in planner is correct but too expensive.

It is a good fit when:

- ids/count queries are slower than row hydration
- sorting or filtering uses relation paths
- many-to-many paths appear in the hot path
- you want to preserve the same API and default hydration

In practice, `strategy.ids` is often the highest-leverage override because it lets you optimize the expensive count/page-id stage without taking over the rest of the pipeline.

## Facets

Facets deserve special attention because they multiply work quickly.

General rules:

- root-column facets are usually cheapest
- single-valued relation facets are usually manageable
- many-to-many facets are usually the most expensive
- broad search + multiple facets + deep pagination is usually the worst case

Operationally, this means:

- benchmark faceted and non-faceted traffic separately
- watch concurrency, not just single-request latency
- consider limiting facet count on larger resources
- be careful raising pool size if expensive facet queries are already stressing Postgres

## Common Gotchas

- Relation-path sorting often forces extra joins in the ids stage.
- Many-to-many search or facets often require dedupe-heavy SQL.
- Deep offset pagination can dominate total query cost.
- Improving pool throughput can expose the true cost of expensive facet SQL.
- Default row hydration is convenient, but ids selection is often the first thing worth optimizing.

## Suggested Rollout Path

For a new resource:

1. Start in automatic mode.
2. Add indexes for the expected search, filter, and sort hot paths.
3. Benchmark:
   - non-faceted requests
   - cheap facets
   - many-to-many facets
   - deep-page cases
4. If ids/count is the bottleneck, add `strategy.ids`.
5. If facets remain the bottleneck, evaluate `strategy.facets` or a more specialized backend strategy.

## Benchmark Reference

For measured benchmark data from this repo, see:

- [Benchmark Results](./benchmark-results.md)
