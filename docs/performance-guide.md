# Performance Guide

This guide explains how to think about performance when using `@exassess/drizzle-query-resource`.

## Start with automatic mode

Automatic mode is the right default for most resources because it gives you:

- typed field paths
- a consistent request contract
- built-in ids, rows, and facet execution
- fewer moving parts to maintain

Automatic does not always mean optimal.

## Watch the main cost drivers

The biggest cost drivers are usually:

- relation-heavy sorting
- many-to-many search paths
- many-to-many facets
- broad search combined with multiple facets
- deep offset pagination
- high concurrency against expensive SQL

## Reach for `strategy.ids` first

`strategy.ids` is the first override to consider when the built-in planner is correct but too expensive.

It is a good fit when:

- ids and count queries are slower than row hydration
- sorting or filtering uses relation paths
- many-to-many paths appear in the hot path
- you want to preserve the same API and default hydration

## Treat facets separately

Facet cost grows quickly. In general:

- root-column facets are usually cheapest
- single-valued relation facets are usually manageable
- many-to-many facets are usually the most expensive

Benchmark faceted and non-faceted traffic separately, and watch concurrency instead of only single-request latency.
