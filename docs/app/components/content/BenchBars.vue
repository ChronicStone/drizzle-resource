<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import { benchScale, formatMs } from "~/utils/bench-scale";

/**
 * Horizontal bars for benchmark results, drawn in SVG.
 * A row has either one `value`, or a `before` and `after` pair drawn as two bars.
 */
interface Row {
  label: string;
  note?: string;
  value?: number;
  before?: number;
  after?: number;
  /** draw a single value in the accent colour */
  hot?: boolean;
}
const input = withDefaults(
  defineProps<{
    title: string;
    unit?: "ms" | "s" | "rps";
    rows?: Row[];
    /** read the rows from data/bench-scale.json instead: throughput under load, or full scans */
    source?: "load" | "scans";
    /** labels for the two bars of a pair */
    legend?: [string, string];
    caption?: string;
  }>(),
  { unit: "ms", rows: () => [], source: undefined, legend: undefined, caption: undefined },
);
const props = computed(() => {
  if (input.source === "load") {
    return {
      ...input,
      unit: "rps" as const,
      rows: benchScale.load.requests.map((r) => ({
        label: r.label,
        note: [r.note, `p95 ${formatMs(r.p95)}`].filter(Boolean).join(" · "),
        value: r.rps,
        hot: ["page", "cursor", "ids"].includes(r.key),
      })),
    };
  }
  if (input.source === "scans") {
    return {
      ...input,
      unit: "s" as const,
      rows: benchScale.scans.requests.map((r) => ({
        label: r.label,
        before: r.pages / 1000,
        after: r.scan / 1000,
      })),
    };
  }
  return input;
});

/* draw at the real width, so text keeps its size; under 520px labels go above the bars */
const root = ref<HTMLElement>();
const W = ref(740);
let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (e) W.value = Math.max(260, Math.round(e.contentRect.width));
  });
  if (root.value) ro.observe(root.value);
});
onBeforeUnmount(() => ro?.disconnect());
const narrow = computed(() => W.value < 520);
const L = computed(() => (narrow.value ? 0 : 200));
const R = computed(() => W.value - (narrow.value ? 64 : 90));
const top = computed(() => (narrow.value ? 20 : 0));
const paired = computed(() => props.value.rows.some((r) => r.before !== undefined));
const rowH = computed(() => (paired.value ? 52 : 40) + top.value);
/* a round step, then an axis that ends on a multiple of it */
const step = computed(() => {
  const m = Math.max(
    ...props.value.rows.flatMap((r) => [r.value ?? 0, r.before ?? 0, r.after ?? 0]),
  );
  const raw = m / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= raw) ?? p * 10;
});
const max = computed(() => {
  const m = Math.max(
    ...props.value.rows.flatMap((r) => [r.value ?? 0, r.before ?? 0, r.after ?? 0]),
  );
  return Math.ceil(m / step.value) * step.value;
});
const ticks = computed(() =>
  Array.from({ length: Math.round(max.value / step.value) + 1 }, (_, i) => i * step.value),
);
const H = computed(() => props.value.rows.length * rowH.value + 28);
const x = (v: number) => L.value + (v / max.value) * (R.value - L.value);
const fmt = (v: number) =>
  props.value.unit === "rps"
    ? `${Math.round(v).toLocaleString("en")}/s`
    : props.value.unit === "s"
      ? `${v.toFixed(2)} s`
      : v >= 10
        ? `${Math.round(v)} ms`
        : `${v.toFixed(v < 1 ? 2 : 1)} ms`;
const unitName = computed(() =>
  props.value.unit === "rps"
    ? "requests per second"
    : props.value.unit === "s"
      ? "seconds"
      : "milliseconds",
);
const tick = (v: number) => (Math.round(v * 100) / 100).toLocaleString("en");
</script>

