<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { fmt, prefersReducedMotion, seeded } from "./px";

/*
 * The six stages every request goes through, all visible at once on one track from request to
 * response. A glowing packet travels the track; each stage card plays a small diagram of what
 * that stage does when the packet reaches it. Three requests: a normal one, one naming a field
 * the resource doesn't allow (rejected at validation), and one asking for another tenant's data.
 */
type StepId = "validate" | "scope" | "count" | "ids" | "rows" | "facets";
const STEPS: { id: StepId; label: string; text: string }[] = [
  {
    id: "validate",
    label: "Validate",
    text: "Every key, operator and path is checked against the resource.",
  },
  {
    id: "scope",
    label: "Scope",
    text: "The tenant condition comes from your server, never from the client.",
  },
  {
    id: "count",
    label: "Count",
    text: "One count over every match, for the pager or your own totals.",
  },
  { id: "ids", label: "Page ids", text: "Filters, search and sort pick only this page's ids." },
  {
    id: "rows",
    label: "Rows",
    text: "The rows load by id with their relations, in your view's shape.",
  },
  { id: "facets", label: "Facets", text: "Bucket counts per value, each ignoring its own filter." },
];

interface Chip {
  text: string;
  ok: boolean;
}
interface Scenario {
  name: string;
  short: string;
  request: string;
  chips: Chip[];
  clause?: string;
  total: number;
  ids: number;
  rows: { ref: string }[];
  buckets: [string, number][];
  stopsAt?: number;
  response: string;
  status: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "A normal request",
    short: "Normal",
    request: 'search "halv" · status is shipped',
    chips: [
      { text: "search", ok: true },
      { text: "status", ok: true },
      { text: "is", ok: true },
      { text: "totalAmount", ok: true },
      { text: "facets.status", ok: true },
    ],
    clause: "status = 'shipped'",
    total: 1240,
    ids: 25,
    rows: [{ ref: "ORD-29999" }, { ref: "ORD-29987" }, { ref: "ORD-29959" }],
    buckets: [
      ["shipped", 1240],
      ["processing", 526],
      ["pending", 459],
      ["cancelled", 187],
    ],
    response: "25 rows · 1,240 total · 4 buckets",
    status: "200",
  },
  {
    name: "A field you didn't allow",
    short: "Bad field",
    request: 'customer.email contains "@"',
    chips: [
      { text: "customer.email", ok: false },
      { text: "contains", ok: true },
    ],
    total: 0,
    ids: 0,
    rows: [],
    buckets: [],
    stopsAt: 0,
    response: "Unknown filter field · no SQL ran",
    status: "400",
  },
  {
    name: "Another tenant's orders",
    short: "Tenant",
    request: 'customer.orgId is "globex"',
    chips: [
      { text: "customer.orgId", ok: true },
      { text: "is", ok: true },
    ],
    clause: "org_id = 'globex'",
    total: 0,
    ids: 0,
    rows: [],
    buckets: [
      ["shipped", 0],
      ["processing", 0],
      ["pending", 0],
      ["cancelled", 0],
    ],
    response: "0 rows · still acme's data",
    status: "200",
  },
];

/* chip layout for the validate diagram: wrap mono chips across 168px */
const CH = 6;
function layoutChips(chips: Chip[]) {
  const out: (Chip & { x: number; y: number; w: number })[] = [];
  let x = 0;
  let y = 0;
  for (const c of chips) {
    const w = c.text.length * CH + 32;
    if (x + w > 168 && x > 0) {
      x = 0;
      y += 26;
    }
    out.push({ ...c, x, y, w });
    x += w + 6;
  }
  return out;
}

/* count diagram: 10,000 orders as 84 dots */
const DOTS = Array.from({ length: 84 }, (_, i) => ({ c: i % 12, r: Math.floor(i / 12) }));
const LIT = SCENARIOS.map((s, i) => {
  const rnd = seeded(7 + i);
  const n = Math.round((s.total / 10000) * DOTS.length * 2.4);
  const set = new Set<number>();
  while (set.size < n) set.add(Math.floor(rnd() * DOTS.length));
  return { set, delay: DOTS.map(() => Math.round(rnd() * 1100)) };
});
const BARS = Array.from({ length: 14 }, (_, i) => 56 - i * 3.4);

/* ---------- run ---------- */
const current = ref(0);
const runId = ref(0);
const step = ref(-1);
const done = ref(false);
const packetAt = ref(-1); // -1 request, 0..5 stages, 6 response
const count = ref(0);
const reached = ref(-1); // the last node the packet has pinged
const landed = ref(false);
const moving = ref(false);
const px = ref(8);
const flow = ref<HTMLElement | null>(null);
const geo = reactive({ w: 1000, ty: 80, h: 200, nodes: [] as { x: number; top: number }[] });
let timers: number[] = [];
let pxRaf = 0;
let resizeObs: ResizeObserver | undefined;
let raf = 0;
let touched = false;
let visible = false;
let observer: IntersectionObserver | undefined;
const root = ref<HTMLElement | null>(null);

