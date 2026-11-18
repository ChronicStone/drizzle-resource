<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { PixelBoard, hl, readColors, useFrame, useThemeColors } from "./px";

/* Four steps to a first endpoint, then a closing board you can click to make it rain. */
const STEPS = [
  { title: "Install", code: "bun add drizzle-resource" },
  {
    title: "Create the engine once",
    code: 'import { createQueryEngine } from "drizzle-resource";\n\nexport const engine = createQueryEngine({ db, schema, relations })\n  .withContext<{ orgId: string }>();',
  },
  {
    title: "Define a resource per table",
    code: 'export const orders = engine.defineResource("orders", {\n  relations: { customer: true },\n  query: {\n    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),\n    search: { allowed: ["reference", "customer.name"] },\n    facets: { allowed: ["status"] },\n  },\n});',
  },
  {
    title: "Validate the request in your endpoint",
    code: 'const Request = requestSchema(orders); // zod, valibot or vine\n\napp.post("/orders/query", async (c) => {\n  const request = Request.parse(await c.req.json());\n  return c.json(await orders.query({ request, context }));\n});',
  },
];

const canvas = ref<HTMLCanvasElement | null>(null);
let board: PixelBoard | undefined;
const resize = () => board?.resize();
useThemeColors((c) => board?.setColors(c));
onMounted(() => {
  board = new PixelBoard(canvas.value!, 22, 9);
  board.setColors(readColors());
  board.resize();
  board.show("__mark", true);
  document.fonts?.ready.then(() => board?.resize());
  window.addEventListener("resize", resize);
});
onBeforeUnmount(() => window.removeEventListener("resize", resize));
useFrame((t) => board?.tick(t));
</script>

<template>
  <section class="px-blk">
    <div class="px-head">
      <h2><span class="px-acc">Getting started</span></h2>
      <p class="px-lede">
        Install the package, create the engine once, define a resource per table, and validate
        incoming requests with the schema it generates.
      </p>
    </div>
    <div class="px-steps">
      <div v-for="(s, i) in STEPS" :key="s.title" class="px-panel px-step">
        <div class="h">
          <em class="px-pix">0{{ i + 1 }}</em>
          <h3>{{ s.title }}</h3>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <pre v-html="hl(s.code)" />
      </div>
    </div>
  </section>

  <section class="px-final">
    <div class="px-board">
      <div class="px-board-h"><span class="px-led" /><span>drizzle-resource</span></div>
      <canvas ref="canvas" class="px-board-end" aria-hidden="true" @click="board?.burst()" />
    </div>
    <div class="px-ctas px-ctas-center">
      <NuxtLink class="px-btn px-btn-y" to="/start/quick-start">Read the quick start →</NuxtLink>
      <NuxtLink class="px-btn px-btn-o" to="/playground">Open the playground</NuxtLink>
    </div>
  </section>
</template>