<template>
  <figure class="px-embed not-prose bb">
    <div ref="root" class="bb-measure" />
    <figcaption class="bb-cap">
      <span><b>{{ props.title }}</b>, {{ unitName }}</span>
      <span v-if="props.legend" class="bb-legend">
        <span><i class="base" />{{ props.legend[0] }}</span>
        <span><i class="hit" />{{ props.legend[1] }}</span>
      </span>
    </figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="props.title">
      <g v-for="t in ticks" :key="t">
        <line :x1="x(t)" :x2="x(t)" y1="0" :y2="H - 22" class="grid" />
        <text
          :x="x(t)"
          :y="H - 6"
          :text-anchor="t === 0 && narrow ? 'start' : 'middle'"
          class="axis"
        >
          {{ tick(t) }}
        </text>
      </g>
      <g v-for="(r, i) in props.rows" :key="r.label" :transform="`translate(0 ${6 + i * rowH})`">
        <title>
          {{
            r.before !== undefined
              ? `${r.label}: ${fmt(r.before)} → ${fmt(r.after ?? 0)}`
              : `${r.label}: ${fmt(r.value ?? 0)}`
          }}
        </title>
        <rect x="0" y="-4" :width="W" :height="rowH - 4" class="hitbox" />
        <text v-if="narrow" x="0" y="11" class="label">
          {{ r.label }}<tspan v-if="r.note" class="note"> · {{ r.note }}</tspan>
        </text>
        <template v-else>
          <text x="0" y="14" class="label">{{ r.label }}</text>
          <text v-if="r.note" x="0" y="30" class="note">{{ r.note }}</text>
        </template>
        <g v-if="r.before !== undefined" :transform="`translate(0 ${top})`">
          <rect
            :x="L"
            y="0"
            :width="Math.max(3, x(r.before) - L)"
            height="14"
            rx="3"
            class="base"
          />
          <rect
            :x="L"
            y="18"
            :width="Math.max(3, x(r.after ?? 0) - L)"
            height="14"
            rx="3"
            class="hit"
          />
          <text :x="x(r.before) + 7" y="11" class="val dim">{{ fmt(r.before) }}</text>
          <text :x="x(r.after ?? 0) + 7" y="29" class="val">{{ fmt(r.after ?? 0) }}</text>
        </g>
        <g v-else :transform="`translate(0 ${top})`">
          <rect
            :x="L"
            y="2"
            :width="Math.max(4, x(r.value ?? 0) - L)"
            height="16"
            rx="3"
            :class="r.hot ? 'hit' : 'base'"
          />
          <text :x="x(r.value ?? 0) + 8" y="14" class="val">{{ fmt(r.value ?? 0) }}</text>
        </g>
      </g>
    </svg>
    <p v-if="props.caption" class="bb-foot">{{ props.caption }}</p>
  </figure>
</template>

<style scoped>
.bb {
  margin: 20px 0;
  padding: 16px 18px 12px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: var(--panel2);
}
.bb-cap {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--ink3);
}
.bb-cap b {
  color: var(--ink);
  font-weight: 600;
}
.bb-legend {
  display: flex;
  gap: 14px;
}
.bb-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border-radius: 2px;
}
svg {
  display: block;
  width: 100%;
  height: auto;
  font-family: var(--font-sans);
}
.grid {
  stroke: var(--line);
}
.axis {
  font-size: 11px;
  fill: var(--ink3);
}
.label {
  font-size: 13px;
  fill: var(--ink);
}
.note {
  font-size: 11px;
  fill: var(--ink3);
}
.val {
  font-size: 12.5px;
  font-weight: 600;
  fill: var(--ink);
}
.val.dim {
  font-weight: 400;
  fill: var(--ink2);
}
.hit,
.bb-legend .hit {
  fill: var(--hit);
  background: var(--hit);
  /* a darker edge keeps the yellow visible on light panels */
  stroke: var(--hit-text);
  stroke-width: 1;
  box-shadow: inset 0 0 0 1px var(--hit-text);
}
.base,
.bb-legend .base {
  fill: var(--ink3);
  background: var(--ink3);
}
.bb-measure {
  height: 0;
}
.hitbox {
  fill: transparent;
}
.bb-foot {
  margin: 6px 0 2px;
  font-size: 12.5px;
  color: var(--ink3);
}
@media (max-width: 640px) {
  .bb {
    padding: 12px 12px 8px;
  }
}
</style>
