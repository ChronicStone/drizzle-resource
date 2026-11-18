<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  CATEGORIES,
  type Category,
  type Order,
  STATUSES,
  type Status,
  dayString,
  fmt,
  hl,
  sampleOrders,
} from "./px";

/* A real-feeling table driven by one resource definition. Each action lights the config line that allows it. */
const LINES: [string | null, string][] = (
  [
    [null, 'export const orders = engine.defineResource("orders", {'],
    [null, "  relations: { customer: true,"],
    [null, "    orderLines: { with: { product: true } } },"],
    [null, "  query: {"],
    ["scope", '    scope: (f, ctx) => f.is("customer.orgId", ctx.orgId),'],
    ["search", '    search: { allowed: ["reference", "customer.name"] },'],
    ["sort", "    sort: {"],
    ["sort", '      defaults: [{ key: "createdAt", dir: "desc" }],'],
    ["sortdis", '      disabled: ["orderLines.product.name"],'],
    ["sort", "    },"],
    ["facets", "    facets: {"],
    ["facets", '      allowed: ["status", "orderLines.product.category"],'],
    ["facets", "    },"],
    ["pagination", '    pagination: { modes: ["cursor", "offset"] },'],
    [null, "  },"],
    ["summary", "  summary: (o) => ({"],
    ["summary", "    rows: count(), revenue: sum(o.totalAmount),"],
    ["summary", "  }),"],
    [null, "});"],
  ] as [string | null, string][]
).map(([k, line]) => [k, hl(line)]);

type View = "list" | "export";
type Col = { key: string; label: string; sortable: boolean; right?: boolean };
const COLS: Record<View, Col[]> = {
  list: [
    { key: "reference", label: "reference", sortable: true },
    { key: "customer.name", label: "customer", sortable: true },
    { key: "orderLines.product.name", label: "products", sortable: false },
    { key: "totalAmount", label: "total", sortable: true, right: true },
    { key: "createdAt", label: "createdAt", sortable: true },
  ],
  export: [
    { key: "id", label: "id", sortable: true },
    { key: "reference", label: "reference", sortable: true },
    { key: "status", label: "status", sortable: true },
    { key: "totalAmount", label: "total", sortable: true, right: true },
    { key: "createdAt", label: "createdAt", sortable: true },
  ],
};
const PAGE_SIZE = 8;
const ORDERS = sampleOrders();
const value = (o: Order, key: string): string | number =>
  ({
    reference: o.ref,
    "customer.name": o.cust,
    "orderLines.product.name": o.prod,
    totalAmount: o.amt,
    createdAt: o.day,
    id: o.id,
    status: o.status,
  })[key] ?? "";

const state = reactive({
  q: "",
  statuses: new Set<Status>(),
  cats: new Set<Category>(),
  sort: { key: "createdAt", dir: "desc" as "asc" | "desc" },
  view: "list" as View,
  page: 0,
});
const paged = ref(false);

function filtered(skip?: "status" | "cat") {
  const q = state.q.trim().toLowerCase();
  return ORDERS.filter(
    (o) =>
      (!q || o.cust.toLowerCase().includes(q) || o.ref.toLowerCase().includes(q)) &&
      (skip === "status" || !state.statuses.size || state.statuses.has(o.status)) &&
      (skip === "cat" || !state.cats.size || state.cats.has(o.cat)),
  );
}
const rows = computed(() => {
  const dir = state.sort.dir === "desc" ? -1 : 1;
  const k = state.sort.key;
  return filtered().sort((a, b) => {
    const x = value(a, k);
    const y = value(b, k);
    return (x > y ? 1 : x < y ? -1 : a.id - b.id) * dir;
  });
});
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE_SIZE)));
const pageRows = computed(() =>
  rows.value.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE),
);
const revenue = computed(() => rows.value.reduce((a, o) => a + o.amt, 0));
const cursor = computed(() => {
  if (state.page === 0) return "";
  const last = pageRows.value.at(-1);
  return (
    btoa(JSON.stringify({ k: last ? value(last, state.sort.key) : 0, id: last?.id ?? 0 })).slice(
      0,
      14,
    ) + "…"
  );
});
const statusFacet = computed(() => {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const o of filtered("status")) counts[o.status]++;
  return counts;
});
const catFacet = computed(() => {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const o of filtered("cat")) counts[o.cat]++;
  return counts;
});
const maxOf = (r: Record<string, number>) => Math.max(1, ...Object.values(r));

