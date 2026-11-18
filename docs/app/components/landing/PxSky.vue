<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { type Colors, prefersReducedMotion, seeded, useFrame, useThemeColors } from "./px";

/* Sparse pixel rain behind the landing. The cursor holds a pixel umbrella; drops splash off it. */
const canvas = ref<HTMLCanvasElement | null>(null);
const GRID = 14;
const UMBRELLA = [
  "....#####....",
  "..#########..",
  ".###########.",
  "#############",
  "#.#.#.#.#.#.#",
  "......#......",
  "......#......",
  "......#......",
  "....#.#......",
  "....###......",
];
const UC = 4;
const UW = 13 * UC;
const CANOPY_TOP = Array.from({ length: 13 }, (_, c) => {
  for (let r = 0; r < 5; r++) if (UMBRELLA[r]![c] === "#") return r;
  return -1;
});

let ctx: CanvasRenderingContext2D | null = null;
let colors: Colors | undefined;
let w = 0;
let h = 0;
let reduce = false;
let px = -999;
let py = -999;
let pointer = false;
const rnd = seeded(3);
let drops: { c: number; y: number; v: number; n: number }[] = [];
let bits: { x: number; y: number; vx: number; vy: number; l: number }[] = [];

function resize() {
  if (!canvas.value || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.value.width = w * dpr;
  canvas.value.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const onMove = (e: PointerEvent) => {
  if (e.pointerType === "touch") return;
  px = e.clientX;
  py = e.clientY;
  pointer = true;
};
const onLeave = () => (pointer = false);

useThemeColors((c) => (colors = c));
onMounted(() => {
  ctx = canvas.value!.getContext("2d");
  reduce = prefersReducedMotion();
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onMove);
  document.addEventListener("pointerleave", onLeave);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", resize);
  window.removeEventListener("pointermove", onMove);
  document.removeEventListener("pointerleave", onLeave);
});

useFrame(() => {
  if (!ctx || !colors || reduce) return;
  ctx.clearRect(0, 0, w, h);
  if (rnd() < (0.55 * w) / 1300) {
    drops.push({
      c: Math.floor((rnd() * w) / GRID),
      y: -60,
      v: 3.2 + rnd() * 2.6,
      n: 3 + Math.floor(rnd() * 5),
    });
  }
  const ux = px - UW / 2;
  const uy = py - 46;
  drops = drops.filter((d) => {
    const y0 = d.y;
    d.y += d.v;
    const x = d.c * GRID + GRID / 2;
    if (pointer) {
      const uc = Math.floor((x - ux) / UC);
      const top = CANOPY_TOP[uc];
      if (top !== undefined && top >= 0) {
        const cy = uy + top * UC;
        if (y0 < cy && d.y >= cy) {
          for (let i = 0; i < 3; i++)
            bits.push({
              x,
              y: cy - 2,
              vx: (x < px ? -1 : 1) * (0.6 + rnd() * 1.4),
              vy: -1.2 - rnd() * 1.2,
              l: 1,
            });
          return false;
        }
      }
    }
    if (d.y - d.n * 6 > h) return false;
    ctx!.fillStyle = colors!.rain;
    for (let i = 0; i < d.n; i++) {
      const yy = d.y - i * 6;
      if (yy < -4) continue;
      ctx!.globalAlpha = (1 - i / d.n) * 0.9;
      ctx!.fillRect(Math.round(x - 1), Math.round(yy), 2, 2);
    }
    return true;
  });
  ctx.fillStyle = colors.hit;
  bits = bits.filter((b) => {
    b.vy += 0.12;
    b.x += b.vx;
    b.y += b.vy;
    b.l -= 0.035;
    ctx!.globalAlpha = Math.max(b.l, 0);
    ctx!.fillRect(Math.round(b.x), Math.round(b.y), 2, 2);
    return b.l > 0;
  });
  if (pointer) {
    UMBRELLA.forEach((row, r) =>
      [...row].forEach((ch, c) => {
        if (ch !== "#") return;
        ctx!.globalAlpha = r < 5 ? 0.95 : 0.6;
        ctx!.fillRect(ux + c * UC, uy + r * UC, UC - 1, UC - 1);
      }),
    );
  }
  ctx.globalAlpha = 1;
});
</script>

<template>
  <canvas ref="canvas" class="px-sky" aria-hidden="true" />
</template>
