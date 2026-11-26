<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import { benchScale, formatCount, formatMs, SIZE_LONG, verdictText } from "~/utils/bench-scale";
import type { Series, Verdict } from "~/utils/bench-scale";

/**
 * Requests by table size (200k, 1M, 10M rows), from data/bench-scale.json.
 * - `requests`: out of the box, or with `compare` next to tuned and the benchmark's verdict.
 * - `scoped`: the whole table next to one tenant (1% of rows).
 * - `counts`: the count statement alone, exact next to capped.
 * - `facets`: the four ways to run the facets of `facet`.
 */
const props = withDefaults(
  defineProps<{
    source?: "requests" | "scoped" | "counts" | "facets";
    keys?: string[];
    facet?: string;
    compare?: boolean;
    title: string;
    caption?: string;
  }>(),
  { source: "requests", keys: () => [], facet: "twoFacets", compare: false, caption: undefined },
);

interface Cell {
  a: number;
  b?: number;
  verdict?: Verdict;
  ratio?: number | null;
  sub?: string;
}
interface Row {
  label: string;
  sub?: string;
  cells: Cell[];
}

const FACET_VARIANTS: Record<string, string> = {
  "grouping-sets/sequential": "One GROUPING SETS statement",
  "grouping-sets/concurrent": "GROUPING SETS, statement groups in parallel",
  "separate/sequential": "One statement per facet, one after another",
  "separate/concurrent": "One statement per facet, in parallel",
};

/* every series a table shows, so its footnote can say how each was measured */
function build(series: Series[]): Row[] {
  const d = benchScale;
  const sizes = d.sizes.map((_, i) => i);
  if (props.source === "requests") {
    return props.keys.map((key) => {
      const r = d.requests[key];
      if (!r) throw new Error(`bench-scale: no request "${key}"`);
      series.push(r.outOfTheBox);
      if (props.compare && r.tuned) series.push(r.tuned);
      return {
        label: r.label,
        sub: props.compare ? (r.tuned?.how ?? "not tuned") : r.shape,
        cells: sizes.map((i) =>
          props.compare && r.tuned
            ? {
                a: r.outOfTheBox.ms[i]!,
                b: r.tuned.ms[i]!,
                verdict: r.tuned.verdict[i],
                ratio: r.tuned.ratio[i],
              }
            : { a: r.outOfTheBox.ms[i]! },
        ),
      };
    });
  }
  if (props.source === "scoped") {
    return props.keys.map((key) => {
      const r = d.scoped[key];
      if (!r) throw new Error(`bench-scale: no scoped request "${key}"`);
      series.push(r.outOfTheBox, r.scoped);
      return {
        label: r.label,
        cells: sizes.map((i) => ({
          a: r.outOfTheBox.ms[i]!,
          b: r.scoped.ms[i]!,
          verdict: r.scoped.verdict[i],
          ratio: r.scoped.ratio[i],
        })),
      };
    });
  }
  if (props.source === "counts") {
    return props.keys.map((key) => {
      const r = d.counts[key];
      if (!r) throw new Error(`bench-scale: no count "${key}"`);
      series.push(r.exact, r.capped);
      return {
        label: r.label,
        cells: sizes.map((i) => ({
          a: r.exact.ms[i]!,
          b: r.capped.ms[i]!,
          sub:
            r.matches[i] === null
              ? undefined
              : `${formatCount(r.matches[i]!)} ${r.matches[i] === 1 ? "match" : "matches"}`,
        })),
      };
    });
  }
  const variants = d.facetVariants[props.facet];
  if (!variants) throw new Error(`bench-scale: no facet comparison "${props.facet}"`);
  return Object.entries(FACET_VARIANTS).map(([variant, label]) => {
    const s = variants[variant];
    if (!s) throw new Error(`bench-scale: no facet variant "${variant}"`);
    series.push(s);
    return { label, cells: sizes.map((i) => ({ a: s.ms[i]! })) };
  });
}
const table = computed(() => {
  const series: Series[] = [];
  return { rows: build(series), series };
});
const rows = computed(() => table.value.rows);

/* the accent colour means "tuned"; a pair without a verdict (exact and capped counts) stays neutral */
const neutral = computed(() => props.source === "counts");
const legend = computed<[string, string] | undefined>(() => {
  if (props.source === "scoped") return ["whole table", "one tenant, 1% of rows"];
  if (props.source === "counts") return ["exact", "capped at 10,000"];
  if (props.source === "requests" && props.compare) return ["out of the box", "tuned"];
  return undefined;
});