const S = computed(() => SCENARIOS[current.value]!);
const last = computed(() => S.value.stopsAt ?? STEPS.length - 1);
const failed = computed(() => S.value.stopsAt !== undefined && step.value >= S.value.stopsAt);
const chips = computed(() => layoutChips(S.value.chips));
const bucketMax = computed(() => Math.max(1, ...S.value.buckets.map((b) => b[1])));

const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
function clear() {
  timers.forEach((t) => window.clearTimeout(t));
  timers = [];
  cancelAnimationFrame(raf);
  cancelAnimationFrame(pxRaf);
  moving.value = false;
}

/* geometry of the track, measured from the real cards */
function measure() {
  const f = flow.value;
  if (!f) return;
  const fr = f.getBoundingClientRect();
  const tr = f.querySelector(".pl-track")!.getBoundingClientRect();
  geo.w = fr.width;
  geo.ty = tr.top - fr.top + tr.height / 2;
  geo.nodes = [...f.querySelectorAll(".pl-card")].map((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left - fr.left + r.width / 2, top: r.top - fr.top };
  });
  geo.h = Math.max(geo.ty + 20, ...geo.nodes.map((n) => n.top + 4));
  px.value = posFor(packetAt.value);
}
const posFor = (k: number) => (k < 0 ? 8 : k >= STEPS.length ? geo.w - 8 : (geo.nodes[k]?.x ?? 0));
/* the packet glides with an ease-in-out instead of jumping between nodes */
function glide(k: number, ms = 1000) {
  packetAt.value = k;
  cancelAnimationFrame(pxRaf);
  const from = px.value;
  const t0 = performance.now();
  moving.value = true;
  const tick = (now: number) => {
    const to = posFor(k);
    const t = Math.min(1, (now - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    px.value = from + (to - from) * e;
    if (t < 1) pxRaf = requestAnimationFrame(tick);
    else moving.value = false;
  };
  pxRaf = requestAnimationFrame(tick);
}
function countTo(target: number) {
  cancelAnimationFrame(raf);
  const t0 = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - t0) / 1400);
    count.value = target * (1 - (1 - t) ** 3);
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

const STEP_MS = 3100;
function run(i: number) {
  clear();
  current.value = i;
  runId.value++;
  step.value = -1;
  reached.value = -1;
  done.value = false;
  landed.value = false;
  packetAt.value = -1;
  px.value = posFor(-1);
  count.value = 0;
  const s = SCENARIOS[i]!;
  const end = s.stopsAt ?? STEPS.length - 1;
  if (prefersReducedMotion()) {
    step.value = end;
    reached.value = end;
    packetAt.value = s.stopsAt ?? 6;
    px.value = posFor(packetAt.value);
    count.value = s.total;
    done.value = true;
    landed.value = s.stopsAt === undefined;
    return;
  }
  for (let k = 0; k <= end; k++) {
    const t = 400 + k * STEP_MS;
    at(t, () => glide(k, k === 0 ? 900 : 1050));
    at(t + (k === 0 ? 900 : 1050), () => (reached.value = k));
    at(t + (k === 0 ? 900 : 1050) + 420, () => {
      step.value = k;
      if (STEPS[k]!.id === "count") countTo(s.total);
    });
  }
  const t = 400 + (end + 1) * STEP_MS;
  if (s.stopsAt === undefined) {
    at(t - 600, () => glide(6, 1100));
    at(t + 500, () => {
      landed.value = true;
      done.value = true;
    });
  } else at(t - 1200, () => (done.value = true));
  at(t + 5000, () => {
    if (touched) return;
    if (visible) run((i + 1) % SCENARIOS.length);
    else at(1500, () => !touched && run((i + 1) % SCENARIOS.length));
  });
}
function choose(i: number) {
  touched = true;
  run(i);
}
function jump(k: number) {
  if (k > last.value) return;
  touched = true;
  clear();
  glide(k, 700);
  landed.value = false;
  at(700, () => (reached.value = k));
  step.value = k;
  done.value = S.value.stopsAt !== undefined;
  if (STEPS[k]!.id === "count") countTo(S.value.total);
  else count.value = k > 2 ? S.value.total : 0;
}

const stateOf = (k: number) => {
  const s = S.value;
  if (s.stopsAt !== undefined && k > s.stopsAt) return step.value >= s.stopsAt ? "skip" : "";
  if (k > step.value) return "";
  if (s.stopsAt === k) return "bad";
  return k === step.value && !done.value ? "on" : "done";
};
onMounted(() => {
  observer = new IntersectionObserver(
    ([e]) => {
      const was = visible;
      visible = !!e?.isIntersecting;
      if (visible && !was && step.value < 0 && !done.value) run(current.value);
    },
    { threshold: 0.35 },
  );
  if (root.value) observer.observe(root.value);
  measure();
  resizeObs = new ResizeObserver(measure);
  if (flow.value) resizeObs.observe(flow.value);
});
onBeforeUnmount(() => {
  clear();
  observer?.disconnect();
  resizeObs?.disconnect();
});
</script>

<template>
  <section class="px-blk">
    <div class="px-head">
      <h2>What happens to <span class="px-acc">a request</span></h2>
      <p class="px-lede">
        Every list request runs the same six stages on your server, in this order. Pick a request
        and follow it through.
      </p>
    </div>

    <div ref="root" class="pl">
      <div class="pl-tabs" role="tablist" aria-label="Requests">
        <button
          v-for="(s, i) in SCENARIOS"
          :key="s.name"
          type="button"
          role="tab"
          :aria-selected="i === current"
          :class="{ on: i === current }"
          @click="choose(i)"
        >
          <span class="px-pix">0{{ i + 1 }}</span
          ><span class="full">{{ s.name }}</span
          ><span class="short">{{ s.short }}</span>
        </button>
      </div>

      <div ref="flow" class="pl-flow">
        <!-- request → response track, drawn in SVG over the cards -->
        <svg
          class="pl-svg"
          :viewBox="`0 0 ${geo.w} ${geo.h}`"
          :style="{ height: `${geo.h}px` }"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="pl-comet" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stop-color="#ffd23f" stop-opacity="0" />
              <stop offset="1" stop-color="#ffd23f" stop-opacity=".95" />
            </linearGradient>
            <linearGradient id="pl-comet-bad" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stop-color="#ff6b4a" stop-opacity="0" />
              <stop offset="1" stop-color="#ff6b4a" stop-opacity=".95" />
            </linearGradient>
            <radialGradient id="pl-core" cx=".35" cy=".35" r=".7">
              <stop offset="0" stop-color="#fffbe6" />
              <stop offset=".5" stop-color="#ffd23f" />
              <stop offset="1" stop-color="#e0a800" />
            </radialGradient>
          </defs>

          <!-- the rail: a hairline, a tick scale under it -->
          <line x1="8" :x2="geo.w - 8" :y1="geo.ty" :y2="geo.ty" class="rail" />
          <line x1="8" :x2="geo.w - 8" :y1="geo.ty + 7" :y2="geo.ty + 7" class="ticks" />

          <!-- the lit part, with data streaming along it -->
          <line x1="8" :x2="px" :y1="geo.ty" :y2="geo.ty" class="lit" :class="{ bad: failed }" />
          <line x1="8" :x2="px" :y1="geo.ty" :y2="geo.ty" class="stream" :class="{ bad: failed }" />
          <rect
            :x="Math.max(8, px - 170)"
            :y="geo.ty - 1.5"
            :width="Math.min(170, px - 8)"
            height="3"
            rx="1.5"
            :fill="failed ? 'url(#pl-comet-bad)' : 'url(#pl-comet)'"
            class="comet"
            :class="{ fade: !moving }"
          />

          <!-- one node per stage, a connector into its card -->
          <g v-for="(n, k) in geo.nodes" :key="k" class="nd" :data-state="stateOf(k)">
            <path
              :d="`M${n.x} ${geo.ty + 9} V ${n.top}`"
              pathLength="1"
              class="conn"
              :class="{ on: reached >= k && stateOf(k) !== 'skip' }"
            />
            <circle
              v-if="reached === k"
              :key="`sp${runId}${k}`"
              :cx="n.x"
              :cy="geo.ty"
              r="2.6"
              class="spark"
              :style="{ '--dy': `${n.top - geo.ty}px` }"
            />
            <circle :cx="n.x" :cy="geo.ty" r="7.5" class="ring" />
            <circle :cx="n.x" :cy="geo.ty" r="3" class="core" />
            <circle
              v-if="reached >= k && stateOf(k) !== 'skip'"
              :key="`rp${runId}${k}`"
              :cx="n.x"
              :cy="geo.ty"
              r="7.5"
              class="ripple"
            />
          </g>

          <!-- the packet -->
          <g
            :transform="`translate(${px} ${geo.ty})`"
            class="pk"
            :class="{ bad: failed, gone: landed }"
          >
            <circle r="15" class="pk-halo" />
            <circle r="6.5" :fill="failed ? '#ff6b4a' : 'url(#pl-core)'" class="pk-core" />
          </g>
          <circle
            v-if="landed"
            :key="`land${runId}`"
            :cx="geo.w - 8"
            :cy="geo.ty"
            r="8"
            class="ripple big"
          />
        </svg>

        <div class="pl-ends">
          <div class="pl-end">
            <b>Request</b>
            <code>{{ S.request }}</code>
          </div>
          <div class="pl-end res" :class="{ show: done, bad: done && S.status === '400' }">
            <b
              >Response <span v-if="done" class="px-pix">{{ S.status }}</span></b
            >
            <code>{{ done ? S.response : "rows · count · facets" }}</code>
          </div>
        </div>
        <div class="pl-track" />

        <!-- the stages -->
        <div class="pl-cards">
          <article
            v-for="(st, k) in STEPS"
            :key="`${runId}-${st.id}`"
            class="pl-card"
            :data-state="stateOf(k)"
            @click="jump(k)"
          >
            <header>
              <span class="px-pix">0{{ k + 1 }}</span>
              <h3>{{ st.label }}</h3>
              <svg class="pl-mark" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="7" />
                <path class="mk-ok" d="M4.8 8.3 L7 10.4 L11.2 5.8" />
                <path class="mk-bad" d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" />
              </svg>
            </header>

            <svg class="pl-viz" viewBox="0 0 168 92" aria-hidden="true">
              <!-- 1. validate: each key gets a verdict -->
              <g v-if="st.id === 'validate'" transform="translate(0 8)">
                <g
                  v-for="(c, n) in chips"
                  :key="c.text"
                  class="v-chip"
                  :class="{ bad: !c.ok }"
                  :style="{ '--n': n }"
                  :transform="`translate(${c.x} ${c.y})`"
                >
                  <rect :width="c.w" height="20" rx="5" class="chip-bg" />
                  <text x="8" y="13.5" class="mono">{{ c.text }}</text>
                  <g :transform="`translate(${c.w - 11} 10)`" class="v-tick">
                    <circle r="5.5" />
                    <path v-if="c.ok" d="M-2.6 0.2 L-0.6 2.1 L2.8 -1.8" />
                    <path v-else d="M-2 -2 L2 2 M2 -2 L-2 2" />
                  </g>
                </g>
                <text v-if="S.stopsAt === 0" x="0" y="78" class="mono warn v-verdict">
                  400 · not in the resource
                </text>
              </g>

              <!-- 2. scope: the session's tenant drops into the WHERE -->
              <g v-else-if="st.id === 'scope'">
                <g class="s-ctx">
                  <rect x="0" y="2" width="118" height="22" rx="6" class="hot" />
                  <path
                    d="M9 7.5 L14 6 L19 7.5 V 12 C 19 15.5 14 18 14 18 C 14 18 9 15.5 9 12 Z"
                    class="shield"
                  />
                  <text x="25" y="17" class="mono strong">orgId = "acme"</text>
                </g>
                <path d="M14 26 V 40" class="s-drop" pathLength="1" />
                <g class="s-sql">
                  <rect x="0" y="44" width="168" height="46" rx="7" class="code" />
                  <text x="9" y="62" class="mono kw">where</text>
                  <g class="s-clause">
                    <rect x="44" y="51" width="106" height="16" rx="4" class="hitbox" />
                    <text x="50" y="62.5" class="mono ink-dark">org_id = 'acme'</text>
                  </g>
                  <text
                    v-if="S.clause"
                    x="9"
                    y="81"
                    class="mono"
                    :class="
                      S.stopsAt === undefined && S.clause.includes('globex') ? 'warn' : 'code-ink'
                    "
                  >
                    and {{ S.clause }}
                  </text>
                </g>
              </g>

              <!-- 3. count: matches light up in 10,000 orders -->
              <g v-else-if="st.id === 'count'">
                <rect
                  v-for="(d, n) in DOTS"
                  :key="n"
                  :x="d.c * 8"
                  :y="6 + d.r * 8"
                  width="5"
                  height="5"
                  rx="1"
                  class="dot"
                />
                <rect
                  v-for="n in [...LIT[current]!.set]"
                  :key="`l${n}`"
                  :x="DOTS[n]!.c * 8"
                  :y="6 + DOTS[n]!.r * 8"
                  width="5"
                  height="5"
                  rx="1"
                  class="dot-on"
                  :style="{ '--d': `${LIT[current]!.delay[n]}ms` }"
                />
                <text x="168" y="34" text-anchor="end" class="pix big">{{ fmt(count) }}</text>
                <text x="168" y="50" text-anchor="end" class="dim">of 10,000</text>
                <text x="0" y="86" class="mono dim">select count(*)</text>
              </g>

              <!-- 4. page ids: sorted, the first page cut -->
              <g v-else-if="st.id === 'ids'">
                <template v-if="S.ids">
                  <rect
                    v-for="(h, n) in BARS"
                    :key="n"
                    :x="n * 12"
                    :y="78 - h"
                    width="8"
                    :height="h"
                    rx="1.5"
                    class="bar"
                    :style="{ '--n': n }"
                  />
                  <rect
                    v-for="n in 4"
                    :key="`p${n}`"
                    :x="(n - 1) * 12"
                    :y="78 - BARS[n - 1]!"
                    width="8"
                    :height="BARS[n - 1]"
                    rx="1.5"
                    class="bar-on"
                    :style="{ '--n': n - 1 }"
                  />
                  <g class="cut">
                    <path d="M-1 18 V 13 H 45 V 18" />
                    <text x="0" y="9" class="mono hit-t">limit 25</text>
                  </g>
                  <text x="0" y="90" class="mono dim">sorted by totalAmount ↓</text>
                </template>
                <g v-else class="zero">
                  <text x="84" y="50" text-anchor="middle" class="pix huge">0</text>
                  <text x="84" y="70" text-anchor="middle" class="dim">ids to page through</text>
                </g>
              </g>

              <!-- 5. rows: each id grows its relations -->
              <g v-else-if="st.id === 'rows'">
                <template v-if="S.rows.length">
                  <g
                    v-for="(r, n) in S.rows"
                    :key="r.ref"
                    class="r-row"
                    :style="{ '--n': n }"
                    :transform="`translate(0 ${4 + n * 30})`"
                  >
                    <rect width="62" height="18" rx="4" class="hitbox" />
                    <text x="31" y="12.5" text-anchor="middle" class="mono ink-dark">
                      {{ r.ref }}
                    </text>
                    <path
                      d="M62 9 H 72 M72 3 V 15 M72 3 H 80 M72 15 H 80"
                      class="r-branch"
                      pathLength="1"
                    />
                    <g class="r-kid">
                      <rect x="80" y="-4" width="88" height="12" rx="3" class="kid-a" />
                      <text x="85" y="5" class="tiny">customer</text>
                    </g>
                    <g class="r-kid k2">
                      <rect x="80" y="10" width="88" height="12" rx="3" class="kid-b" />
                      <text x="85" y="19" class="tiny">orderLines</text>
                    </g>
                  </g>
                </template>
                <g v-else class="zero">
                  <text x="84" y="50" text-anchor="middle" class="pix huge">—</text>
                  <text x="84" y="70" text-anchor="middle" class="dim">no ids, no rows</text>
                </g>
              </g>

              <!-- 6. facets: a histogram per status -->
              <g v-else>
                <g
                  v-for="(b, n) in S.buckets"
                  :key="b[0]"
                  class="f-row"
                  :style="{ '--n': n }"
                  :transform="`translate(0 ${6 + n * 22})`"
                >
                  <text x="0" y="9" class="mono" :class="{ strong: n === 0 && b[1] }">
                    {{ b[0] }}
                  </text>
                  <text x="168" y="9" text-anchor="end" class="mono dim">{{ fmt(b[1]) }}</text>
                  <rect x="0" y="13" width="168" height="4" rx="2" class="track" />
                  <rect
                    x="0"
                    y="13"
                    :width="Math.max(3, (b[1] / bucketMax) * 168)"
                    height="4"
                    rx="2"
                    class="f-bar"
                    :class="{ on: n === 0 && b[1] }"
                  />
                </g>
              </g>
            </svg>

            <p>{{ st.text }}</p>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pl {
  position: relative;
  padding: 18px 22px 22px;
  border: 1px solid var(--line2);
  border-radius: 20px;
  background:
    radial-gradient(
      120% 70% at 50% 0%,
      color-mix(in srgb, var(--hit) 6%, transparent),
      transparent 70%
    ),
    color-mix(in srgb, var(--panel) 75%, transparent);
}
.pl-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line2);
  border-radius: 12px;
  background: var(--bg);
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.pl-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 12px 6px 9px;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--ink2);
  cursor: pointer;
  transition:
    background 0.2s,
    color 0.2s;
}
.pl-tabs button span {
  font-size: 12px;
  color: var(--ink3);
}
.pl-tabs button:hover {
  color: var(--ink);
}
.pl-tabs button.on {
  background: var(--hit);
  color: var(--hit-ink);
}
.pl-tabs button.on span {
  color: var(--hit-ink);
}

