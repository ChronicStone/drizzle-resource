<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { hl, hlMarked, inView, prefersReducedMotion } from "./px";

defineProps<{ bare?: boolean }>();

/*
 * One resource, everything out. Each config key fans out to what it produces:
 * the request it accepts, the SQL it runs, the types you get and the table it powers.
 */
type Key = "scope" | "search" | "sort" | "facets" | "pagination" | "views" | "summary";

const SOURCE: [Key | null, string][] = [
  [null, 'export const orders = engine.defineResource("orders", {'],
  ["views", "  views: { list: { select: { reference: true,"],
  ["views", "    totalAmount: true, customer: { select: { name: true } } } } },"],
  [null, "  query: {"],
  ["scope", '    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),'],
  ["search", '    search: { allowed: ["reference", "customer.name"] },'],
  ["sort", '    sort: { defaults: [{ key: "createdAt", dir: "desc" }] },'],
  ["facets", '    facets: { allowed: ["status"] },'],
  ["pagination", '    pagination: { modes: ["cursor"] },'],
  [null, "  },"],
  ["summary", "  summary: (o) => ({"],
  ["summary", "    revenue: sum(o.totalAmount),"],
  ["summary", "  }),"],
  [null, "});"],
];
const SOURCE_HTML = SOURCE.map(([, line]) => hl(line));

const KEYS: Key[] = ["scope", "search", "sort", "facets", "pagination", "views", "summary"];
const CAPTIONS: Record<Key, string> = {
  scope:
    "The tenant rule wraps every request on the server. The client can't send it or remove it.",
  search: "One search value, matched across the fields you allowed. Anything else is rejected.",
  sort: "A default order that pages cleanly, and a typed union of the keys clients may sort by.",
  facets: "Bucket counts for the sidebar, computed in one GROUPING SETS statement.",
  pagination: "Cursor pages with an opaque cursor. Exact counts only when asked for.",
  views:
    "The exact fields this view returns. Nothing else leaves the database, and the row type matches.",
  summary: "Totals over the whole filtered set, in the same request, typed by Drizzle.",
};

const REQUEST = hlMarked(`{
  ⟦views|view: "list"⟧,
  ⟦search|search: { value: "halv" }⟧,
  ⟦sort|sorting: [{ key: "createdAt", dir: "desc" }]⟧,
  ⟦facets|facets: [{ key: "status" }]⟧,
  ⟦pagination|pagination: { mode: "cursor", pageSize: 25 }⟧,
  ⟦summary|summary: true⟧,
}
⟦scope|// orgId comes from the server, never the client⟧`);

const SQL = hlMarked(
  `select ⟦views|"reference", "total_amount", c."name"⟧
from "orders" join "customers" c on ...
where ⟦scope|c."org_id" = $1⟧
  and ⟦search|("reference" ilike $2 or c."name" ilike $2)⟧
order by ⟦sort|"created_at" desc, "id" desc⟧
⟦pagination|limit 26⟧
-- one aggregate statement
select ⟦facets|"status", count(*)⟧, ⟦summary|sum("total_amount")⟧
group by ⟦facets|grouping sets (("status"), ())⟧`,
  "sql",
);

const TYPES = hlMarked(`type Row = {
  ⟦views|reference: string; totalAmount: number;
  customer: { name: string }⟧
}
type Response = {
  rows: Row[];
  ⟦pagination|pageInfo: { nextCursor: string | null }⟧;
  ⟦facets|facets: { status: { value: string; count: number }[] }⟧;
  ⟦summary|summary: { revenue: string | null }⟧;
}
⟦sort|type SortKey = "createdAt" | "reference" | …⟧
⟦search|type SearchField = "reference" | "customer.name"⟧`);

const ROWS = [
  ["ORD-29999", "Halvorsen Freight", "$4,128"],
  ["ORD-29981", "Halvorsen Freight", "$790"],
  ["ORD-29944", "Halvorsen Freight", "$2,310"],
];
const FACETS = [
  ["shipped", 612],
  ["pending", 231],
  ["processing", 264],
  ["cancelled", 98],
] as const;

const active = ref<Key>("scope");
/* on phones only one output panel shows at a time */
const outTab = ref(0);
const OUT_TABS = ["Request", "SQL", "Types", "Table"];
const copied = ref(false);
const stage = ref<HTMLElement | null>(null);
const sourceEl = ref<HTMLElement | null>(null);
const wires = ref("");
const ends = ref<{ x: number; y: number }[]>([]);
let touched = false;
let timer = 0;
let resizeObserver: ResizeObserver | undefined;

function pick(key: Key) {
  touched = true;
  active.value = key;
}

/* light up every part produced by the active key, then draw one wire to each panel */
function refresh() {
  const root = stage.value;
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => {
    el.classList.toggle("on", el.dataset.p === active.value);
  });
  const line = sourceEl.value?.querySelector<HTMLElement>(`.px-ln[data-k="${active.value}"]`);
  if (!line || window.innerWidth < 1050) {
    wires.value = "";
    ends.value = [];
    return;
  }
  const R = root.getBoundingClientRect();
  const lr = line.getBoundingClientRect();
  const sr = sourceEl.value!.getBoundingClientRect();
  const x1 = sr.right - R.left;
  const y1 = lr.top + lr.height / 2 - R.top;
  let d = "";
  const points = [{ x: x1, y: y1 }];
  root.querySelectorAll<HTMLElement>(".px-out").forEach((panel) => {
    const part = panel.querySelector<HTMLElement>(`[data-p="${active.value}"]`);
    if (!part) return;
    const pr = panel.getBoundingClientRect();
    const tr = part.getBoundingClientRect();
    const x2 = pr.left - R.left;
    const y2 = Math.max(pr.top + 18, Math.min(tr.top + tr.height / 2, pr.bottom - 10)) - R.top;
    const mx = x1 + (x2 - x1) * 0.5;
    d += `M${x1} ${y1} H ${mx} V ${y2} H ${x2} `;
    points.push({ x: x2, y: y2 });
  });
  wires.value = d;
  ends.value = points;
}

