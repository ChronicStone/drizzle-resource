<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import bench from "~/data/bench-landing.json";
import { prefersReducedMotion } from "./px";

/* The landing's benchmark: each request measured at three table sizes, out of the box and
   tuned. The server renders the tuned state with every number in the HTML; in the browser the
   chart rewinds and plays once when it scrolls into view: the table grows 200k → 1M → 10M, then
   the four tools (see, explain, fix, guard) find the slow requests and bring them down.
   Numbers come only from data/bench-landing.json, written by tools/landing-bench-data.ts. */

type Key = "page" | "cursor" | "count" | "relationSort" | "facets" | "search";
/** from the benchmark: did the tuned run make this request faster? */
type Verdict = "improved" | "unchanged" | "worse";
interface Data {
  placeholder: boolean;
  measuredOn: string;
  engine: string;
  postgres: string;
  cpus: number;
  clients: number;
  runs: number;
  sizes: number[];
  requests: Record<Key, { outOfTheBox: number[]; tuned: number[]; verdict: Verdict }>;
  tunedSettings: { countCap: number };
}
const data = bench as Data;

/** Beat at which a request takes its tuned time: 3 = fix, 4 = guard. Flat ones change at the end. */
const REQUESTS: { key: Key; label: string; shape: string; drop: number; flat?: boolean }[] = [
  {
    key: "page",
    label: "Page of rows",
    shape: "orders · sort createdAt desc · count none",
    drop: 4,
    flat: true,
  },
  {
    key: "cursor",
    label: "Deep cursor page",
    shape: "orders · cursor · sort id desc",
    drop: 4,
    flat: true,
  },
  {
    key: "count",
    label: "Page + count",
    shape: "orders · sort createdAt desc · count exact",
    drop: 4,
  },
  {
    key: "relationSort",
    label: "Sort by customer.name + count",
    shape: "orders · sort customer.name · count exact",
    drop: 3,
  },
  {
    key: "facets",
    label: "4 facets",
    shape: "orders · facets status,paid,customer.segment,customer.name",
    drop: 4,
  },
  {
    key: "search",
    label: 'Search "ord" + count',
    shape: "orders · search reference,customer.name · count exact",
    drop: 4,
  },
];
// A request the tuned run did not make faster keeps its out-of-the-box columns: no drop is shown.
const rows = REQUESTS.map((r) => {
  const d = data.requests[r.key];
  return { ...r, ...d, improved: d.verdict === "improved" };
});
const SIZE_LABEL = ["200k", "1M", "10M"];
const SIZE_LONG = ["200,000", "1 million", "10 million"];
const LAST = data.sizes.length - 1;
const SLOW_MS = 200;

const fmt = (ms: number) =>
  ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString("en-US");
const lerpLog = (a: number, b: number, k: number) =>
  Math.pow(10, Math.log10(a) + (Math.log10(b) - Math.log10(a)) * k);
const frac = (ms: number) => Math.max(0.02, (Math.log10(ms) + 1) / 5); // 0.1 ms … 10 s

/* ---------- state: what the server renders is the end of the story ---------- */
const beat = ref(4);
const ks = ref(rows.map((r) => (r.improved ? 1 : 0))); // 0 = out of the box, 1 = tuned
const grow = ref([1, 1, 1]); // how far each size's columns have risen
const keyOn = ref(-1);
const valueAt = (i: number, s: number) =>
  lerpLog(rows[i]!.outOfTheBox[s]!, rows[i]!.tuned[s]!, ks.value[i]!);
const labelAt = (i: number, s: number) => {
  const k = ks.value[i]!;
  const r = rows[i]!;
  return `${fmt(k > 0.98 ? r.tuned[s]! : k < 0.02 ? r.outOfTheBox[s]! : valueAt(i, s))} ms`;
};

/** shown next to a request that the tools flag but the tuned run did not speed up */
const noteAt = (i: number) => {
  const r = rows[i]!;
  if (r.improved || r.flat || beat.value < r.drop) return "";
  return r.verdict === "worse" ? " · slower tuned" : " · no change tuned";
};
const verdictText = (v: Verdict) =>
  v === "improved" ? "faster" : v === "worse" ? "slower" : "no change";