/* ends */
.pl-ends {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  margin-top: 26px;
}
.pl-end {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.pl-end b {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 4px 11px;
  border: 1px solid color-mix(in srgb, var(--hit) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--hit) 10%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hit-text);
}
.pl-end code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-end.res {
  align-items: flex-end;
  text-align: right;
}
.pl-end.res b {
  align-self: flex-end;
  border-color: var(--line2);
  background: transparent;
  color: var(--ink3);
  transition:
    background 0.4s,
    color 0.4s,
    border-color 0.4s;
}
.pl-end.res b .px-pix {
  font-size: 15px;
  letter-spacing: 0;
}
.pl-end.res.show b {
  border-color: var(--hit);
  background: var(--hit);
  color: var(--hit-ink);
  animation: pl-pop 0.4s var(--ease);
}
.pl-end.res.show code {
  color: var(--ink);
}
.pl-end.res.bad b {
  border-color: var(--px-warn);
  background: var(--px-warn);
  color: #fff;
}

/* track */
.pl-flow {
  position: relative;
}
.pl-svg {
  position: absolute;
  inset: 0 0 auto 0;
  width: 100%;
  overflow: visible;
  pointer-events: none;
  z-index: 1;
}
.pl-track {
  height: 44px;
}
.rail {
  stroke: var(--line2);
  stroke-width: 1.5;
}
.ticks {
  stroke: var(--line2);
  stroke-width: 4;
  stroke-dasharray: 1 13;
  opacity: 0.7;
}
.lit {
  stroke: color-mix(in srgb, var(--hit) 55%, transparent);
  stroke-width: 2;
}
.lit.bad,
.stream.bad {
  stroke: var(--px-warn);
}
.stream {
  stroke: var(--hit);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 2 14;
  animation: pl-stream 0.9s linear infinite;
}
@keyframes pl-stream {
  to {
    stroke-dashoffset: -16;
  }
}
.comet {
  transition: opacity 0.5s;
}
.comet.fade {
  opacity: 0.25;
}
.nd .ring {
  fill: var(--bg);
  stroke: var(--line2);
  stroke-width: 1.5;
  transition:
    stroke 0.4s,
    fill 0.4s;
}
.nd .core {
  fill: var(--line2);
  transition: fill 0.4s;
}
.nd:is([data-state="on"], [data-state="done"]) .ring {
  stroke: var(--hit);
}
.nd:is([data-state="on"], [data-state="done"]) .core {
  fill: var(--hit);
}
.nd[data-state="bad"] .ring {
  stroke: var(--px-warn);
}
.nd[data-state="bad"] .core {
  fill: var(--px-warn);
}
.nd[data-state="skip"] {
  opacity: 0.35;
}
.conn {
  fill: none;
  stroke: var(--line2);
  stroke-width: 1.2;
}
.conn.on {
  stroke: var(--hit);
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: pl-draw 0.35s ease-out forwards;
}
.nd[data-state="bad"] .conn.on {
  stroke: var(--px-warn);
}
.spark {
  fill: #fffbe6;
  filter: drop-shadow(0 0 4px #ffd23f);
  animation: pl-spark 0.42s cubic-bezier(0.5, 0, 0.8, 0.4) forwards;
}
@keyframes pl-spark {
  to {
    transform: translateY(var(--dy));
    opacity: 0.2;
  }
}
.ripple {
  fill: none;
  stroke: var(--hit);
  stroke-width: 1.5;
  transform-box: fill-box;
  transform-origin: center;
  animation: pl-ripple 0.9s ease-out forwards;
}
.nd[data-state="bad"] .ripple {
  stroke: var(--px-warn);
}
.ripple.big {
  stroke-width: 2;
  animation-duration: 1.2s;
}
@keyframes pl-ripple {
  from {
    opacity: 0.9;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(3.4);
  }
}
.pk-halo {
  fill: color-mix(in srgb, var(--hit) 22%, transparent);
  transform-box: fill-box;
  transform-origin: center;
  animation: pl-halo 1.4s ease-in-out infinite;
}
.pk-core {
  filter: drop-shadow(0 0 6px #ffd23f);
}
.pk.bad .pk-halo {
  fill: color-mix(in srgb, var(--px-warn) 25%, transparent);
}
.pk.bad .pk-core {
  filter: drop-shadow(0 0 6px #ff6b4a);
}
.pk.bad {
  animation: pl-shake 0.45s 0.15s;
}
.pk {
  transition: opacity 0.5s;
}
.pk.gone {
  opacity: 0;
}
@keyframes pl-halo {
  50% {
    transform: scale(1.35);
    opacity: 0.55;
  }
}
@keyframes pl-shake {
  25%,
  75% {
    translate: -5px 0;
  }
  50% {
    translate: 5px 0;
  }
}

/* cards */
.pl-cards {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  margin-top: 0;
}
.pl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 14px 14px 16px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: var(--panel);
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.5s,
    border-color 0.5s,
    box-shadow 0.6s,
    transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
}
/* a light that runs around the border of the active stage */
@property --pl-a {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}
.pl-card::before {
  content: "";
  position: absolute;
  inset: -1px;
  padding: 1.5px;
  border-radius: inherit;
  background: conic-gradient(
    from var(--pl-a),
    transparent 0deg 250deg,
    color-mix(in srgb, var(--hit) 40%, transparent) 300deg,
    #fff3c4 340deg,
    var(--hit) 352deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 0.4s;
  pointer-events: none;
}
.pl-card[data-state="on"]::before {
  opacity: 1;
  animation: pl-orbit 2.2s linear infinite;
}
@keyframes pl-orbit {
  to {
    --pl-a: 360deg;
  }
}
.pl-card:hover {
  opacity: 0.9;
}
.pl-card[data-state="on"] {
  opacity: 1;
  border-color: color-mix(in srgb, var(--hit) 45%, var(--line2));
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--hit) 12%, transparent),
    0 18px 40px -24px color-mix(in srgb, var(--hit) 70%, transparent);
  transform: translateY(-6px);
}
.pl-card[data-state="done"] {
  opacity: 1;
}
.pl-card[data-state="bad"] {
  opacity: 1;
  border-color: var(--px-warn);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--px-warn) 12%, transparent);
}
.pl-card[data-state="skip"] {
  opacity: 0.28;
}
.pl-card header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pl-card header .px-pix {
  font-size: 13px;
  color: var(--hit-text);
}
.pl-card[data-state="bad"] header .px-pix {
  color: var(--px-warn);
}
.pl-card h3 {
  font-size: 15px;
  font-weight: 600;
}
.pl-mark {
  width: 16px;
  height: 16px;
  margin-left: auto;
  opacity: 0;
  transform: scale(0.5);
  transition:
    opacity 0.3s,
    transform 0.3s var(--ease);
}
.pl-mark circle {
  fill: var(--hit);
}
.pl-mark path {
  fill: none;
  stroke: var(--hit-ink);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pl-card[data-state="done"] .pl-mark,
.pl-card[data-state="bad"] .pl-mark {
  opacity: 1;
  transform: none;
}
.pl-card[data-state="bad"] .pl-mark circle {
  fill: var(--px-warn);
}
.pl-card[data-state="bad"] .pl-mark path {
  stroke: #fff;
}
.pl-mark .mk-bad,
.pl-card[data-state="bad"] .pl-mark .mk-ok {
  display: none;
}
.pl-card[data-state="bad"] .pl-mark .mk-bad {
  display: inline;
}
.pl-viz {
  display: block;
  width: 100%;
  height: auto;
  margin: 14px 0 12px;
  overflow: visible;
  font-family: var(--font-sans);
}
.pl-card p {
  margin-top: auto;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink2);
}

