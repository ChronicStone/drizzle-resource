<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import {
  benchScale,
  formatCount,
  formatMs,
  methodSentences,
  SIZE_LONG,
  SIZE_SHORT,
  verdictText,
} from "~/utils/bench-scale";
import type { Verdict } from "~/utils/bench-scale";

/**
 * Before and after on one shared log time axis, from data/bench-scale.json. Each row starts at a
 * gray dot (out of the box, the whole table, an exact count, 2.4.1) and an arrow points to the
 * other time. On a log axis the arrow's length is the speed-up. A row the benchmark judged slower
 * points right in red; an unchanged one is a dot. The three table sizes are all in the HTML and a
 * CSS-only toggle picks one (10M by default); the exact numbers are in the table underneath.
 */
const props = withDefaults(
  defineProps<{
    source?: "requests" | "scoped" | "counts" | "history";
    keys?: string[];
    title: string;
    caption?: string;
  }>(),
  { source: "requests", keys: () => [], caption: undefined },
);

interface Pair {
  a: number;
  b?: number;
  verdict?: Verdict;
  ratio?: number | null;
}
interface Row {
  label: string;
  sub?: string;
  pairs: Pair[];
}

const id = useId();
const d = benchScale;

const built = computed(() => {
  const methods: string[] = [];
  const sizes = d.sizes.map((_, i) => i);
  let rows: Row[];
  let sizeLabels = SIZE_SHORT;
  let sizeLong = SIZE_LONG;
  if (props.source === "requests") {
    rows = props.keys.map((key) => {
      const r = d.requests[key];
      if (!r) throw new Error(`bench-arrows: no request "${key}"`);
      methods.push(r.outOfTheBox.method, ...(r.tuned ? [r.tuned.method] : []));
      return {
        label: r.label,
        sub: r.tuned?.how,
        pairs: sizes.map((i) =>
          r.tuned
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
  } else if (props.source === "scoped") {
    rows = props.keys.map((key) => {
      const r = d.scoped[key];
      if (!r) throw new Error(`bench-arrows: no scoped request "${key}"`);
      methods.push(r.outOfTheBox.method, r.scoped.method);
      return {
        label: r.label,
        pairs: sizes.map((i) => ({
          a: r.outOfTheBox.ms[i]!,
          b: r.scoped.ms[i]!,
          verdict: r.scoped.verdict[i],
          ratio: r.scoped.ratio[i],
        })),
      };
    });
  } else if (props.source === "counts") {
    rows = props.keys.map((key) => {
      const r = d.counts[key];
      if (!r) throw new Error(`bench-arrows: no count "${key}"`);
      methods.push(r.exact.method, r.capped.method);
      return {
        label: r.label,
        sub:
          r.matches.at(-1) === null || r.matches.at(-1) === undefined
            ? undefined
            : `${formatCount(r.matches.at(-1)!)} ${r.matches.at(-1) === 1 ? "match" : "matches"} at 10M`,
        pairs: sizes.map((i) => ({ a: r.exact.ms[i]!, b: r.capped.ms[i]! })),
      };
    });
  } else {
    methods.push("engine");
    rows = d.history.requests.map((r) => ({
      label: r.label,
      pairs: [{ a: r.before, b: r.after }],
    }));
    sizeLabels = [`${formatCount(d.history.rows)} rows`];
    sizeLong = sizeLabels;
  }
  return { rows, methods, sizeLabels, sizeLong };
});
const rows = computed(() => built.value.rows);
const sizeCount = computed(() => built.value.sizeLabels.length);
const last = computed(() => sizeCount.value - 1);

const judged = computed(() => props.source === "requests" || props.source === "scoped");
const legend = computed<[string, string]>(() => {
  if (props.source === "scoped") return ["whole table", "one tenant, 1% of rows"];
  if (props.source === "counts") return ["exact count", "capped at 10,000"];
  if (props.source === "history") return ["2.4.1", "today"];
  return ["out of the box", "tuned"];
});

/* one axis for every row and every size, so switching sizes shows the rows move */
const domain = computed(() => {
  const values = rows.value.flatMap((r) => r.pairs.flatMap((p) => [p.a, p.b ?? p.a]));
  const lo = Math.floor(Math.log10(Math.min(...values)));
  const hi = Math.log10(Math.max(...values)) + 0.12;
  return { lo, hi };
});
const ticks = computed(() => {
  const out: { at: number; label: string; narrow: boolean }[] = [];
  for (let k = domain.value.lo; k <= Math.floor(domain.value.hi); k++) {
    const ms = 10 ** k;
    out.push({
      at: x(ms),
      label: ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`,
      // at 375px keep 1 ms, 100 ms and 10 s
      narrow: k === 0 || k === 2 || k === 4,
    });
  }
  return out;
});
/* rounded so the server and the browser agree */
function x(ms: number) {
  const { lo, hi } = domain.value;
  return Math.round(((Math.log10(ms) - lo) / (hi - lo)) * 10_000) / 100;
}

type Kind = "improved" | "worse" | "unchanged" | "untuned" | "neutral";
function kind(p: Pair): Kind {
  if (p.b === undefined) return "untuned";
  if (!judged.value) return "neutral";
  return p.verdict ?? "neutral";
}
function endLabel(p: Pair) {
  const k = kind(p);
  if (k === "untuned") return "not tuned";
  if (k === "neutral") return `${formatMs(p.a)} → ${formatMs(p.b!)}`;
  if (k === "improved" && typeof p.ratio === "number")
    return `${p.ratio >= 10 ? Math.round(p.ratio).toLocaleString("en-US") : p.ratio.toFixed(1)}× faster`;
  return verdictText(p.verdict!);
}
function shaft(p: Pair) {
  const from = x(p.a);
  const to = x(p.b!);
  return { left: `${Math.min(from, to)}%`, width: `${Math.abs(from - to)}%` };
}
function describe(p: Pair) {
  return p.b === undefined
    ? formatMs(p.a)
    : `${formatMs(p.a)} → ${formatMs(p.b)}${kind(p) === "neutral" ? "" : `, ${endLabel(p)}`}`;
}

const footnote = computed(() =>
  [
    props.caption,
    "Log scale: an arrow's length is how many times the time changed, and each gridline is a factor of 10.",
    ...methodSentences(built.value.methods),
  ]
    .filter(Boolean)
    .join(" "),
);
</script>

<template>
  <figure class="px-embed not-prose ba">
    <input
      v-for="i in sizeCount"
      :id="`${id}-${i - 1}`"
      :key="i"
      type="radio"
      :name="id"
      class="ba-in"
      :class="`ba-in-${i - 1}`"
      :checked="i - 1 === last"
      :aria-label="`Show ${built.sizeLong[i - 1]}`"
    />
    <div class="ba-head">
      <figcaption class="ba-title"><b>{{ title }}</b>, median time per request</figcaption>
      <span class="ba-legend">
        <i class="dot" />{{ legend[0] }} <i class="arrow" :class="{ neutral: !judged }" />{{
          legend[1]
        }}
      </span>
      <span v-if="sizeCount > 1" class="ba-sizes">
        <label
          v-for="i in sizeCount"
          :key="i"
          :for="`${id}-${i - 1}`"
          class="ba-tab"
          :class="`ba-tab-${i - 1}`"
          >{{ built.sizeLabels[i - 1] }}</label
        >
      </span>
    </div>

    <div class="ba-views" aria-hidden="true">
      <div v-for="(_, s) in sizeCount" :key="s" class="ba-view" :class="`ba-view-${s}`">
        <div class="ba-row ba-axis">
          <span class="ba-name" />
          <span class="ba-track">
            <span
              v-for="t in ticks"
              :key="t.label"
              class="ba-tick"
              :class="{ wide: !t.narrow }"
              :style="{ left: `${t.at}%` }"
              >{{ t.label }}</span
            >
          </span>
          <span class="ba-end" />
        </div>
        <div v-for="r in rows" :key="r.label + (r.sub ?? '')" class="ba-row">
          <span class="ba-name">
            <span class="ba-label">{{ r.label }}</span>
            <span v-if="r.sub" class="ba-sub">{{ r.sub }}</span>
          </span>
          <span class="ba-track" :title="describe(r.pairs[s]!)">
            <span v-for="t in ticks" :key="t.label" class="ba-grid" :style="{ left: `${t.at}%` }" />
            <!-- stacked shaft, dot, head: a small change keeps its arrowhead visible on the dot -->
            <span class="ba-dot" :style="{ left: `${x(r.pairs[s]!.a)}%` }" />
            <template v-if="kind(r.pairs[s]!) !== 'untuned' && kind(r.pairs[s]!) !== 'unchanged'">
              <span class="ba-shaft" :class="kind(r.pairs[s]!)" :style="shaft(r.pairs[s]!)" />
              <span
                class="ba-head-tip"
                :class="[kind(r.pairs[s]!), r.pairs[s]!.b! < r.pairs[s]!.a ? 'left' : 'right']"
                :style="{ left: `${x(r.pairs[s]!.b!)}%` }"
              />
            </template>
          </span>
          <span class="ba-end" :class="kind(r.pairs[s]!)">{{ endLabel(r.pairs[s]!) }}</span>
        </div>
      </div>
    </div>

    <table class="ba-table" :style="{ '--n': sizeCount }">
      <caption>
        Exact numbers,
        {{ legend[0] }}
        →
        {{ legend[1] }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Request</th>
          <th v-for="s in built.sizeLong" :key="s" scope="col">{{ s }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.label + (r.sub ?? '')">
          <th scope="row">{{ r.label }}<span v-if="r.sub" class="ba-sub"> · {{ r.sub }}</span></th>
          <td v-for="(p, i) in r.pairs" :key="i">
            <span class="nw">{{ formatMs(p.a) }}</span>
            <span v-if="p.b !== undefined" class="nw"> → {{ formatMs(p.b) }}</span>
            <em v-if="kind(p) !== 'neutral' && kind(p) !== 'untuned'" :class="kind(p)">{{
              endLabel(p)
            }}</em>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="ba-foot">{{ footnote }}</p>
  </figure>
</template>

<style scoped>
.ba {
  position: relative;
  margin: 20px 0;
  padding: 14px 16px 10px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: var(--panel2);
}
/* the size toggle: radios that CSS reads, so it works without JavaScript */
.ba-in {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.ba-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--ink3);
}
.ba-title {
  flex: 1 1 260px;
}
.ba-title b {
  color: var(--ink);
  font-weight: 600;
}
.ba-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ba-legend .dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ink3);
}
.ba-legend .arrow {
  display: inline-block;
  width: 18px;
  height: 2.5px;
  margin-left: 6px;
  background: var(--hit-text);
}
.ba-legend .arrow.neutral {
  background: var(--ink);
}
.ba-sizes {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--line);
}
.ba-tab {
  padding: 3px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--ink3);
  cursor: pointer;
  user-select: none;
}
.ba-in-0:checked ~ .ba-head .ba-tab-0,
.ba-in-1:checked ~ .ba-head .ba-tab-1,
.ba-in-2:checked ~ .ba-head .ba-tab-2 {
  background: var(--panel2);
  color: var(--ink);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--line2);
}
.ba-in-0:focus-visible ~ .ba-head .ba-tab-0,
.ba-in-1:focus-visible ~ .ba-head .ba-tab-1,
.ba-in-2:focus-visible ~ .ba-head .ba-tab-2 {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}
.ba-view {
  display: none;
}
.ba-in-0:checked ~ .ba-views .ba-view-0,
.ba-in-1:checked ~ .ba-views .ba-view-1,
.ba-in-2:checked ~ .ba-views .ba-view-2 {
  display: block;
}

.ba-row {
  display: grid;
  grid-template-columns: minmax(0, 34%) minmax(0, 1fr) 104px;
  column-gap: 12px;
  align-items: center;
}
.ba-axis {
  height: 20px;
}
.ba-name {
  min-width: 0;
  padding: 6px 0;
}
.ba-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.ba-sub {
  display: block;
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--ink3);
}
.ba-track {
  position: relative;
  align-self: stretch;
  min-height: 34px;
}
.ba-axis .ba-track {
  min-height: 0;
}
.ba-tick {
  position: absolute;
  bottom: 2px;
  transform: translateX(-50%);
  font-size: 10.5px;
  color: var(--ink3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ba-grid {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line2);
}
.ba-dot {
  position: absolute;
  z-index: 2;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ink3);
  box-shadow: 0 0 0 2px var(--panel2);
  transform: translate(-50%, -50%);
}
.ba-shaft {
  position: absolute;
  z-index: 1;
  top: 50%;
  height: 2.5px;
  transform: translateY(-50%);
  background: var(--hit-text);
}
.ba-head-tip {
  position: absolute;
  z-index: 3;
  top: 50%;
  width: 0;
  height: 0;
  border-top: 5.5px solid transparent;
  border-bottom: 5.5px solid transparent;
}
/* the tip sits on the value */
.ba-head-tip.left {
  border-right: 9px solid var(--hit-text);
  transform: translateY(-50%);
}
.ba-head-tip.right {
  border-left: 9px solid var(--hit-text);
  transform: translate(-100%, -50%);
}
.ba-shaft.worse {
  background: var(--ui-error);
}
.ba-head-tip.worse.left {
  border-right-color: var(--ui-error);
}
.ba-head-tip.worse.right {
  border-left-color: var(--ui-error);
}
.ba-shaft.neutral {
  background: var(--ink);
}
.ba-head-tip.neutral.left {
  border-right-color: var(--ink);
}
.ba-head-tip.neutral.right {
  border-left-color: var(--ink);
}
.ba-end {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ba-end.improved {
  color: var(--hit-text);
}
.ba-end.worse {
  color: var(--ui-error);
}
.ba-end.unchanged,
.ba-end.untuned {
  font-weight: 400;
  color: var(--ink3);
}
.ba-end.neutral {
  font-weight: 500;
  color: var(--ink2);
}

/* exact numbers, for reading and for screen readers */
.ba-table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ba-table caption {
  padding-bottom: 4px;
  font-size: 11.5px;
  text-align: left;
  color: var(--ink3);
}
.ba-table th,
.ba-table td {
  padding: 5px 6px 5px 0;
  border-top: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  color: var(--ink2);
}
.ba-table thead th {
  font-size: 11px;
  background: transparent;
}
.ba-table tbody th {
  /* the docs style every th as a mono column label; a row label is ordinary text */
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
  background: transparent;
  color: var(--ink);
}
.ba-table tbody th .ba-sub {
  display: inline;
}
.ba-table .nw {
  white-space: nowrap;
}
.ba-table em {
  display: block;
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
}
.ba-table em.improved {
  color: var(--hit-text);
}
.ba-table em.worse {
  color: var(--ui-error);
}
.ba-table em.unchanged,
.ba-table em.untuned {
  color: var(--ink3);
}
.ba-foot {
  margin: 8px 0 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink3);
}

@media (max-width: 560px) {
  .ba {
    padding: 12px 12px 8px;
  }
  .ba-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "name end"
      "track track";
  }
  .ba-name {
    grid-area: name;
    padding: 8px 0 0;
  }
  .ba-end {
    grid-area: end;
    align-self: start;
    padding-top: 8px;
  }
  .ba-track {
    grid-area: track;
    min-height: 26px;
  }
  .ba-axis {
    grid-template-areas: "track track";
  }
  .ba-axis .ba-name,
  .ba-axis .ba-end {
    display: none;
  }
  .ba-tick.wide {
    display: none;
  }
  .ba-table thead th:first-child {
    display: none;
  }
  .ba-table tr {
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
    column-gap: 8px;
  }
  .ba-table tbody th {
    grid-column: 1 / -1;
    padding-top: 8px;
  }
  .ba-table td,
  .ba-table tbody th {
    border-top: 0;
  }
  .ba-table tbody tr {
    border-top: 1px solid var(--line);
  }
  /* before on one line, "→ after" on the next */
  .ba-table .nw {
    display: block;
  }
}
</style>