const slow = computed(() =>
  rows
    .filter((r) => !r.flat && r.outOfTheBox[LAST]! > SLOW_MS)
    .sort((a, b) => b.outOfTheBox[LAST]! - a.outOfTheBox[LAST]!),
);
const slowest = computed(() => slow.value[0]!);
const found = computed(() =>
  beat.value === 1
    ? slow.value.map((r) => r.key)
    : beat.value === 2
      ? [slowest.value.key]
      : beat.value === 3
        ? rows.filter((r) => r.drop === 3).map((r) => r.key)
        : [],
);

/* ---------- the four tools, with numbers taken from the data ---------- */
const EXPLAIN: Partial<Record<Key, string[]>> = {
  search: [
    "count   reads every matching row to return one number",
    'fix:    count "capped" stops after 10,001 rows',
  ],
  facets: ["facets  group every matching row, one CPU", 'fix:    facets: { whenCapped: "skip" }'],
  relationSort: [
    "ids     joins every order to sort by customer.name",
    "fix:    see checkIndexes()",
  ],
  count: [
    "count   reads every matching row to return one number",
    'fix:    count "capped" stops after 10,001 rows',
  ],
};
const atLast = (r: (typeof rows)[number], which: "outOfTheBox" | "tuned") =>
  `${fmt(r[which][LAST]!)} ms at 10M`;
const STEPS = [
  { n: 0, title: "Out of the box", api: "defaults", href: "" },
  { n: 1, title: "See", api: "onQuery", href: "/scale/optimize#see" },
  { n: 2, title: "Explain", api: "resource.explain()", href: "/scale/optimize#explain" },
  { n: 3, title: "Fix", api: "engine.checkIndexes()", href: "/scale/optimize#fix" },
  { n: 4, title: "Guard", api: "countCap · whenCapped", href: "/scale/optimize#guard" },
];
const cap = data.tunedSettings.countCap.toLocaleString("en-US").replace(/,/g, "_");
const consoleFor = computed(() => {
  const s = slowest.value;
  const under = rows.find((r) => r.key === "count")!;
  switch (beat.value) {
    case 0:
      return {
        lines: [
          ["dim", `// ${data.sizes[LAST]!.toLocaleString("en-US")} orders, default settings`],
          ["", 'sort: { defaults: [{ key: "createdAt", dir: "desc" }] },'],
          ["", 'facets: { allowed: ["status", "paid",'],
          ["", '  "customer.segment", "customer.name"] },'],
          ["dim", "// offset pages count every match: exact by default"],
        ],
        say: "From 200,000 to 10 million rows, pages and cursors stay flat. Everything that counts grows with the table.",
      };
    case 1:
      return {
        lines: [
          ["kw", `onQuery: (e) => e.ms > ${SLOW_MS} && log.warn(e.shape, e.ms)`],
          ...slow.value.map((r) => ["warn", `${atLast(r, "outOfTheBox").padEnd(17)} ${r.shape}`]),
        ],
        say:
          `onQuery flags the ${slow.value.length} requests over ${SLOW_MS} ms at 10 million rows.` +
          (under.outOfTheBox[LAST]! <= SLOW_MS
            ? ` Page + count, at ${atLast(under, "outOfTheBox")}, stays under the threshold.`
            : ""),
      };
    case 2:
      return {
        lines: [
          ["kw", "await orders.explain({ request, analyze: true })"],
          ["dim", s.shape],
          ["warn", `total   ${atLast(s, "outOfTheBox")}`],
          ...(EXPLAIN[s.key] ?? []).map((l) => [l.startsWith("fix") ? "ok" : "", l]),
        ],
        say: `explain() on the slowest one, ${s.label}, says where the time goes and what to change.`,
      };
    case 3: {
      const r = rows.find((x) => x.drop === 3)!;
      return {
        lines: [
          ["", "engine.checkIndexes()"],
          ["warn", "warn  orders  sort customer.name joins every order first"],
          ["ok", "      copy name onto orders and index it, or disable the sort"],
        ],
        say: r.improved
          ? `checkIndexes() flags the relation sort. With its fix: ${atLast(r, "outOfTheBox")} → ${fmt(r.tuned[LAST]!)} ms.`
          : `checkIndexes() flags the relation sort, but on this run its fix did not make it faster (${atLast(r, "outOfTheBox")} → ${fmt(r.tuned[LAST]!)} ms), so the chart leaves it as it was.`,
      };
    }
    default:
      return {
        lines: [
          ["", `pagination: { countCap: ${cap} },`],
          ["", 'defaults: { pagination: { count: "capped" } },'],
          ["", 'facets: { whenCapped: "skip" },'],
          ["ok", `// pageInfo: { rowCount: ${cap}, exact: false }`],
        ],
        say: (() => {
          const credited = rows.filter((r) => !r.flat);
          const faster = credited.filter((r) => r.drop === 4 && r.improved);
          const not = credited.filter((r) => !r.improved);
          return (
            `A capped count and facet limits bring the rest down. This is the tuned state: ${faster
              .map((r) => `${r.label} ${fmt(r.tuned[LAST]!)} ms`)
              .join(", ")} at 10M.` +
            (not.length
              ? ` ${not.map((r) => r.label).join(" and ")} did not get faster on this run.`
              : "")
          );
        })(),
      };
  }
});