/* diagrams: wait until the stage is reached, then play */
.pl-card:is([data-state=""], [data-state="skip"]) .pl-viz * {
  animation-play-state: paused !important;
}
text {
  font-size: 10px;
  fill: var(--ink);
}
.mono {
  font-family: var(--font-mono);
  font-size: 10px;
}
.dim {
  fill: var(--ink3);
  font-size: 9.5px;
}
.tiny {
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 600;
  fill: var(--hit-ink);
}
.strong {
  font-weight: 700;
}
.warn {
  fill: var(--px-warn);
}
.hit-t {
  fill: var(--hit-text);
}
.ink-dark {
  fill: var(--hit-ink);
  font-weight: 600;
}
.pix {
  font-family: var(--font-pixel);
  font-weight: 800;
}
.big {
  font-size: 22px;
}
.huge {
  font-size: 40px;
  fill: var(--ink2);
}
.chip-bg {
  fill: var(--bg);
  stroke: var(--line2);
}
.hot {
  fill: color-mix(in srgb, var(--hit) 12%, var(--bg));
  stroke: color-mix(in srgb, var(--hit) 65%, transparent);
}
.hitbox {
  fill: var(--hit);
}
.code {
  fill: var(--code);
  stroke: var(--line2);
}
.kw {
  fill: var(--tk-kw);
}
.code-ink {
  fill: var(--cink);
}
.track {
  fill: var(--line);
}

