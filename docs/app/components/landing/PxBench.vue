<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { type Colors, inView, prefersReducedMotion, seeded, useFrame, useThemeColors } from "./px";

defineProps<{ bare?: boolean }>();

/* Benchmark medians drawn in pixels: dim pixels are 2.4.1, bright pixels are today.
   When the chart enters the screen, the pixels above today's time fall away. */
const ROWS = [
  { name: "Page, no count", stmts: "1 → 1 statement", before: 38.59, after: 0.67 },
  { name: "Page + exact count", stmts: "2 → 2", before: 48.48, after: 5.02 },
  { name: "Relation search", stmts: "2 → 2", before: 167.35, after: 43.38 },
  { name: "3 root facets", stmts: "3 → 1", before: 84.85, after: 24.57 },
  { name: "5 mixed facets", stmts: "5 → 2", before: 194.66, after: 56.53 },
  { name: "Exclude-self facets", stmts: "5 → 3", before: 127.51, after: 35.12 },
];
const CELL = 6;
const MS_PER_ROW = 5;
const HEIGHT = 260;

const canvas = ref<HTMLCanvasElement | null>(null);
const shown = reactive(ROWS.map((r) => ({ ms: r.before, ratio: 1 })));
let ctx: CanvasRenderingContext2D | null = null;
let colors: Colors | undefined;
let width = 0;
let start = 0;
let running = false;
let last: number[] = ROWS.map(() => Infinity);
let falling: { x: number; y: number; vx: number; vy: number }[] = [];
const rnd = seeded(5);

function resize() {
  if (!canvas.value || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  width = canvas.value.parentElement!.clientWidth - 40;
  canvas.value.width = width * dpr;
  canvas.value.height = HEIGHT * dpr;
  canvas.value.style.height = `${HEIGHT}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function replay() {
  last = ROWS.map(() => Infinity);
  falling = [];
  start = performance.now();
  running = true;
}

useThemeColors((c) => (colors = c));
onMounted(() => {
  ctx = canvas.value!.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  if (prefersReducedMotion()) {
    running = true;
    start = -1e9;
  }
});
onBeforeUnmount(() => window.removeEventListener("resize", resize));

useFrame((now) => {
  if (!ctx || !colors || !width || !canvas.value || !inView(canvas.value)) return;
  if (!running && canvas.value.getBoundingClientRect().top < window.innerHeight * 0.75) replay();
  const t = running ? Math.min(Math.max((now - start - 300) / 2200, 0), 1) : 0;
  const e = 1 - Math.pow(1 - t, 3);
  ctx.clearRect(0, 0, width, HEIGHT);
  const colW = width / ROWS.length;
  const cols = Math.max(3, Math.floor((colW - 16) / CELL));
  ROWS.forEach((r, i) => {
    const x0 = i * colW + (colW - cols * CELL) / 2;
    const oldRows = Math.round(r.before / MS_PER_ROW);
    const newRows = Math.max(1, Math.round(r.after / MS_PER_ROW));
    const cur = Math.round(oldRows + (newRows - oldRows) * e);
    for (let row = 0; row < oldRows; row++) {
      const lit = row < cur;
      ctx!.fillStyle = lit ? colors!.hit : colors!.ink3;
      ctx!.globalAlpha = lit ? 0.95 : 0.22;
      for (let c = 0; c < cols; c++)
        ctx!.fillRect(x0 + c * CELL, HEIGHT - (row + 1) * CELL, CELL - 1.5, CELL - 1.5);
    }
    if (cur < last[i]! && last[i] !== Infinity) {
      for (let row = cur; row < last[i]!; row++)
        for (let c = 0; c < cols; c++)
          if (rnd() < 0.5)
            falling.push({
              x: x0 + c * CELL,
              y: HEIGHT - (row + 1) * CELL,
              vx: (rnd() - 0.5) * 0.8,
              vy: -rnd() * 0.8,
            });
    }
    last[i] = cur;
    const ms = r.before + (r.after - r.before) * e;
    shown[i]!.ms = ms;
    shown[i]!.ratio = r.before / ms;
  });
  ctx.fillStyle = colors.hit;
  ctx.globalAlpha = 0.8;
  falling = falling.filter((p) => {
    p.vy += 0.25;
    p.y += p.vy;
    p.x += p.vx;
    ctx!.fillRect(p.x, p.y, CELL - 1.5, CELL - 1.5);
    return p.y < HEIGHT;
  });
  ctx.globalAlpha = 1;
});
</script>

<template>
  <section class="px-blk" :class="{ 'px-bare': bare }">
    <div v-if="!bare" class="px-head">
      <h2><span class="px-acc">Benchmarks</span></h2>
      <p class="px-lede">
        Median timings from the repository's PostgreSQL benchmark: 200,000 rows, PostgreSQL 18, one
        client. Dim pixels show version 2.4.1, bright pixels the current version.
      </p>
    </div>
    <div class="px-panel px-bench">
      <div class="px-win-h">
        <i />Median latency<small>200,000 rows · PostgreSQL 18 · 1 client</small>
      </div>
      <button type="button" class="px-btn px-btn-o px-replay" @click="replay">↻ replay</button>
      <canvas ref="canvas" aria-label="Benchmark chart: median times before and after" role="img" />
      <div class="px-blabels">
        <div v-for="(r, i) in ROWS" :key="r.name">
          <b class="px-pix">{{ shown[i]!.ratio.toFixed(1) }}×</b>{{ r.name }}
          <small
            >{{ shown[i]!.ms < 10 ? shown[i]!.ms.toFixed(2) : shown[i]!.ms.toFixed(1) }} ms</small
          >
          <small>{{ r.stmts }}</small>
        </div>
      </div>
      <p class="px-src">
        Source:
        <NuxtLink to="/scale/benchmarks">benchmark results</NuxtLink>, run of September 21, 2026.
        Single-client engine timings, not HTTP or production latency.
      </p>
    </div>
  </section>
</template>