/* ---------- the chart, drawn twice: columns on wide screens, bars on phones ---------- */
const SIZE_CELLS = [2, 3, 4]; // the bigger the table, the wider the column
const V = { W: 800, H: 384, L: 60, R: 8, T: 30, B: 84, cell: 6 };
const vert = computed(() => {
  const { W, H, L, R, T, B, cell } = V;
  const Hp = H - T - B;
  const base = T + Hp;
  const snap = (px: number) => Math.round(px / cell) * cell;
  const hOf = (ms: number) => snap(frac(ms) * Hp);
  const pitch = (W - L - R) / rows.length;
  const gap = cell * 1.5;
  const ws = SIZE_CELLS.map((c) => c * cell);
  const gw = ws[0]! + ws[1]! + ws[2]! + gap * 2;
  const xs = [0, ws[0]! + gap, ws[0]! + ws[1]! + gap * 2];
  return {
    base,
    grid: [0.1, 1, 10, 100, 1000, 10000].map((ms) => ({
      y: base - frac(ms) * Hp,
      t: ms < 1000 ? `${ms} ms` : `${ms / 1000} s`,
    })),
    groups: rows.map((r, i) => {
      const gx = L + pitch * i + (pitch - gw) / 2;
      const cols = [0, 1, 2].map((s) => {
        const x = gx + xs[s]!;
        const h = snap(hOf(valueAt(i, s)) * grow.value[s]!);
        const gh = hOf(r.outOfTheBox[s]!);
        return { x, w: ws[s]!, y: base - h, h, gy: base - gh, gh, cx: x + ws[s]! / 2 };
      });
      const top = base - hOf(valueAt(i, LAST)) - 8;
      const ring = {
        x: gx - 6,
        y: base - hOf(r.outOfTheBox[LAST]!) - 24,
        w: gw + 12,
        h: hOf(r.outOfTheBox[LAST]!) + 46,
      };
      return { r, i, gx, cx: gx + gw / 2, cols, top, ring, words: wrap(r.label, 16) };
    }),
  };
});
const HZ = { W: 340, L: 40, R: 92, cell: 4, rowH: 17, head: 22 };
const horiz = computed(() => {
  const { W, L, R, cell, rowH, head } = HZ;
  const Wp = W - L - R;
  const th = SIZE_CELLS.map((c) => (c - 1) * cell);
  const blockH = head + rowH * 3 + 10;
  const T = 22;
  const len = (ms: number) => Math.round((frac(ms) * Wp) / cell) * cell;
  return {
    H: T + blockH * rows.length,
    grid: [0.1, 1, 10, 100, 1000, 10000].map((ms) => ({
      x: L + frac(ms) * Wp,
      t: ms < 1000 ? `${ms}ms` : `${ms / 1000}s`,
    })),
    T,
    groups: rows.map((r, i) => {
      const y0 = T + blockH * i;
      return {
        r,
        i,
        y0,
        blockH,
        bars: [0, 1, 2].map((s) => {
          const mid = y0 + head + s * rowH + 6;
          return {
            y: mid - th[s]! / 2,
            th: th[s]!,
            mid,
            w: Math.round((len(valueAt(i, s)) * grow.value[s]!) / cell) * cell,
            gw: len(r.outOfTheBox[s]!),
          };
        }),
      };
    }),
  };
});
/** keep the 10M label inside the chart: centred on its column unless that would cross an edge */
function valuePos(i: number, cx: number) {
  const w = `10M: ${labelAt(i, LAST)}${noteAt(i)}`.length * 6.7;
  if (cx + w / 2 > V.W - 2) return { x: V.W - 2, anchor: "end" };
  if (cx - w / 2 < V.L) return { x: V.L, anchor: "start" };
  return { x: cx, anchor: "middle" };
}
function wrap(t: string, max: number) {
  const out: string[] = [];
  let line = "";
  for (const w of t.split(" ")) {
    if ((line + " " + w).trim().length > max && line) {
      out.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out;
}

/* ---------- motion: rewind in the browser, play once in view ---------- */
const root = ref<HTMLElement | null>(null);
const rain = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let timers: number[] = [];
let drops: { x: number; y: number; vx: number; vy: number; c: string; born: number }[] = [];
let io: IntersectionObserver | undefined;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const target = (b: number) => rows.map((r) => (r.improved && b >= r.drop ? 1 : 0));
const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
function stop() {
  cancelAnimationFrame(raf);
  timers.forEach(clearTimeout);
  timers = [];
  drops = [];
  const c = rain.value;
  c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
}

function shed(to: number[]) {
  // pixels of a column that drops fall away, like the rest of the landing
  const plot = root.value?.querySelector<HTMLElement>(".px-tb-plot");
  const visible = [...(root.value?.querySelectorAll<SVGSVGElement>(".px-tb-chart svg") ?? [])].find(
    (s) => s.getBoundingClientRect().width > 0,
  );
  if (!plot || !visible) return;
  const box = plot.getBoundingClientRect();
  const cs = getComputedStyle(root.value!);
  visible.querySelectorAll<SVGGElement>(".px-tb-grp").forEach((g) => {
    const i = Number(g.dataset.i);
    if (ks.value[i]! > 0.01 || to[i]! < 1 || rows[i]!.flat) return;
    const c = cs.getPropertyValue(`--px-s-${rows[i]!.key}`).trim();
    g.querySelectorAll(".px-tb-live rect").forEach((rect) => {
      const rb = rect.getBoundingClientRect();
      for (let y = rb.top; y < rb.bottom - 16; y += 6)
        for (let x = rb.left; x < rb.right; x += 6)
          if (Math.random() < 0.32)
            drops.push({
              x: x - box.left,
              y: y - box.top,
              vx: (Math.random() - 0.5) * 0.7,
              vy: -Math.random() * 0.8,
              c,
              born: performance.now() + Math.random() * 200,
            });
    });
  });
}

function animateTo(b: number, dur = 700) {
  cancelAnimationFrame(raf);
  const from = ks.value.slice();
  const to = target(b);
  if (prefersReducedMotion()) {
    ks.value = to;
    return;
  }
  shed(to);
  const canvas = rain.value!;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = performance.now();
  const RAIN_MS = 1400;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur);
    ks.value = from.map((f, i) => f + (to[i]! - f) * ease(t));
    // time-based, so a throttled tab can't leave pixels hanging mid-fall
    drops = drops.filter((q) => now - q.born < RAIN_MS);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.75;
    for (const q of drops) {
      const age = (now - q.born) / 16.7;
      if (age < 0) continue;
      const y = q.y + q.vy * age + 0.125 * age * age;
      if (y > h) continue;
      ctx.fillStyle = q.c;
      ctx.fillRect(Math.round((q.x + q.vx * age) / 6) * 6, Math.round(y / 6) * 6, 4.5, 4.5);
    }
    if (t < 1 || drops.length) raf = requestAnimationFrame(step);
    else ctx.clearRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(step);
}

function goto(b: number) {
  stop();
  grow.value = [1, 1, 1];
  keyOn.value = -1;
  beat.value = b;
  animateTo(b);
}

/** ~5 s: the table grows (1.3 s), then one beat per tool. */
function play() {
  stop();
  drops = [];
  beat.value = 0;
  ks.value = rows.map(() => 0);
  grow.value = [0, 0, 0];
  let s = 0;
  const rise = () => {
    if (s > 2) {
      later(450, () => (keyOn.value = -1));
      [1, 2, 3, 4].forEach((b, j) =>
        later(250 + j * 900, () => {
          beat.value = b;
          animateTo(b);
        }),
      );
      return;
    }
    keyOn.value = s;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 380);
      grow.value = grow.value.map((g, j) => (j === s ? ease(t) : g));
      if (t < 1) raf = requestAnimationFrame(step);
      else {
        s++;
        later(60, rise);
      }
    };
    raf = requestAnimationFrame(step);
  };
  rise();
}