/* 1 */
.v-chip {
  animation: pl-rise 0.35s var(--ease) backwards;
  animation-delay: calc(var(--n) * 260ms + 100ms);
}
.v-tick {
  transform-box: fill-box;
  transform-origin: center;
  animation: pl-pop 0.3s var(--ease) backwards;
  animation-delay: calc(var(--n) * 260ms + 420ms);
}
.v-tick circle {
  fill: var(--hit);
}
.v-tick path {
  fill: none;
  stroke: var(--hit-ink);
  stroke-width: 1.5;
  stroke-linecap: round;
}
.v-chip.bad .chip-bg {
  stroke: var(--px-warn);
  fill: color-mix(in srgb, var(--px-warn) 10%, var(--bg));
}
.v-chip.bad text {
  fill: var(--px-warn);
}
.v-chip.bad .v-tick circle {
  fill: var(--px-warn);
}
.v-chip.bad .v-tick path {
  stroke: #fff;
}
.v-verdict {
  font-weight: 600;
  animation: pl-rise 0.35s var(--ease) 0.9s backwards;
}

/* 2 */
.shield {
  fill: var(--hit);
}
.s-drop {
  fill: none;
  stroke: var(--hit);
  stroke-width: 1.5;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: pl-draw 0.4s ease-out 0.4s forwards;
}
.s-ctx {
  animation: pl-rise 0.35s var(--ease) backwards;
}
.s-clause {
  animation: pl-drop 0.5s cubic-bezier(0.2, 1.5, 0.4, 1) 0.8s backwards;
}

