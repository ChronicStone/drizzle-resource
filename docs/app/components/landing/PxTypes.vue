<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { inView, prefersReducedMotion } from "./px";

defineProps<{ bare?: boolean }>();

/* Type a filter path: autocomplete and errors come from the same union your editor sees. */
const PATHS: [string, string][] = [
  ["reference", "string"],
  ["status", "string"],
  ["totalAmount", "number"],
  ["createdAt", "string"],
  ["customer.name", "string"],
  ["customer.displayName", "string · virtual"],
  ["orderLines.quantity", "number"],
  ["orderLines.product.name", "string"],
  ["orderLines.product.category", "string"],
  ["orderLines.product.sku", "string"],
  ["orderLines.product.label", "string"],
];
const TRIES = [
  { path: "orderLines.product.category", text: "Two relations deep, still typed" },
  { path: "custmer.name", text: "One letter off" },
  { path: "deletedAt", text: "A private field" },
  { path: "customer.displayName", text: "A virtual SQL field" },
];

const input = ref<HTMLInputElement | null>(null);
const value = ref("orderLines.product.category");
const focused = ref(false);
const selected = ref(0);
let userTouched = false;
let typing = 0;
let timer = 0;

function distance(a: string, b: string) {
  const m = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let prev = m[0]!;
    m[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = m[j]!;
      m[j] = Math.min(m[j]! + 1, m[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return m[b.length]!;
}

const exact = computed(() => PATHS.find((p) => p[0] === value.value));
const matches = computed(() =>
  PATHS.filter((p) => p[0].startsWith(value.value) && p[0] !== value.value).slice(0, 6),
);
const showList = computed(() => focused.value && !!value.value && matches.value.length > 0);
const diag = computed(() => {
  const v = value.value;
  if (exact.value) {
    const t = exact.value[1].split(" ")[0];
    return {
      kind: "ok",
      main: `${v} is a valid filter path.`,
      small: `value is typed as ${t}${exact.value[1].includes("virtual") ? " · a virtual field computed in SQL, filterable like any column" : ""}`,
    };
  }
  if (!v)
    return {
      kind: "",
      main: "Start typing a field path, for example cu or orderLines.",
      small: "suggestions come from your schema and relations",
    };
  if (matches.value.length)
    return {
      kind: "",
      main: `${matches.value.length} path${matches.value.length > 1 ? "s" : ""} start with "${v}"`,
      small: "↑ ↓ to choose, Enter to accept",
    };
  if (v === "deletedAt")
    return {
      kind: "err",
      main: `Type '"deletedAt"' is not assignable to type OrderFilterKey.`,
      small: "ts(2322) · deletedAt is private on the engine, so it is not a query path",
    };
  const near = PATHS.map((p) => [p[0], distance(v, p[0])] as const).sort((a, b) => a[1] - b[1])[0]!;
  return {
    kind: "err",
    main: `Type '"${v}"' is not assignable to type '"reference" | "status" | "totalAmount" | "createdAt" | "customer.name" | …'.`,
    small: `ts(2322)${near[1] <= 3 ? ` · closest path: ${near[0]}` : ""}`,
  };
});

function accept(p: string) {
  value.value = p;
  selected.value = 0;
}
function onKey(e: KeyboardEvent) {
  if (!showList.value) return;
  const n = matches.value.length;
  if (e.key === "ArrowDown") selected.value = (selected.value + 1) % n;
  else if (e.key === "ArrowUp") selected.value = (selected.value - 1 + n) % n;
  else if (e.key === "Enter" || e.key === "Tab") accept(matches.value[selected.value]![0]);
  else return;
  e.preventDefault();
}
function typeOut(path: string) {
  const mine = ++typing;
  value.value = "";
  focused.value = true;
  let i = 0;
  const step = () => {
    if (mine !== typing) return;
    value.value = path.slice(0, ++i);
    if (i < path.length) window.setTimeout(step, 70 + Math.random() * 60);
    else window.setTimeout(() => mine === typing && (focused.value = false), 1000);
  };
  window.setTimeout(step, 200);
}
function tryPath(p: string) {
  userTouched = true;
  typeOut(p);
}
onMounted(() => {
  if (prefersReducedMotion()) return;
  let i = 0;
  timer = window.setInterval(() => {
    if (userTouched || !input.value || !inView(input.value)) return;
    typeOut(["orderLines.product.category", "custmer.name", "deletedAt"][i++ % 3]!);
  }, 7500);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <section class="px-blk" :class="{ 'px-bare': bare }">
    <div v-if="!bare" class="px-head">
      <h2>Field paths are typed <span class="px-acc">from your schema</span></h2>
      <p class="px-lede">
        Filter keys, sort keys and facet paths are derived from your tables and relations, nested
        ones included. Try a path below; the errors match what TypeScript reports.
      </p>
    </div>
    <div class="px-typer">
      <div class="px-ed">
        <div class="px-win-h"><i />Your editor<small>orders.controller.ts</small></div>
        <div class="l">
          <span class="t-k">await</span> orders.<span class="t-f">query</span>({ request: {
        </div>
        <div class="l i1">filters: [{ type: <span class="t-s">"condition"</span>,</div>
        <div class="l i2">
          key: <span class="t-s">"</span
          ><input
            ref="input"
            v-model="value"
            :class="{ ok: exact, err: diag.kind === 'err' }"
            :style="{ width: `${Math.max(18, value.length + 2)}ch` }"
            autocomplete="off"
            spellcheck="false"
            aria-label="Filter key"
            @focus="((focused = true), (userTouched = true), typing++)"
            @blur="focused = false"
            @input="((userTouched = true), (selected = 0))"
            @keydown="onKey"
          /><span class="t-s">"</span>,
        </div>
        <div class="l i2">
          operator: <span class="t-s">"is"</span>, value:
          <span class="t-c">/* {{ exact ? exact[1].split(" ")[0] : "…" }} */</span> }],
        </div>
        <div class="l">} });</div>
        <div v-if="showList" class="px-dd">
          <button
            v-for="(p, i) in matches"
            :key="p[0]"
            type="button"
            :class="{ on: i === selected }"
            @mousedown.prevent="accept(p[0])"
          >
            {{ value }}<b>{{ p[0].slice(value.length) }}</b
            ><i>{{ p[1] }}</i>
          </button>
          <div class="ft">deletedAt is private and never offered</div>
        </div>
        <div class="px-diag" :class="diag.kind">
          {{ diag.main }}<small>{{ diag.small }}</small>
        </div>
      </div>
      <div class="px-tries">
        <button v-for="t in TRIES" :key="t.path" type="button" @click="tryPath(t.path)">
          <code>{{ t.path }}</code
          ><span>{{ t.text }}</span
          ><i>try →</i>
        </button>
      </div>
    </div>
  </section>
</template>