onMounted(() => {
  if (prefersReducedMotion() || !root.value) return;
  const r = root.value.getBoundingClientRect();
  const inView = r.top < window.innerHeight * 0.65 && r.bottom > 0;
  // rewind only in the browser; the server HTML keeps today's tuned numbers
  if (!inView) {
    beat.value = 0;
    ks.value = rows.map(() => 0);
  }
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io?.disconnect();
        play();
      }
    },
    { threshold: 0.35 },
  );
  io.observe(root.value.querySelector(".px-tb-plot")!);
});
onBeforeUnmount(() => {
  stop();
  io?.disconnect();
});
</script>

<template>
  <section id="benchmarks" ref="root" class="px-blk px-tb" aria-labelledby="px-tb-h">
    <div class="px-head">
      <h2 id="px-tb-h"><span class="px-acc">Benchmarks</span></h2>
      <p class="px-lede">
        A page of rows takes about {{ rows[0]!.outOfTheBox[LAST]!.toFixed(1) }} ms at 200,000 rows
        and at 10 million. Counting grows with the table. The four tools below find each slow
        request and show what brings it back down.
      </p>
    </div>
    <div class="px-panel px-tb-panel">
      <div class="px-win-h">
        <i />Median time per request, one client{{ " "
        }}<small>PostgreSQL {{ data.postgres }} · {{ data.cpus }} CPUs</small>
      </div>
      <p v-if="data.placeholder" class="px-tb-ph">
        Placeholder numbers: they will be replaced by the next benchmark run.
      </p>
      <div class="px-tb-ctl">
        <button type="button" class="px-btn px-btn-o" @click="play">↻ replay</button>
      </div>
      <ol class="px-tb-steps" aria-label="Tuning steps">
        <li v-for="st in STEPS" :key="st.n">
          <button
            type="button"
            :class="{ done: st.n < beat }"
            :aria-current="st.n === beat ? 'step' : undefined"
            @click="goto(st.n)"
          >
            <span class="dot">{{ st.n }}</span>{{ " "
            }}<span class="t">{{ st.n === 4 ? "Guard · tuned" : st.title }}</span>{{ " "
            }}<code>{{ st.api }}</code>
          </button>
        </li>
      </ol>
      <div class="px-tb-body">
        <div>
          <p class="px-tb-key">
            <span class="lbl">Rows in the table</span>{{ " " }}
            <template v-for="(l, s) in SIZE_LONG" :key="l"
              ><span class="k" :class="[`k${s}`, { on: keyOn === s }]"><i />{{ l }}</span
              >{{ " " }}</template
            >
            <span class="note"
              >Each request is measured at all three sizes. The bigger the table, the thicker its
              column.</span
            >
          </p>
          <div class="px-tb-plot">
            <div class="px-tb-chart px-tb-v">
              <svg :viewBox="`0 0 ${V.W} ${V.H}`" role="img" aria-labelledby="px-tb-tv">
                <title id="px-tb-tv">
                  Median time per request at 200,000, 1 million and 10 million rows: three columns
                  per request, wider for the bigger table. Taller is slower; each step of the scale
                  is ten times the one below.
                </title>
                <defs>
                  <pattern
                    id="px-tb-vc"
                    :width="V.cell"
                    :height="V.cell"
                    patternUnits="userSpaceOnUse"
                  >
                    <rect :width="V.cell - 1.5" :height="V.cell - 1.5" fill="#fff" />
                  </pattern>
                  <mask
                    id="px-tb-vm"
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="4000"
                    height="4000"
                  >
                    <rect width="4000" height="4000" fill="url(#px-tb-vc)" />
                  </mask>
                </defs>
                <g v-for="g in vert.grid" :key="g.t">
                  <line class="grid" :x1="V.L" :x2="V.W - V.R" :y1="g.y" :y2="g.y" />
                  <text class="ax" :x="V.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.t }}</text>
                </g>
                <line
                  class="base"
                  :x1="V.L"
                  :x2="V.W - V.R"
                  :y1="vert.base + 0.5"
                  :y2="vert.base + 0.5"
                />
                <text class="ax" :x="V.L - 8" :y="vert.base + 17" text-anchor="end">rows</text>
                <g
                  v-for="g in vert.groups"
                  :key="g.r.key"
                  class="px-tb-grp"
                  :class="[`s-${g.r.key}`, { flat: g.r.flat, found: found.includes(g.r.key) }]"
                  :data-i="g.i"
                >
                  <g mask="url(#px-tb-vm)">
                    <g v-if="ks[g.i]! > 0 && !g.r.flat" class="px-tb-ghost">
                      <rect
                        v-for="c in g.cols"
                        :key="c.x"
                        :x="c.x"
                        :y="c.gy"
                        :width="c.w"
                        :height="c.gh"
                      />
                    </g>
                    <g class="px-tb-live">
                      <rect
                        v-for="c in g.cols"
                        :key="c.x"
                        :x="c.x"
                        :y="c.y"
                        :width="c.w"
                        :height="c.h"
                      />
                    </g>
                  </g>
                  <text
                    v-for="(c, s) in g.cols"
                    :key="`s${s}`"
                    class="szl"
                    :class="`s${s}`"
                    :x="c.cx"
                    :y="vert.base + 17"
                    text-anchor="middle"
                  >
                    {{ SIZE_LABEL[s] }}
                  </text>
                  <text
                    v-if="grow[LAST]! > 0.99"
                    class="val"
                    :x="valuePos(g.i, g.cols[LAST]!.cx).x"
                    :y="g.top"
                    :text-anchor="valuePos(g.i, g.cols[LAST]!.cx).anchor"
                  >
                    <tspan class="vs">10M: </tspan>{{ labelAt(g.i, LAST)
                    }}<tspan v-if="noteAt(g.i)" class="vs">{{ noteAt(g.i) }}</tspan>
                  </text>
                  <rect
                    v-if="found.includes(g.r.key)"
                    class="ring"
                    :x="g.ring.x"
                    :y="g.ring.y"
                    :width="g.ring.w"
                    :height="g.ring.h"
                    rx="6"
                  />
                  <text class="gl" :x="g.cx" :y="vert.base + 38" text-anchor="middle">
                    <tspan v-for="(w, j) in g.words" :key="j" :x="g.cx" :dy="j ? 14 : 0">{{
                      w + " "
                    }}</tspan>
                  </text>
                </g>
              </svg>
            </div>
            <div class="px-tb-chart px-tb-h">
              <svg :viewBox="`0 0 ${HZ.W} ${horiz.H}`" role="img" aria-labelledby="px-tb-th">
                <title id="px-tb-th">
                  Median time per request at 200,000, 1 million and 10 million rows: one bar per
                  table size, thicker for the bigger table. Longer is slower; each step of the scale
                  is ten times the one before.
                </title>
                <defs>
                  <pattern
                    id="px-tb-hc"
                    :width="HZ.cell"
                    :height="HZ.cell"
                    patternUnits="userSpaceOnUse"
                  >
                    <rect :width="HZ.cell - 1.5" :height="HZ.cell - 1.5" fill="#fff" />
                  </pattern>
                  <mask
                    id="px-tb-hm"
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="4000"
                    height="4000"
                  >
                    <rect width="4000" height="4000" fill="url(#px-tb-hc)" />
                  </mask>
                </defs>
                <g v-for="g in horiz.grid" :key="g.t">
                  <line class="grid" :x1="g.x" :x2="g.x" :y1="horiz.T - 4" :y2="horiz.H" />
                  <text class="ax" :x="g.x" :y="horiz.T - 9" text-anchor="middle">{{ g.t }}</text>
                </g>
                <g
                  v-for="g in horiz.groups"
                  :key="g.r.key"
                  class="px-tb-grp"
                  :class="[`s-${g.r.key}`, { flat: g.r.flat, found: found.includes(g.r.key) }]"
                  :data-i="g.i"
                >
                  <text class="gl h" x="0" :y="g.y0 + 13">
                    {{ g.r.label }}<tspan v-if="noteAt(g.i)" class="vs">{{ noteAt(g.i) }}</tspan>
                  </text>
                  <g mask="url(#px-tb-hm)">
                    <g v-if="ks[g.i]! > 0 && !g.r.flat" class="px-tb-ghost">
                      <rect
                        v-for="b in g.bars"
                        :key="b.y"
                        :x="HZ.L"
                        :y="b.y"
                        :width="b.gw"
                        :height="b.th"
                      />
                    </g>
                    <g class="px-tb-live">
                      <rect
                        v-for="b in g.bars"
                        :key="b.y"
                        :x="HZ.L"
                        :y="b.y"
                        :width="b.w"
                        :height="b.th"
                      />
                    </g>
                  </g>
                  <g v-for="(b, s) in g.bars" :key="`t${s}`">
                    <text class="szl" :class="`s${s}`" x="0" :y="b.mid + 4">
                      {{ SIZE_LABEL[s] }}
                    </text>
                    <text
                      v-if="grow[s]! > 0.99"
                      class="hv"
                      :x="HZ.W"
                      :y="b.mid + 4"
                      text-anchor="end"
                    >
                      {{ labelAt(g.i, s) }}<tspan class="vs"> · {{ SIZE_LABEL[s] }}</tspan>
                    </text>
                  </g>
                  <rect
                    v-if="found.includes(g.r.key)"
                    class="ring"
                    x="-4"
                    :y="g.y0 + 1"
                    :width="HZ.W + 8"
                    :height="g.blockH - 6"
                    rx="6"
                  />
                </g>
              </svg>
            </div>
            <canvas ref="rain" aria-hidden="true" />
          </div>
        </div>
        <div class="px-tb-con" aria-live="polite">
          <div class="px-tb-code">
            <div class="bar">
              <template v-if="beat === 0">Before tuning</template>
              <template v-else>Step <b>{{ beat }}</b> of 4</template>{{ " " }}
              <span>{{ STEPS[beat]!.api }}</span>
            </div>
            <pre><span v-for="(l, j) in consoleFor.lines" :key="j" class="ln" :class="l[0]">{{ l[1] + "\n" }}</span></pre>
          </div>
          <p class="say">{{ consoleFor.say }}</p>
          <NuxtLink v-if="beat > 0" class="go" :to="STEPS[beat]!.href"
            >Read about {{ STEPS[beat]!.api.split(" ")[0] }} →</NuxtLink
          >
        </div>
      </div>
      <p class="px-src">
        <b>Measured</b> on the repository's benchmark (orders and customers), {{ data.measuredOn }},
        engine {{ data.engine }}: PostgreSQL {{ data.postgres }} on {{ data.cpus }} CPUs,
        <b>one client</b>, median of {{ data.runs }} runs. Times are the engine's own, without HTTP.
        <NuxtLink to="/scale/benchmarks">Benchmark details →</NuxtLink>
      </p>
      <details class="px-tb-all">
        <summary>All numbers, as a table</summary>
        <div class="tbl">
          <table>
            <caption>
              Median milliseconds, one client. Page + count is an exact count out of the box and a
              count capped at
              {{ data.tunedSettings.countCap.toLocaleString("en-US") }}
              tuned.
            </caption>
            <thead>
              <tr>
                <th rowspan="2">Request</th>
                <th colspan="3">Out of the box</th>
                <th colspan="3">Tuned</th>
                <th rowspan="2">Tuned vs out of the box</th>
              </tr>
              <tr>
                <th v-for="(l, j) in [...SIZE_LABEL, ...SIZE_LABEL]" :key="j">{{ l }} rows</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.key">
                <th scope="row">{{ r.label }}</th>
                <td v-for="(v, s) in r.outOfTheBox" :key="`o${s}`">{{ fmt(v) }} ms</td>
                <td v-for="(v, s) in r.tuned" :key="`t${s}`">{{ fmt(v) }} ms</td>
                <td>{{ verdictText(r.verdict) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  </section>
</template>