/* 3 */
.dot {
  fill: var(--line2);
}
.dot-on {
  fill: var(--hit);
  transform-box: fill-box;
  transform-origin: center;
  animation: pl-lit 0.45s var(--ease) both;
  animation-delay: var(--d);
}
@keyframes pl-lit {
  0% {
    opacity: 0;
    transform: scale(0.3);
  }
  50% {
    opacity: 1;
    transform: scale(1.7);
  }
  100% {
    opacity: 1;
    transform: none;
  }
}

/* 4 */
.bar {
  fill: var(--line2);
  transform-box: fill-box;
  transform-origin: bottom;
  animation: pl-growy 0.45s var(--ease) backwards;
  animation-delay: calc(var(--n) * 35ms);
}
.bar-on {
  fill: var(--hit);
  transform-box: fill-box;
  transform-origin: bottom;
  animation: pl-fade 0.4s var(--ease) both;
  animation-delay: calc(800ms + var(--n) * 110ms);
}
.cut path {
  fill: none;
  stroke: var(--hit);
  stroke-width: 1.3;
}
.cut {
  animation: pl-rise 0.35s var(--ease) 1.3s backwards;
}
.zero {
  animation: pl-rise 0.4s var(--ease) 0.2s backwards;
}

/* 5 */
.r-row {
  animation: pl-rise 0.35s var(--ease) backwards;
  animation-delay: calc(var(--n) * 330ms);
}
.r-branch {
  fill: none;
  stroke: var(--ink3);
  stroke-width: 1.2;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: pl-draw 0.4s ease-out forwards;
  animation-delay: calc(var(--n) * 330ms + 300ms);
}
.r-kid {
  animation: pl-slide 0.35s var(--ease) backwards;
  animation-delay: calc(var(--n) * 330ms + 550ms);
}
.r-kid.k2 {
  animation-delay: calc(var(--n) * 330ms + 680ms);
}
.kid-a {
  fill: var(--px-ok);
}
.kid-b {
  fill: var(--px-alt);
}

