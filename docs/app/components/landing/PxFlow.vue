<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { hl, inView, prefersReducedMotion } from "./px";

defineProps<{ bare?: boolean }>();

/*
 * A request falls through the five engine steps. Three scenarios: a normal request,
 * a field the resource doesn't allow (stops at validation), and an attempt at another tenant's data.
 */
type Tone = "ok" | "bad" | "";
interface Step {
  text: string;
  lang: "ts" | "sql";
  tone?: Tone;
}
interface Scenario {
  name: string;
  request: string;
  steps: (Step | null)[];
  response: string;
  meta: string;
  stopsAt?: number;
}

const LAYERS = [
  ["01", "scope"],
  ["02", "validate"],
  ["03", "page ids"],
  ["04", "rows"],
  ["05", "facets & totals"],
] as const;

const SCENARIOS: Scenario[] = [
  {
    name: "a normal request",
    request: `{ search: { value: "halv" },
  filters: [{ key: "status", operator: "is", value: "shipped" }],
  facets: [{ key: "status" }], summary: true }`,
    steps: [
      { text: 'where c."org_id" = $1 and ( … )   -- tenant from ctx', lang: "sql" },
      { text: "keys, operators and paths allowed", lang: "ts", tone: "ok" },
      { text: 'select "id" … limit 26   -- 0.67 ms', lang: "sql" },
      { text: '25 rows · view "list" · relations in the same statement', lang: "ts" },
      { text: "grouping sets → status buckets + revenue", lang: "sql" },
    ],
    response: `{ rows: [ /* 25 typed rows */ ],
  pageInfo: { nextCursor: "eyJrIjox…" },
  facets: { status: [ /* 4 buckets */ ] },
  summary: { revenue: "411230" } }`,
    meta: "200 · 2 statements",
  },
  {
    name: "a field you didn't allow",
    request: `{ filters: [{ key: "customer.email",
  operator: "contains", value: "@" }] }`,
    steps: [
      { text: 'where c."org_id" = $1 and ( … )', lang: "sql" },
      { text: 'Unknown filter field "customer.email"', lang: "ts", tone: "bad" },
      null,
      null,
      null,
    ],
    response: `{ status: 400,
  issues: [{ path: ["filters", 0, "key"],
    message: "Unknown filter field" }] }`,
    meta: "400 · no SQL ran",
    stopsAt: 1,
  },
  {
    name: "another tenant's data",
    request: `{ filters: [{ type: "group", combinator: "or",
  children: [ … orgId: "globex" … ] }] }`,
    steps: [
      { text: `where c."org_id" = 'acme' and ( … or … )`, lang: "sql" },
      { text: "allowed, but it can only narrow", lang: "ts", tone: "ok" },
      { text: 'select "id" … limit 26', lang: "sql" },
      { text: "0 rows from globex", lang: "ts" },
      { text: "buckets for acme only", lang: "ts" },
    ],
    response: `{ rows: [],
  pageInfo: { nextCursor: null },
  facets: { status: [] } }   // still acme`,
    meta: "200 · scope held",
  },
];

const current = ref(0);
const reached = ref(-1);
const shownResponse = ref(false);
const layersEl = ref<HTMLElement | null>(null);
const drop = ref({ top: -14, left: 58, bad: false, out: false });
let timers: number[] = [];
let touched = false;

function clear() {
  timers.forEach((t) => window.clearTimeout(t));
  timers = [];
}
function at(ms: number, fn: () => void) {
  timers.push(window.setTimeout(fn, ms));
}
function layerCenter(i: number) {
  const row = layersEl.value?.querySelectorAll<HTMLElement>(".px-layer")[i];
  return row ? row.offsetTop + row.offsetHeight / 2 - 5 : 0;
}