watch(active, () => nextTick(refresh));
onMounted(() => {
  refresh();
  document.fonts?.ready.then(refresh);
  resizeObserver = new ResizeObserver(refresh);
  resizeObserver.observe(stage.value!);
  if (prefersReducedMotion()) return;
  timer = window.setInterval(() => {
    if (touched || !stage.value || !inView(stage.value)) return;
    active.value = KEYS[(KEYS.indexOf(active.value) + 1) % KEYS.length]!;
  }, 2800);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  resizeObserver?.disconnect();
});

function copy() {
  navigator.clipboard?.writeText("bun add drizzle-resource").then(() => {
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1400);
  });
}
</script>

<template>
  <section class="px-hero" :class="{ 'px-bare': bare }">
    <div v-if="!bare" class="px-hero-top">
      <div>
        <div class="px-eye">drizzle-resource · <b>open source</b> · MIT</div>
        <h1>Typed list endpoints<br /><span class="px-acc">for Drizzle ORM.</span></h1>
      </div>
      <div>
        <p class="px-sub">
          Define a resource on a Drizzle table. You get request validation, filters, search,
          sorting, pagination, facets and totals, with the SQL and the TypeScript types to match.
          Select a key to see what it adds.
        </p>
        <div class="px-ctas">
          <NuxtLink class="px-btn px-btn-y" to="/start/quick-start">Get started →</NuxtLink>
          <button class="px-btn px-btn-o" type="button" @click="copy">
            bun add drizzle-resource <span>{{ copied ? "✓" : "⧉" }}</span>
          </button>
        </div>
      </div>
    </div>

    <div ref="stage" class="px-fan">
      <svg v-if="wires" class="px-fan-wires" aria-hidden="true">
        <path :d="wires" />
        <rect v-for="(p, i) in ends" :key="i" :x="p.x - 3" :y="p.y - 3" width="6" height="6" />
      </svg>

      <div ref="sourceEl" class="px-code px-src">
        <div class="px-code-bar">
          <b>orders.resource.ts</b>
          <span class="px-lines"><em class="px-pix">{{ SOURCE.length }}</em> lines</span>
        </div>
        <pre><div
          v-for="(l, i) in SOURCE"
          :key="i"
          class="px-ln"
          :class="{ on: l[0] === active }"
          :data-k="l[0] ?? undefined"
          @click="l[0] && pick(l[0])"
        ><span class="n">{{ i + 1 }}</span><!-- eslint-disable-next-line vue/no-v-html --><span v-html="SOURCE_HTML[i]" /></div></pre>
        <div class="px-keys" role="tablist">
          <button
            v-for="k in KEYS"
            :key="k"
            type="button"
            role="tab"
            :aria-selected="k === active"
            :class="{ on: k === active }"
            @click="pick(k)"
          >
            {{ k }}
          </button>
        </div>
      </div>

      <div class="px-outs-tabs" role="tablist" aria-label="Output">
        <button
          v-for="(t, n) in OUT_TABS"
          :key="t"
          type="button"
          role="tab"
          :aria-selected="outTab === n"
          :class="{ on: outTab === n }"
          @click="outTab = n"
        >
          {{ t }}
        </button>
      </div>
      <div class="px-outs">
        <div class="px-out" :class="{ cur: outTab === 0 }">
          <div class="px-out-h"><i />Request it accepts<small>validated</small></div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-html="REQUEST" />
        </div>
        <div class="px-out" :class="{ cur: outTab === 1 }">
          <div class="px-out-h"><i />SQL it runs<small>PostgreSQL</small></div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-html="SQL" />
        </div>
        <div class="px-out" :class="{ cur: outTab === 2 }">
          <div class="px-out-h"><i />Types you get<small>inferred</small></div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-html="TYPES" />
        </div>
        <div class="px-out" :class="{ cur: outTab === 3 }">
          <div class="px-out-h"><i />Table it powers<small>your UI</small></div>
          <div class="px-mini">
            <div class="px-mini-bar">
              <span class="px-part px-mini-lock" data-p="scope">🔒 acme</span>
              <span class="px-part px-mini-q" data-p="search">Search “halv”</span>
            </div>
            <div class="px-mini-body">
              <div class="px-part px-mini-fc" data-p="facets">
                <div v-for="[name, n] in FACETS" :key="name">{{ name }} <span>{{ n }}</span></div>
              </div>
              <div>
                <table>
                  <thead>
                    <tr class="px-part" data-p="views">
                      <th>reference</th>
                      <th>customer</th>
                      <th>total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in ROWS" :key="r[0]">
                      <td v-for="c in r" :key="c">{{ c }}</td>
                    </tr>
                  </tbody>
                </table>
                <div class="px-mini-sort">
                  <span class="px-part" data-p="sort">sorted by createdAt ↓</span>
                </div>
              </div>
            </div>
            <div class="px-mini-ft">
              <span class="px-part" data-p="summary">revenue <b class="px-pix">$411,230</b></span>
              <span class="px-part px-mini-next" data-p="pagination">Next →</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p class="px-fan-cap"><b>{{ active }}</b><span>{{ CAPTIONS[active] }}</span></p>
  </section>
</template>
