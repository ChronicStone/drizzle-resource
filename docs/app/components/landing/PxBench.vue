<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { type Colors, inView, prefersReducedMotion, seeded, useFrame, useThemeColors } from "./px";

defineProps<{ bare?: boolean }>();

/* Benchmark medians drawn in pixels: dim pixels are 2.4.1, bright pixels are today.
   When the chart enters the screen, the pixels above today's time fall away. */
const ROWS = [
  { name: "Page, no count", stmts: "statements: 1 → 1", before: 39.95, after: 0.51 },
  { name: "Page + exact count", stmts: "statements: 2 → 2", before: 62.46, after: 4.17 },
  { name: "Relation search", stmts: "statements: 2 → 2", before: 79.46, after: 16.8 },
  { name: "3 root facets", stmts: "statements: 3 → 1", before: 90.03, after: 24.76 },
  { name: "5 mixed facets", stmts: "statements: 5 → 2", before: 195.04, after: 57.38 },
  { name: "Exclude-self facets", stmts: "statements: 5 → 3", before: 138.22, after: 35.84 },
];
const CELL = 6;
const MS_PER_ROW = 5;
const HEIGHT = 260;

const canvas = ref<HTMLCanvasElement | null>(null);
/* The server renders today's times, so readers without JavaScript (and crawlers) see current numbers.
   The browser rewinds to 2.4.1 on mount, then counts down once the chart is in view. */
const shown = reactive(ROWS.map((r) => ({ ms: r.after, ratio: r.before / r.after })));
/* today's time leads; the pixel font's dot reads as a plus, so the point is drawn apart */
const split = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)).split(".");
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
  } else {
    ROWS.forEach((r, i) => Object.assign(shown[i]!, { ms: r.before, ratio: 1 }));
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
        client. Bright pixels are today's time; dim pixels show what version 2.4.1 took.
      </p>
    </div>
    <div class="px-panel px-bench">
      <div class="px-win-h">
        <i />Median latency, ms<small>200,000 rows · PostgreSQL 18 · 1 client</small>
      </div>
      <button type="button" class="px-btn px-btn-o px-replay" @click="replay">↻ replay</button>
      <canvas ref="canvas" aria-label="Benchmark chart: median times before and after" role="img" />
      <div class="px-blabels">
        <div v-for="(r, i) in ROWS" :key="r.name">
          <b class="px-pix"
            >{{ split(shown[i]!.ms)[0] }}<span class="px-bdot">.</span>{{ split(shown[i]!.ms)[1]
            }}<em>ms</em></b
          >{{ r.name }}
          <small>2.4.1: {{ r.before }} ms</small>
          <small>{{ r.stmts }}</small>
        </div>
      </div>
      <p class="px-src">
        Source:
        <NuxtLink to="/scale/benchmarks">benchmark results</NuxtLink>, run of November 18, 2026.
        Single-client engine timings, not HTTP or production latency.
      </p>
    </div>
  </section>
</template>
