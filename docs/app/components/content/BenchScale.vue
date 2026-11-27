<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import { benchScale, formatCell, methodSentences, SIZE_LONG } from "~/utils/bench-scale";

/**
 * One series by table size (200k, 1M, 10M rows), from data/bench-scale.json, as linear bars.
 * - `requests`: out of the box, scaled per row, so a row shows how its time grows with the table.
 * - `facets`: the four ways to run the facets of `facet`, scaled per column, so each size compares
 *   the four ways.
 * A before and after (tuned, one tenant, exact and capped) is drawn by BenchArrows instead.
 */
const props = withDefaults(
  defineProps<{
    source?: "requests" | "facets";
    keys?: string[];
    facet?: string;
    title: string;
    caption?: string;
  }>(),
  { source: "requests", keys: () => [], facet: "twoFacets", caption: undefined },
);

interface Row {
  label: string;
  sub?: string;
  /** Null where the request ran past the limit. */
  ms: (number | null)[];
  /** The limit in seconds where it did, else null. */
  over: (number | null)[];
}

const FACET_VARIANTS: Record<string, string> = {
  "grouping-sets/sequential": "One GROUPING SETS statement",
  "grouping-sets/concurrent": "GROUPING SETS, statement groups in parallel",
  "separate/sequential": "One statement per facet, one after another",
  "separate/concurrent": "One statement per facet, in parallel",
};

const table = computed(() => {
  const d = benchScale;
  const methods: string[] = [];
  let rows: Row[];
  if (props.source === "requests") {
    rows = props.keys.map((key) => {
      const r = d.requests[key];
      if (!r) throw new Error(`bench-scale: no request "${key}"`);
      methods.push(r.outOfTheBox.method);
      return { label: r.label, sub: r.shape, ms: r.outOfTheBox.ms, over: r.outOfTheBox.over };
    });
  } else {
    const variants = d.facetVariants[props.facet];
    if (!variants) throw new Error(`bench-scale: no facet comparison "${props.facet}"`);
    rows = Object.entries(FACET_VARIANTS).map(([variant, label]) => {
      const s = variants[variant];
      if (!s) throw new Error(`bench-scale: no facet variant "${variant}"`);
      methods.push(s.method);
      return { label, ms: s.ms, over: s.over };
    });
  }
  return { rows, methods };
});
const rows = computed(() => table.value.rows);

/* a request over the limit counts as the limit, which it reached: a bar as long as the longest */
const value = (r: Row, i: number) => r.ms[i] ?? (r.over[i] ?? 0) * 1000;
/* linear bars: per row for requests, per column for the facet comparison */
const byColumn = computed(() => props.source === "facets");
const scaleMax = computed(() => {
  const all = rows.value;
  if (byColumn.value) {
    const columns = (all[0]?.ms ?? []).map((_, i) => Math.max(...all.map((r) => value(r, i))));
    return all.map(() => columns);
  }
  return all.map((r) => r.ms.map(() => Math.max(...r.ms.map((_, i) => value(r, i)))));
});
/* rounded so the server and the browser agree; 3px keeps a tiny value visible */
const width = (ms: number | null, row: number, col: number) => {
  if (ms === null) return "100%";
  const share = Math.round((ms / scaleMax.value[row]![col]!) * 10_000) / 100;
  return `max(3px, ${Math.min(100, share)}%)`;
};
const footnote = computed(() =>
  [
    props.caption,
    byColumn.value
      ? "Bars are linear: each column is scaled to the slowest way at that table size."
      : "Bars are linear: each row is scaled to that row's slowest time.",
    ...methodSentences(table.value.methods),
  ]
    .filter(Boolean)
    .join(" "),
);
</script>

<template>
  <figure class="px-embed not-prose bsc">
    <figcaption class="bsc-cap">
      <span><b>{{ title }}</b>, median time per request</span>
    </figcaption>
    <table>
      <thead>
        <tr>
          <th scope="col" class="bsc-req">Request</th>
          <th v-for="s in SIZE_LONG" :key="s" scope="col">{{ s }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, ri) in rows" :key="r.label">
          <th scope="row" class="bsc-req">
            <span class="bsc-label">{{ r.label }}</span>
            <span v-if="r.sub" class="bsc-sub">{{ r.sub }}</span>
          </th>
          <td v-for="(ms, i) in r.ms" :key="i">
            <span class="bsc-val" :class="{ over: ms === null }">{{
              formatCell(ms, r.over[i] ?? null)
            }}</span>
            <span class="bsc-bar"
              ><i class="a" :class="{ over: ms === null }" :style="{ width: width(ms, ri, i) }"
            /></span>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="bsc-foot">{{ footnote }}</p>
  </figure>
</template>

<style scoped>
.bsc {
  margin: 20px 0;
  padding: 14px 16px 10px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: var(--panel2);
}
.bsc-cap {
  display: flex;
  justify-content: space-between;
  gap: 8px 14px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--ink3);
}
.bsc-cap b {
  color: var(--ink);
  font-weight: 600;
}
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 9px 8px;
  text-align: left;
  vertical-align: top;
  border-top: 1px solid var(--line);
}
tbody th {
  /* the docs style every th as a mono column label; a row label is ordinary text */
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
  background: transparent;
}
thead th {
  background: transparent;
  border-top: 0;
  padding-top: 4px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink3);
}
.bsc-req {
  width: 34%;
  padding-left: 0;
}
.bsc-label {
  display: block;
  font-weight: 500;
  color: var(--ink);
}
.bsc-sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.4;
  font-weight: 400;
  color: var(--ink3);
}
.bsc-val {
  display: block;
  font-weight: 600;
  color: var(--ink);
}
.bsc-bar {
  display: block;
  height: 5px;
  margin: 3px 0 6px;
  border-radius: 3px;
  background: var(--line);
}
.bsc-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
i.a {
  background: var(--ink3);
}
/* ran past the limit: a striped bar of full length, its time unknown */
.bsc-val.over {
  color: var(--ui-warning);
}
i.a.over {
  background: repeating-linear-gradient(135deg, var(--ui-warning) 0 4px, transparent 4px 8px);
  opacity: 0.8;
}
.bsc-foot {
  margin: 8px 0 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink3);
}
@media (max-width: 560px) {
  .bsc {
    padding: 12px 12px 8px;
  }
  thead .bsc-req {
    display: none;
  }
  tr {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 8px;
    border-top: 1px solid var(--line);
  }
  thead tr {
    border-top: 0;
  }
  th,
  td {
    border-top: 0;
    padding: 6px 0;
  }
  tbody .bsc-req {
    grid-column: 1 / -1;
    width: auto;
    padding: 10px 0 0;
  }
}
</style>