/* highlight + wire */
const root = ref<HTMLElement | null>(null);
const codeEl = ref<HTMLElement | null>(null);
const active = ref<{ key: string; bad: boolean } | null>(null);
const wire = ref("");
const tip = ref<{ text: string; x: number; y: number } | null>(null);
let wireTimer = 0;
let tipTimer = 0;

function act(key: string, el: Element | null | undefined, bad = false) {
  const lineKey = key;
  active.value = { key: lineKey, bad };
  window.clearTimeout(wireTimer);
  wireTimer = window.setTimeout(() => (wire.value = ""), 2600);
  requestAnimationFrame(() => {
    const line = codeEl.value?.querySelector(`[data-k="${lineKey}"]`);
    if (!line || !el || !root.value || window.innerWidth < 1020) return;
    const R = root.value.getBoundingClientRect();
    const lr = line.getBoundingClientRect();
    const cr = codeEl.value!.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const x1 = cr.right - R.left;
    const y1 = lr.top + lr.height / 2 - R.top;
    const x2 = er.left - R.left;
    const y2 = Math.min(er.top + er.height / 2, er.top + 20) - R.top;
    const mx = (x1 + x2) / 2;
    wire.value = `M${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
  });
}
function showTip(el: Element, text: string) {
  if (!root.value) return;
  const R = root.value.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  tip.value = { text, x: Math.max(0, r.left - R.left - 80), y: r.bottom - R.top + 8 };
  window.clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => (tip.value = null), 3200);
}
function shake(el: Element) {
  el.classList.remove("px-shake");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("px-shake");
}
const lineClass = (k: string | null) => {
  if (!k || !active.value) return "";
  const on = k === active.value.key;
  return on ? (active.value.bad ? "bad" : "on") : "";
};

function onSearch(e: Event) {
  state.q = (e.target as HTMLInputElement).value;
  state.page = 0;
  paged.value = false;
  act("search", e.target as Element);
}
function toggleStatus(s: Status, e: Event) {
  if (state.statuses.has(s)) state.statuses.delete(s);
  else state.statuses.add(s);
  state.page = 0;
  paged.value = false;
  act("facets", (e.currentTarget as Element).closest(".px-fac"));
}
function toggleCat(c: Category, e: Event) {
  if (state.cats.has(c)) state.cats.delete(c);
  else state.cats.add(c);
  state.page = 0;
  paged.value = false;
  act("facets", (e.currentTarget as Element).closest(".px-fac"));
}
function sortBy(col: Col, e: Event) {
  const el = e.currentTarget as Element;
  if (!col.sortable) {
    shake(el);
    act("sortdis", el, true);
    showTip(
      el,
      "Sorting by a many-to-many path is turned off in sort.disabled. The server rejects it too.",
    );
    return;
  }
  state.sort =
    state.sort.key === col.key
      ? { key: col.key, dir: state.sort.dir === "desc" ? "asc" : "desc" }
      : { key: col.key, dir: "desc" };
  state.page = 0;
  paged.value = false;
  act("sort", el.closest("thead"));
}
function go(delta: number, e: Event) {
  state.page = Math.min(pages.value - 1, Math.max(0, state.page + delta));
  paged.value = true;
  act("pagination", (e.currentTarget as Element).closest(".px-pager"));
}
function lock(e: Event) {
  const el = e.currentTarget as Element;
  shake(el);
  act("scope", el, true);
  showTip(
    el,
    "The scope comes from the server context. The client can narrow results, never remove it.",
  );
}

function cell(o: Order, key: string) {
  const v = value(o, key);
  if (key === "reference")
    return `<span class="px-sd ${o.status}"></span><span class="px-ref">${v}</span>`;
  if (key === "totalAmount") return `$${fmt(v as number)}`;
  if (key === "createdAt") return `<span class="px-ref px-dim">${dayString(v as number)}</span>`;
  if (key === "id")
    return `<span class="px-ref">ord_${(((v as number) * 7919) % 99991).toString(36)}</span>`;
  if (key === "orderLines.product.name") return `<span class="px-dim">${v}</span>`;
  return String(v);
}
</script>

<template>
  <section class="px-blk">
    <div class="px-head">
      <h2>Try it on <span class="px-acc">a live table</span></h2>
      <p class="px-lede">
        2,412 sample orders, in your browser. Search, filter, sort and page: the line of the
        resource that allows each action lights up.
        <NuxtLink to="/playground" class="px-more">Open the full playground →</NuxtLink>
      </p>
    </div>
    <div ref="root" class="px-contract">
      <svg v-if="wire" class="px-wires" aria-hidden="true">
        <path :d="wire" :class="{ bad: active?.bad }" />
      </svg>
      <div class="px-left">
        <div ref="codeEl" class="px-code">
          <div class="px-code-bar">
            <b>orders.resource.ts</b><span style="margin-left: auto">the only file you write</span>
          </div>
          <pre><div v-for="(l, i) in LINES" :key="i" class="px-ln" :class="lineClass(l[0])" :data-k="l[0] ?? undefined"><span class="n">{{ i + 1 }}</span><!-- eslint-disable-next-line vue/no-v-html --><span v-html="l[1]" /></div></pre>
        </div>
      </div>
      <div class="px-app">
        <div class="px-app-bar">
          <span class="px-app-t">Orders</span>
          <button type="button" class="px-pill px-lock" @click="lock">🔒 org: acme</button>
          <input
            :value="state.q"
            placeholder="Search reference or customer"
            aria-label="Search orders"
            @input="onSearch"
          />
        </div>
        <div class="px-app-body">
          <aside class="px-fac">
            <div>
              <h4><span>status</span><span>exclude-self</span></h4>
              <button
                v-for="s in STATUSES"
                :key="s"
                type="button"
                class="px-fo"
                :class="{ on: state.statuses.has(s) }"
                @click="toggleStatus(s, $event)"
              >
                <span class="bx" />{{ s }}<span class="c">{{ fmt(statusFacet[s]) }}</span>
                <span class="lv"
                  ><i :style="{ width: `${(statusFacet[s] / maxOf(statusFacet)) * 100}%` }"
                /></span>
              </button>
            </div>
            <div>
              <h4><span>product.category</span></h4>
              <button
                v-for="c in CATEGORIES"
                :key="c"
                type="button"
                class="px-fo"
                :class="{ on: state.cats.has(c) }"
                @click="toggleCat(c, $event)"
              >
                <span class="bx" />{{ c }}<span class="c">{{ fmt(catFacet[c]) }}</span>
                <span class="lv"
                  ><i :style="{ width: `${(catFacet[c] / maxOf(catFacet)) * 100}%` }"
                /></span>
              </button>
            </div>
          </aside>
          <div class="px-tw">
            <table>
              <thead>
                <tr>
                  <th v-for="c in COLS[state.view]" :key="c.key" :class="{ r: c.right }">
                    <button
                      type="button"
                      :class="{ dis: !c.sortable, act: state.sort.key === c.key }"
                      @click="sortBy(c, $event)"
                    >
                      {{ c.label
                      }}{{
                        state.sort.key === c.key ? (state.sort.dir === "desc" ? " ↓" : " ↑") : ""
                      }}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody :class="{ pg: paged }">
                <tr v-for="o in pageRows" :key="`${state.page}-${o.id}`">
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <td
                    v-for="c in COLS[state.view]"
                    :key="c.key"
                    :class="{ r: c.right }"
                    v-html="cell(o, c.key)"
                  />
                </tr>
                <tr v-if="!pageRows.length">
                  <td colspan="5" class="px-empty">No orders match "{{ state.q }}".</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="px-app-foot">
          <div class="px-sum" @mouseenter="act('summary', $event.currentTarget as Element)">
            <div>
              <span>rows · count()</span><b class="px-pix">{{ fmt(rows.length) }}</b>
            </div>
            <div>
              <span>revenue · sum()</span><b class="px-pix">${{ fmt(revenue) }}</b>
            </div>
          </div>
          <div class="px-pager">
            <span>{{ state.page === 0 ? "first page" : `cursor ${cursor}` }}</span>
            <button type="button" :disabled="state.page === 0" @click="go(-1, $event)">←</button>
            <button type="button" :disabled="state.page >= pages - 1" @click="go(1, $event)">
              Next →
            </button>
          </div>
        </div>
      </div>
      <div v-if="tip" class="px-tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">
        {{ tip.text }}
      </div>
    </div>
  </section>
</template>