/* how each series was measured, in words; the sentences come from the methods in the file */
const METHOD_TEXT: Record<string, string> = {
  engine: "Through the engine, end to end, from Node over TCP.",
  "hand-sql": "Measured as SQL with psql inside the database container: no network, no JavaScript.",
  "engine+hand-sql":
    "Tuned counts add the engine's page statement to the capped count statement run as SQL: the engine of this run predates capped counts.",
};
const methods = computed(() => {
  const seen = new Set(table.value.series.flatMap((s) => s.method.split(", ")));
  return [...seen].map((m) => METHOD_TEXT[m] ?? m);
});

const footnote = computed(() =>
  [props.caption, "Bars on a log scale, 0.1 ms to 20 s.", ...methods.value]
    .filter(Boolean)
    .join(" "),
);

/* log scale: 0.1 ms at the left edge, 20 s at the right */
const LO = Math.log10(0.1);
const HI = Math.log10(20_000);
/* rounded, so the server and the browser, whose log10 can differ in the last digit, agree */
const pct = (ms: number) => {
  const share = ((Math.log10(ms) - LO) / (HI - LO)) * 100;
  return `${Math.max(2, Math.min(100, Math.round(share * 100) / 100))}%`;
};
const verdictLabel = (c: Cell) =>
  c.verdict === "improved" && typeof c.ratio === "number"
    ? `${c.ratio >= 10 ? Math.round(c.ratio) : c.ratio.toFixed(1)}× faster`
    : c.verdict
      ? verdictText(c.verdict)
      : "";
</script>

<template>
  <figure class="px-embed not-prose bsc">
    <figcaption class="bsc-cap">
      <span><b>{{ title }}</b>, median time per request</span>
      <span v-if="legend" class="bsc-legend">
        <span><i class="a" />{{ legend[0] }}</span>
        <span><i class="b" :class="{ neutral }" />{{ legend[1] }}</span>
      </span>
    </figcaption>
    <table>
      <thead>
        <tr>
          <th scope="col" class="bsc-req">Request</th>
          <th v-for="s in SIZE_LONG" :key="s" scope="col">{{ s }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.label + (r.sub ?? '')">
          <th scope="row" class="bsc-req">
            <span class="bsc-label">{{ r.label }}</span>
            <span v-if="r.sub" class="bsc-sub">{{ r.sub }}</span>
          </th>
          <td v-for="(c, i) in r.cells" :key="i">
            <span class="bsc-val" :class="{ dim: c.b !== undefined }">{{ formatMs(c.a) }}</span>
            <span class="bsc-bar"><i class="a" :style="{ width: pct(c.a) }" /></span>
            <template v-if="c.b !== undefined">
              <span class="bsc-val" :class="c.verdict">
                {{ formatMs(c.b) }}
                <em v-if="c.verdict" :class="c.verdict">{{ verdictLabel(c) }}</em>
              </span>
              <span class="bsc-bar"
                ><i class="b" :class="[c.verdict, { neutral }]" :style="{ width: pct(c.b) }"
              /></span>
            </template>
            <span v-if="c.sub" class="bsc-sub">{{ c.sub }}</span>
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
.bsc-legend {
  display: flex;
  gap: 14px;
}
.bsc-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border-radius: 2px;
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
.bsc-val.dim {
  font-weight: 400;
  color: var(--ink2);
}
.bsc-val em {
  margin-left: 4px;
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
}
em.improved {
  color: var(--hit-text);
}
em.worse {
  color: var(--ui-error);
}
em.unchanged {
  color: var(--ink3);
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
i.a,
.bsc-legend i.a {
  background: var(--ink3);
}
i.b,
.bsc-legend i.b {
  background: var(--hit);
  box-shadow: inset 0 0 0 1px var(--hit-text);
}
i.b.worse {
  background: var(--ui-error);
  box-shadow: none;
}
i.b.unchanged,
i.b.neutral,
.bsc-legend i.b.neutral {
  background: var(--ink);
  box-shadow: none;
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
  /* the verdict on a line of its own, so "26× faster" never breaks */
  .bsc-val em {
    display: block;
    margin: 1px 0 0;
    white-space: nowrap;
  }
}
</style>