/* 6 */
.f-row {
  animation: pl-rise 0.3s var(--ease) backwards;
  animation-delay: calc(var(--n) * 120ms);
}
.f-bar {
  fill: var(--ink3);
  transform-box: fill-box;
  transform-origin: left;
  animation: pl-growx 0.9s var(--ease) backwards;
  animation-delay: calc(var(--n) * 120ms + 200ms);
}
.f-bar.on {
  fill: var(--hit);
}

@keyframes pl-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
@keyframes pl-pop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
}
@keyframes pl-draw {
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes pl-drop {
  from {
    opacity: 0;
    transform: translateY(-22px);
  }
}
@keyframes pl-slide {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
}
@keyframes pl-growy {
  from {
    transform: scaleY(0);
  }
}
@keyframes pl-growx {
  from {
    transform: scaleX(0);
  }
}
@keyframes pl-fade {
  from {
    opacity: 0;
    transform: scaleY(0.6);
  }
}

@media (max-width: 1100px) {
  .pl-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .pl-track,
  .pl-svg {
    display: none;
  }
}
.pl-tabs .short {
  display: none;
}
/* phones: a vertical stepper; a rail on the left, the active stage opens */
@media (max-width: 640px) {
  .pl {
    padding: 12px;
    border-radius: 16px;
  }
  .pl-tabs {
    display: flex;
    width: 100%;
  }
  .pl-tabs button {
    flex: 1;
    justify-content: center;
    padding: 7px 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .pl-tabs .full {
    display: none;
  }
  .pl-tabs .short {
    display: inline;
  }
  .pl-ends {
    flex-direction: row;
    gap: 10px;
    margin-top: 16px;
    padding-bottom: 12px;
  }
  .pl-end code {
    white-space: normal;
    font-size: 11px;
  }
  .pl-cards {
    position: relative;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    padding-left: 26px;
  }
  .pl-cards::before {
    content: "";
    position: absolute;
    left: 8px;
    top: 14px;
    bottom: 14px;
    width: 2px;
    background: repeating-linear-gradient(180deg, var(--line2) 0 5px, transparent 5px 9px);
  }
  .pl-card {
    padding: 11px 12px;
    opacity: 0.6;
  }
  .pl-card::after {
    content: "";
    position: absolute;
    left: -24px;
    top: 15px;
    width: 10px;
    height: 10px;
    border: 2px solid var(--line2);
    border-radius: 50%;
    background: var(--bg);
    transition:
      background 0.3s,
      border-color 0.3s,
      box-shadow 0.3s;
  }
  .pl-card:is([data-state="on"], [data-state="done"])::after {
    border-color: var(--hit);
    background: var(--hit);
  }
  .pl-card[data-state="on"]::after {
    box-shadow:
      0 0 0 5px color-mix(in srgb, var(--hit) 20%, transparent),
      0 0 16px var(--hit);
  }
  .pl-card[data-state="bad"]::after {
    border-color: var(--px-warn);
    background: var(--px-warn);
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--px-warn) 20%, transparent);
  }
  .pl-card[data-state="on"] {
    transform: none;
  }
  .pl-card .pl-viz,
  .pl-card p {
    display: none;
  }
  .pl-card:is([data-state="on"], [data-state="bad"]) .pl-viz {
    display: block;
    max-width: 250px;
    margin: 12px 0 8px;
  }
  .pl-card:is([data-state="on"], [data-state="bad"]) p {
    display: block;
  }
  .pl-card h3 {
    font-size: 14.5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pl *,
  .pl-svg * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
