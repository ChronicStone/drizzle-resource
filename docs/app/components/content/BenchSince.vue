<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";

/** Before and after on a log scale, one line per request. */
interface Row {
  label: string;
  before: number;
  after: number;
}
const props = defineProps<{ title: string; rows: Row[]; legend: [string, string] }>();

/* draw at the real width, so text keeps its size; under 520px labels go above the dots */
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
const L = computed(() => (narrow.value ? 6 : 200));
const R = computed(() => W.value - 80);
const rowH = computed(() => (narrow.value ? 52 : 40));
const lo = computed(() => Math.log10(Math.min(...props.rows.map((r) => r.after)) / 1.5));
const hi = computed(() => Math.log10(Math.max(...props.rows.map((r) => r.before)) * 1.6));
const x = (v: number) =>
  L.value + ((Math.log10(v) - lo.value) / (hi.value - lo.value)) * (R.value - L.value);
const ticks = computed(() =>
  [0.1, 1, 10, 100, 1000].filter((t) => Math.log10(t) >= lo.value && Math.log10(t) <= hi.value),
);
const H = computed(() => props.rows.length * rowH.value + 30);
const fmt = (v: number) => (v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(v < 1 ? 2 : 1)} ms`);
</script>

<template>
  <figure class="px-embed not-prose bs">
    <div ref="root" class="bs-measure" />
    <figcaption class="bs-cap">
      <span><b>{{ title }}</b>, milliseconds, log scale</span>
      <span class="bs-legend">
        <span><i class="base" />{{ legend[0] }}</span>
        <span><i class="hit" />{{ legend[1] }}</span>
      </span>
    </figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="title">
      <g v-for="t in ticks" :key="t">
        <line :x1="x(t)" :x2="x(t)" y1="0" :y2="H - 22" class="grid" />
        <text :x="x(t)" :y="H - 6" text-anchor="middle" class="axis">{{ t }} ms</text>
      </g>
      <g
        v-for="(r, i) in rows"
        :key="r.label"
        :transform="`translate(0 ${(narrow ? 32 : 18) + i * rowH})`"
      >
        <title>{{ `${r.label}: ${fmt(r.before)} → ${fmt(r.after)}` }}</title>
        <rect x="0" :y="narrow ? -28 : -16" :width="W" :height="narrow ? 44 : 32" class="hitbox" />
        <text x="0" :y="narrow ? -12 : 4" class="label">{{ r.label }}</text>
        <line :x1="x(r.after)" :x2="x(r.before)" y1="0" y2="0" class="link" />
        <circle :cx="x(r.before)" cy="0" r="5" class="base" />
        <circle :cx="x(r.after)" cy="0" r="6" class="hit" />
        <text :x="x(r.before) + 11" y="4" class="val">
          {{ Math.round(r.before / r.after) }}× faster
        </text>
      </g>
    </svg>
  </figure>
</template>

<style scoped>
.bs {
  margin: 20px 0;
  padding: 16px 18px 12px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: var(--panel2);
}
.bs-cap {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--ink3);
}
.bs-cap b {
  color: var(--ink);
  font-weight: 600;
}
.bs-legend {
  display: flex;
  gap: 14px;
}
.bs-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border-radius: 50%;
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
.val {
  font-size: 12px;
  fill: var(--ink2);
}
.link {
  stroke: var(--line2);
  stroke-width: 2;
}
.hit,
.bs-legend .hit {
  fill: var(--hit);
  background: var(--hit);
  stroke: var(--panel2);
  stroke-width: 2;
}
.base,
.bs-legend .base {
  fill: var(--ink3);
  background: var(--ink3);
  stroke: var(--panel2);
  stroke-width: 2;
}
.bs-measure {
  height: 0;
}
.hitbox {
  fill: transparent;
}
</style>