function run(i: number) {
  clear();
  current.value = i;
  const s = SCENARIOS[i]!;
  const last = s.stopsAt ?? LAYERS.length - 1;
  reached.value = -1;
  shownResponse.value = false;
  drop.value = { top: -14, left: 58, bad: false, out: false };
  const reduce = prefersReducedMotion();
  const step = reduce ? 0 : 700;
  for (let k = 0; k <= last; k++) {
    at(300 + k * step, () => {
      reached.value = k;
      const bad = s.stopsAt === k;
      drop.value = { top: layerCenter(k), left: 58, bad, out: false };
      if (bad) at(500, () => (drop.value = { ...drop.value, out: true, top: layerCenter(k) - 30 }));
    });
  }
  at(300 + (last + 1) * step, () => (shownResponse.value = true));
  at(300 + (last + 1) * step + 3400, () => {
    if (!touched && !reduce && layersEl.value && inView(layersEl.value))
      run((i + 1) % SCENARIOS.length);
    else if (!touched && !reduce) at(1500, () => run((i + 1) % SCENARIOS.length));
  });
}
function choose(i: number) {
  touched = true;
  run(i);
}
const layerClass = (k: number) => {
  const s = SCENARIOS[current.value]!;
  if (k > reached.value || !s.steps[k]) return "";
  if (s.stopsAt === k) return "bad";
  return k === reached.value && !shownResponse.value ? "on" : "done";
};

const skipped = (k: number) => {
  const stop = SCENARIOS[current.value]!.stopsAt;
  return stop !== undefined && k > stop && reached.value >= stop;
};

onMounted(() => run(0));
onBeforeUnmount(clear);
</script>

<template>
  <section class="px-blk" :class="{ 'px-bare': bare }">
    <div v-if="!bare" class="px-head">
      <h2>How a request <span class="px-acc">is handled</span></h2>
      <p class="px-lede">
        Every request goes through the same five steps. The tenant scope is added on the server,
        unknown fields are rejected before any SQL runs, and compatible facets share one statement.
        Pick a request to follow it.
      </p>
    </div>
    <div class="px-flow">
      <div class="px-flow-io">
        <div class="px-win">
          <div class="px-win-h">
            <i />Client request<small>{{ SCENARIOS[current]!.name }}</small>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-html="hl(SCENARIOS[current]!.request)" />
        </div>
        <div class="px-scen" role="tablist">
          <button
            v-for="(s, i) in SCENARIOS"
            :key="s.name"
            type="button"
            role="tab"
            :aria-selected="i === current"
            :class="{ on: i === current }"
            @click="choose(i)"
          >
            {{ s.name }}
          </button>
        </div>
        <div class="px-win" :class="{ 'px-win-empty': !shownResponse }">
          <div class="px-win-h">
            <i />Response<small>{{ shownResponse ? SCENARIOS[current]!.meta : "waiting…" }}</small>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-if="shownResponse" v-html="hl(SCENARIOS[current]!.response)" />
          <pre v-else class="px-wait">&nbsp;</pre>
        </div>
      </div>

      <div ref="layersEl" class="px-win px-layers">
        <div class="px-win-h"><i />Engine<small>5 steps, always in this order</small></div>
        <div class="px-layers-body">
          <div
            class="px-drop"
            :class="{ bad: drop.bad, out: drop.out }"
            :style="{ top: `${drop.top + 37}px` }"
            aria-hidden="true"
          />
          <div v-for="(l, k) in LAYERS" :key="l[0]" class="px-layer" :class="layerClass(k)">
            <div class="px-layer-n"><em class="px-pix">{{ l[0] }}</em>{{ l[1] }}</div>
            <div class="px-layer-o">
              <template v-if="k <= reached && SCENARIOS[current]!.steps[k]">
                <span v-if="SCENARIOS[current]!.steps[k]!.tone === 'ok'" class="px-ok">✓ </span>
                <span v-if="SCENARIOS[current]!.steps[k]!.tone === 'bad'" class="px-bad">✕ </span>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <span
                  :class="{ 'px-bad': SCENARIOS[current]!.steps[k]!.tone === 'bad' }"
                  v-html="
                    SCENARIOS[current]!.steps[k]!.tone === 'bad'
                      ? SCENARIOS[current]!.steps[k]!.text
                      : hl(SCENARIOS[current]!.steps[k]!.text, SCENARIOS[current]!.steps[k]!.lang)
                  "
                />
              </template>
              <span v-else-if="skipped(k)" class="px-skip">skipped, no SQL ran</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
