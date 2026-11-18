<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/playground.css";
import type { PlaygroundRequest } from "../utils/playground-request";
import {
  formatValidationError,
  playgroundRequestSchema,
  playgroundSeedSummary,
} from "../utils/playground-request";
import {
  FACETS_ALLOWED,
  OP_LABEL,
  PAGE_SIZES,
  SCENARIOS,
  SEARCH_ALLOWED,
  SEARCH_DEFAULTS,
  SORT_DISABLED,
  baseRequest,
  conditionText,
  draftFor,
  groupText,
  money,
  num,
} from "../utils/playground-ui";
import type {
  Condition,
  FilterNode,
  Group,
  HoodTab,
  PlaygroundClient,
  PlaygroundResult,
} from "../utils/playground-ui";

definePageMeta({ layout: "default", footer: false });

useSeo({
  title: "Playground",
  description:
    "Filter, search, sort and facet 10,000 sample orders with the real drizzle-resource engine, in your browser. See the request, every SQL statement and the resource rules each action used.",
  type: "website",
});

/* ---------- state ---------- */
const bodyJson = (r: PlaygroundRequest) => {
  const { context: _c, ...body } = r;
  return JSON.stringify(body, null, 2);
};

const request = ref<PlaygroundRequest>(baseRequest());
const summary = ref(true);
const scenario = ref("table");
const hoodTab = ref<HoodTab>("request");
const mobileView = ref<"app" | "hood">("app");
const client = shallowRef<PlaygroundClient | null>(null);
const result = shallowRef<PlaygroundResult | null>(null);
const runError = ref<string | null>(null);
const booting = ref(true);
const running = ref(false);
const runId = ref(0);
const jsonText = ref(bodyJson(request.value));
const jsonError = ref<string | null>(null);
const editingJson = ref(false);
const expanded = ref<string | null>(null);
const copied = ref(false);
const facetsOpen = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let fromJson = false;

async function run() {
  if (!client.value) return;
  const parsed = playgroundRequestSchema.safeParse(request.value);
  if (!parsed.success) {
    runError.value = `The request schema rejected the body. ${formatValidationError(parsed.error)}`;
    runId.value++;
    return;
  }
  running.value = true;
  try {
    result.value = await client.value.run(parsed.data, { summary: summary.value });
    runError.value = null;
  } catch (error) {
    runError.value = (error as Error).message || String(error);
  } finally {
    running.value = false;
    runId.value++;
  }
}

watch(
  [request, summary],
  () => {
    if (!fromJson) jsonText.value = bodyJson(request.value);
    clearTimeout(timer);
    timer = setTimeout(run, 160);
  },
  { deep: true },
);

watch(jsonText, (text) => {
  if (text === bodyJson(request.value)) return;
  try {
    const parsed = JSON.parse(text);
    jsonError.value = null;
    fromJson = true;
    request.value = { context: {}, ...parsed };
    scenario.value = "";
    nextTick(() => (fromJson = false));
  } catch (error) {
    jsonError.value = `Invalid JSON: ${(error as Error).message}`;
  }
});

function useScenario(id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) return;
  scenario.value = id;
  request.value = s.make();
  hoodTab.value = s.tab;
  expanded.value = null;
  history.replaceState(null, "", `/playground#${id}`);
  nextTick(() =>
    document
      .querySelector(".pg-scen .on")
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }),
  );
}
const activeScenario = computed(() => SCENARIOS.find((s) => s.id === scenario.value));

/** any change made by hand leaves the scenario */
function touch() {
  scenario.value = "";
}

onMounted(async () => {
  const shared = new URLSearchParams(location.search).get("request");
  const fromHash = location.hash.slice(1);
  if (shared) {
    try {
      request.value = { ...baseRequest(), ...JSON.parse(atob(shared)) };
      scenario.value = "";
    } catch {
      runError.value = "The shared link could not be read.";
    }
  } else if (SCENARIOS.some((s) => s.id === fromHash)) useScenario(fromHash);
  window.addEventListener("keydown", onKey);
  try {
    const { getSharedPlaygroundClient } = await import("../utils/playground.client");
    client.value = await getSharedPlaygroundClient();
    await run();
  } catch (error) {
    runError.value = (error as Error).message;
  } finally {
    booting.value = false;
  }
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  window.removeEventListener("keydown", onKey);
});

const searchInput = ref<{ inputRef?: HTMLInputElement } | null>(null);
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) {
    e.preventDefault();
    searchInput.value?.inputRef?.focus();
  }
}

async function share() {
  const url = `${location.origin}/playground?request=${btoa(bodyJson(request.value))}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    history.replaceState(null, "", url);
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1600);
}
function reset() {
  useScenario("table");
}

/* ---------- search ---------- */
const searchFields = computed(() =>
  request.value.search.fields.length ? request.value.search.fields : SEARCH_DEFAULTS,
);
function toggleSearchField(f: string) {
  touch();
  const fields = request.value.search.fields;
  const base = fields.length ? fields : [...SEARCH_DEFAULTS];
  const next = base.includes(f) ? base.filter((x) => x !== f) : [...base, f];
  request.value.search.fields =
    next.length === SEARCH_DEFAULTS.length && SEARCH_DEFAULTS.every((d) => next.includes(d))
      ? []
      : next;
  resetPage();
}
function onSearch(value: string) {
  touch();
  request.value.search.value = value;
  resetPage();
}

/* ---------- filters ---------- */
const filters = computed(() => request.value.filters as FilterNode[]);
const editor = ref<{ index: number; draft: Condition } | null>(null);
const editorOpen = computed({
  get: () => editor.value !== null,
  set: (v) => {
    if (!v) editor.value = null;
  },
});
function openNew() {
  editor.value = { index: -1, draft: draftFor("status") };
}
function openEdit(index: number) {
  const node = filters.value[index];
  if (node?.type === "condition") editor.value = { index, draft: JSON.parse(JSON.stringify(node)) };
}
function applyFilter(c: Condition) {
  touch();
  if (!editor.value) return;
  if (editor.value.index < 0) filters.value.push(c);
  else filters.value.splice(editor.value.index, 1, c);
  editor.value = null;
  resetPage();
}
function removeFilter(index: number) {
  touch();
  filters.value.splice(index, 1);
  editor.value = null;
  resetPage();
}
function editGroup() {
  hoodTab.value = "request";
  editingJson.value = true;
  mobileView.value = "hood";
}
function clearAll() {
  touch();
  request.value.filters = [];
  request.value.search.value = "";
  resetPage();
}

/* ---------- facets ---------- */
function bucketCondition(key: string) {
  return filters.value.find(
    (n): n is Condition => n.type === "condition" && n.key === key && n.operator === "isAnyOf",
  );
}
const bucketOn = (key: string, value: unknown) =>
  !!(bucketCondition(key)?.value as unknown[] | undefined)?.includes(value);
function toggleBucket(key: string, value: unknown) {
  touch();
  let c = bucketCondition(key);
  if (!c) {
    c = { type: "condition", key, operator: "isAnyOf", value: [] };
    filters.value.push(c);
  }
  const values = c.value as unknown[];
  const i = values.indexOf(value);
  if (i >= 0) values.splice(i, 1);
  else values.push(value);
  if (!values.length) filters.value.splice(filters.value.indexOf(c), 1);
  resetPage();
}
const requestedFacets = computed(() => (request.value.facets ?? []).map((f) => f.key));
function toggleFacet(key: string) {
  touch();
  const facets = (request.value.facets ??= []);
  const i = facets.findIndex((f) => f.key === key);
  if (i >= 0) facets.splice(i, 1);
  else facets.push({ key, mode: "exclude-self", limit: 8 });
}
const facetMax = (opts: { count: number }[]) => Math.max(1, ...opts.map((o) => o.count));
const FIELD_NAME: Record<string, string> = {
  reference: "reference",
  "customer.name": "customer",
  "orderLines.product.name": "product",
  "orderLines.product.sku": "sku",
};
const shortKey = (k: string) => FIELD_NAME[k] ?? k;
const FACET_LABEL: Record<string, string> = {
  status: "Status",
  "orderLines.product.category": "Product category",
  "customer.name": "Customer",
};
const facetLabel = (k: string) => FACET_LABEL[k] ?? k;

/* ---------- sorting ---------- */
function sortBy(key: string, add: boolean) {
  touch();
  const sorting = request.value.sorting;
  const i = sorting.findIndex((s) => s.key === key);
  if (add) {
    if (i < 0) sorting.push({ key, dir: "desc" });
    else if (sorting[i]!.dir === "desc") sorting[i]!.dir = "asc";
    else sorting.splice(i, 1);
  } else {
    const dir = i === 0 && sorting[0]!.dir === "desc" ? "asc" : "desc";
    request.value.sorting = [{ key, dir }];
  }
  resetPage();
}
function sortState(key: string) {
  const i = request.value.sorting.findIndex((s) => s.key === key);
  if (i < 0) return null;
  return { dir: request.value.sorting[i]!.dir, rank: i + 1 };
}
const COLUMNS: { key: string; label: string; cls: string; disabled?: boolean }[] = [
  { key: "reference", label: "Order", cls: "c-ref" },
  { key: "customer.name", label: "Customer", cls: "c-cust" },
  { key: SORT_DISABLED, label: "Products", cls: "c-prod", disabled: true },
  { key: "totalAmount", label: "Total", cls: "c-num" },
  { key: "createdAt", label: "Created", cls: "c-date" },
];

/* ---------- pagination ---------- */
function resetPage() {
  request.value.pagination.pageIndex = 1;
  expanded.value = null;
}
const rowCount = computed(() => result.value?.pageInfo.rowCount ?? 0);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(rowCount.value / request.value.pagination.pageSize)),
);
function go(page: number) {
  touch();
  request.value.pagination.pageIndex = Math.min(pageCount.value, Math.max(1, page));
  expanded.value = null;
}
function setPageSize(size: number) {
  touch();
  request.value.pagination.pageSize = size;
  resetPage();
}
const items = (r: Row) => r.orderLines.reduce((n, l) => n + l.quantity, 0);
const dateText = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const yearText = (iso: string) => iso.slice(0, 4);
const compactMoney = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M` : money(n);
const revenue = computed(() => Number(result.value?.summary?.revenue ?? 0));
const stale = computed(() => !!runError.value || running.value);

/* search matches are marked in the cells */
const term = computed(() => request.value.search.value.trim().toLowerCase());
function marked(text: string, field: string) {
  const safe = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  if (!term.value || !searchFields.value.includes(field)) return safe;
  const i = text.toLowerCase().indexOf(term.value);
  if (i < 0) return safe;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + term.value.length))}</mark>${esc(text.slice(i + term.value.length))}`;
}
type Row = PlaygroundResult["rows"][number];
/** the first product, or the first one that matches the search */
function shownLine(r: Row) {
  if (term.value && searchFields.value.some((f) => f.startsWith("orderLines.product")))
    return (
      r.orderLines.find(
        (l) =>
          l.product.name.toLowerCase().includes(term.value) ||
          l.product.sku.toLowerCase().includes(term.value),
      ) ?? r.orderLines[0]
    );
  return r.orderLines[0];
}
function showRule() {
  hoodTab.value = "resource";
  mobileView.value = "hood";
}
</script>

<template>
  <div class="pg" :data-view="mobileView">
    <!-- ======== top bar ======== -->
    <header class="pg-top">
      <div class="pg-title">
        <h1>Playground</h1>
        <p>
          {{ num(playgroundSeedSummary.orders) }} orders in an in-browser SQLite database, queried
          by the real engine.
        </p>
      </div>
      <nav class="pg-scen" aria-label="Examples">
        <button
          v-for="s in SCENARIOS"
          :key="s.id"
          type="button"
          :class="{ on: scenario === s.id }"
          :aria-pressed="scenario === s.id"
          @click="useScenario(s.id)"
        >
          {{ s.label }}
        </button>
      </nav>
    </header>

    <div class="pg-sub">
      <p class="pg-note" :class="{ custom: !activeScenario }">
        <template v-if="activeScenario">
          {{ activeScenario.text }}
          <NuxtLink :to="activeScenario.docs">Docs →</NuxtLink>
        </template>
        <template v-else>Your own request. Copy the link to share it, or pick an example.</template>
      </p>
      <div class="pg-actions">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-rotate-ccw"
          label="Reset"
          @click="reset"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-link'"
          :label="copied ? 'Link copied' : 'Copy link'"
          @click="share"
        />
      </div>
    </div>

    <div class="pg-switch" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="mobileView === 'app'"
        @click="mobileView = 'app'"
      >
        The table
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="mobileView === 'hood'"
        @click="mobileView = 'hood'"
      >
        Under the hood
        <sup v-if="result && !runError">{{ result.statements.length }}</sup>
      </button>
    </div>

    <div class="pg-main">
      <!-- ======== the app ======== -->
      <section class="pg-app" aria-label="Orders table">
        <div class="pg-app-h">
          <span class="pg-kicker">What your users see</span>
          <span class="pg-scope" title="Set on the server from the session, not sent by the client">
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="5.5" width="8" height="5.5" rx="1" />
              <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" />
            </svg>
            signed in to <b>acme</b>
          </span>
        </div>

        <!-- toolbar -->
        <div class="pg-tool">
          <UInput
            ref="searchInput"
            :model-value="request.search.value"
            type="search"
            icon="i-lucide-search"
            placeholder="Search orders"
            aria-label="Search orders"
            color="neutral"
            class="pg-search"
            :ui="{ trailing: 'pe-2' }"
            @update:model-value="onSearch(String($event))"
          >
            <template #trailing><UKbd value="/" /></template>
          </UInput>
          <UPopover :content="{ align: 'end', sideOffset: 6 }">
            <UButton
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-chevron-down"
              class="pg-in"
            >
              <span class="pg-in-l">in</span>
              <span class="pg-in-v">{{
                searchFields.length > 2
                  ? `${searchFields.length} fields`
                  : searchFields.map((f) => shortKey(f)).join(", ")
              }}</span>
            </UButton>
            <template #content>
              <div class="pg-pop">
                <p class="pg-pop-h">Search in</p>
                <button
                  v-for="f in SEARCH_ALLOWED"
                  :key="f"
                  type="button"
                  class="pg-opt"
                  :class="{ on: searchFields.includes(f) }"
                  @click="toggleSearchField(f)"
                >
                  <span class="pg-check" /><code>{{ f }}</code>
                  <small v-if="SEARCH_DEFAULTS.includes(f)">default</small>
                </button>
                <p class="pg-pop-f">
                  Only fields in <code>search.allowed</code> can be picked. When the request names
                  none, the resource's defaults are used.
                </p>
              </div>
            </template>
          </UPopover>
          <USwitch
            v-model="summary"
            label="Totals"
            class="pg-totals"
            title="Pass summary: true to get totals over every matching order"
          />
        </div>

        <!-- filter chips -->
        <div class="pg-chips">
          <template v-for="(node, i) in filters" :key="i">
            <span v-if="node.type === 'group'" class="pg-chip group">
              <button
                type="button"
                class="pg-chip-b"
                title="Groups are edited in the request JSON"
                @click="editGroup"
              >
                <i>{{ (node as Group).combinator }}</i>
                <span>{{ groupText(node as Group) }}</span>
              </button>
              <button
                type="button"
                class="pg-chip-x"
                aria-label="Remove group"
                @click="removeFilter(i)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </span>
            <span v-else class="pg-chip">
              <button type="button" class="pg-chip-b" @click="openEdit(i)">
                <code>{{ node.key }}</code>
                <i>{{ OP_LABEL[node.operator] ?? node.operator }}</i>
                <b>{{ conditionText(node) }}</b>
              </button>
              <button
                type="button"
                class="pg-chip-x"
                aria-label="Remove filter"
                @click="removeFilter(i)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </span>
          </template>
          <UPopover v-model:open="editorOpen" :content="{ align: 'start', sideOffset: 6 }">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-list-filter"
              label="Filter"
              class="pg-add"
              @click="openNew"
            />
            <template #content>
              <PlaygroundFilterEditor
                v-if="editor"
                :key="editor.index"
                :initial="editor.draft"
                :editing="editor.index >= 0"
                @apply="applyFilter"
                @remove="removeFilter(editor!.index)"
                @cancel="editor = null"
              />
            </template>
          </UPopover>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-panel-left"
            class="pg-facets-toggle"
            :aria-expanded="facetsOpen"
            @click="facetsOpen = !facetsOpen"
          >
            Facets <sup>{{ requestedFacets.length }}</sup>
          </UButton>
          <UButton
            v-if="filters.length || request.search.value"
            color="neutral"
            variant="link"
            size="sm"
            label="Clear all"
            class="pg-clear"
            @click="clearAll"
          />
        </div>

        <div v-if="runError" class="pg-err" role="alert">
          <b>The engine rejected this request</b>
          <code>{{ runError }}</code>
          <span>
            No SQL ran.
            <button type="button" @click="showRule">See the rule</button>
            ·
            <button type="button" @click="reset">Reset</button>
          </span>
        </div>

        <div class="pg-body" :class="{ 'facets-open': facetsOpen }">
          <!-- facets -->
          <aside class="pg-facets" :class="{ stale }" aria-label="Facets">
            <div v-for="f in result?.facets ?? []" :key="f.key" class="pg-facet">
              <h3 :title="f.key">
                <span>{{ facetLabel(f.key) }}</span>
                <button
                  type="button"
                  class="pg-facet-x"
                  :aria-label="`Stop requesting the ${f.key} facet`"
                  @click="toggleFacet(f.key)"
                >
                  <UIcon name="i-lucide-x" />
                </button>
              </h3>
              <button
                v-for="o in f.options"
                :key="String(o.value)"
                type="button"
                class="pg-bucket"
                :class="{ on: bucketOn(f.key, o.value) }"
                :aria-pressed="bucketOn(f.key, o.value)"
                @click="toggleBucket(f.key, o.value)"
              >
                <span class="pg-check" />
                <span class="v">{{ o.value }}</span>
                <span class="n">{{ num(o.count) }}</span>
                <span class="bar"
                  ><b :style="{ transform: `scaleX(${o.count / facetMax(f.options)})` }"
                /></span>
              </button>
              <p v-if="!f.options.length" class="pg-facet-none">No values match.</p>
              <p v-if="f.total && f.total > f.options.length" class="pg-facet-more">
                {{ f.total - f.options.length }} more values
              </p>
            </div>
            <div
              v-if="FACETS_ALLOWED.some((x) => !requestedFacets.includes(x))"
              class="pg-facet-add"
            >
              <span>Add a facet</span>
              <button
                v-for="k in FACETS_ALLOWED.filter((x) => !requestedFacets.includes(x))"
                :key="k"
                type="button"
                @click="toggleFacet(k)"
              >
                <UIcon name="i-lucide-plus" /> {{ facetLabel(k) }}
              </button>
            </div>
          </aside>

          <!-- table -->
          <div class="pg-tablebox">
            <div class="pg-tablescroll" :class="{ stale }">
              <table class="pg-table">
                <thead>
                  <tr>
                    <th
                      v-for="c in COLUMNS"
                      :key="c.key"
                      :class="c.cls"
                      :aria-sort="
                        sortState(c.key)
                          ? sortState(c.key)!.dir === 'desc'
                            ? 'descending'
                            : 'ascending'
                          : undefined
                      "
                    >
                      <button
                        type="button"
                        :class="{ dis: c.disabled }"
                        :title="
                          c.disabled
                            ? 'Sorting is disabled by the resource: click to see the engine reject it'
                            : 'Click to sort. Shift-click to add a sort key.'
                        "
                        @click="sortBy(c.key, $event.shiftKey)"
                      >
                        <span>{{ c.label }}</span>
                        <UIcon v-if="c.disabled" name="i-lucide-lock" class="pg-lock" />
                        <span v-else-if="sortState(c.key)" class="pg-sort">
                          <UIcon
                            :name="
                              sortState(c.key)!.dir === 'desc'
                                ? 'i-lucide-arrow-down'
                                : 'i-lucide-arrow-up'
                            "
                          />
                          <sub v-if="request.sorting.length > 1">{{ sortState(c.key)!.rank }}</sub>
                        </span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody v-if="booting">
                  <tr v-for="n in 10" :key="n" class="pg-skel">
                    <td v-for="c in COLUMNS" :key="c.key" :class="c.cls"><i /></td>
                  </tr>
                </tbody>
                <tbody v-else-if="result">
                  <template v-for="r in result.rows" :key="r.id">
                    <tr
                      class="pg-row"
                      :class="{ open: expanded === r.id }"
                      tabindex="0"
                      :aria-expanded="expanded === r.id"
                      @click="expanded = expanded === r.id ? null : r.id"
                      @keydown.enter="expanded = expanded === r.id ? null : r.id"
                    >
                      <td class="c-ref">
                        <!-- eslint-disable vue/no-v-html -->
                        <span class="pg-l1 pg-ref" v-html="marked(r.reference, 'reference')" />
                        <span class="pg-l2 pg-status" :data-s="r.status"
                          ><i class="pg-st" />{{ r.status }}</span
                        >
                      </td>
                      <td class="c-cust">
                        <span class="pg-l1" v-html="marked(r.customer.name, 'customer.name')" />
                      </td>
                      <td class="c-prod">
                        <span
                          class="pg-l1"
                          v-html="
                            marked(shownLine(r)?.product.name ?? '—', 'orderLines.product.name')
                          "
                        />
                        <!-- eslint-enable vue/no-v-html -->
                        <span class="pg-l2"
                          >{{ shownLine(r)?.product.category
                          }}<template v-if="r.orderLines.length > 1">
                            · +{{ r.orderLines.length - 1 }} more</template
                          ></span
                        >
                      </td>
                      <td class="c-num">
                        <span class="pg-l1">{{ money(r.totalAmount) }}</span>
                        <span class="pg-l2"
                          >{{ items(r) }} {{ items(r) === 1 ? "item" : "items" }}</span
                        >
                      </td>
                      <td class="c-date">
                        <span class="pg-l1">{{ dateText(r.createdAt) }}</span>
                        <span class="pg-l2">{{ yearText(r.createdAt) }}</span>
                      </td>
                    </tr>
                    <tr v-if="expanded === r.id" class="pg-detail">
                      <td colspan="5">
                        <div class="pg-detail-in">
                          <div class="pg-detail-h">
                            <span
                              ><code>{{ r.reference }}</code> · {{ r.status }} ·
                              {{ r.customer.name }}</span
                            >
                            <small>orderLines with product, loaded in the rows step</small>
                          </div>
                          <table>
                            <tbody>
                              <tr v-for="l in r.orderLines" :key="l.id">
                                <!-- eslint-disable vue/no-v-html -->
                                <td v-html="marked(l.product.name, 'orderLines.product.name')" />
                                <td>
                                  <code v-html="marked(l.product.sku, 'orderLines.product.sku')" />
                                </td>
                                <!-- eslint-enable vue/no-v-html -->
                                <td>{{ l.product.category }}</td>
                                <td class="c-num">× {{ l.quantity }}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </template>
                  <tr v-if="!result.rows.length && !runError">
                    <td colspan="5" class="pg-empty">
                      <UIcon name="i-lucide-search-x" class="pg-empty-i" />
                      <b>No orders match.</b>
                      <span v-if="rowCount > 0">This page is past the last one.</span>
                      <span v-else>Remove a filter or change the search.</span>
                      <UButton
                        color="neutral"
                        variant="outline"
                        size="sm"
                        icon="i-lucide-x"
                        label="Clear filters"
                        @click="clearAll"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <footer class="pg-foot">
              <div class="pg-count">
                <template v-if="result">
                  <span class="pg-stat"
                    ><b class="pg-pix">{{ num(rowCount) }}</b> orders</span
                  >
                  <span v-if="summary && result.summary" class="pg-stat" :title="money(revenue)"
                    ><b class="pg-pix">{{ compactMoney(revenue) }}</b> revenue</span
                  >
                </template>
              </div>
              <div class="pg-pager">
                <USelect
                  :model-value="request.pagination.pageSize"
                  :items="PAGE_SIZES.map((n) => ({ label: `${n} rows`, value: n }))"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  aria-label="Rows per page"
                  class="pg-size"
                  @update:model-value="setPageSize(Number($event))"
                />
                <UPagination
                  :page="request.pagination.pageIndex"
                  :total="rowCount"
                  :items-per-page="request.pagination.pageSize"
                  :sibling-count="0"
                  show-edges
                  :show-controls="false"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  active-color="neutral"
                  active-variant="outline"
                  class="pg-pages"
                  @update:page="go"
                />
                <span class="pg-pageof"
                  >{{ num(request.pagination.pageIndex) }} / {{ num(pageCount) }}</span
                >
                <div class="pg-arrows">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-chevron-left"
                    aria-label="Previous page"
                    :disabled="request.pagination.pageIndex <= 1"
                    @click="go(request.pagination.pageIndex - 1)"
                  />
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-chevron-right"
                    aria-label="Next page"
                    :disabled="!result?.pageInfo.hasNextPage"
                    @click="go(request.pagination.pageIndex + 1)"
                  />
                </div>
              </div>
            </footer>
          </div>
        </div>
        <p class="pg-tip">
          <UIcon name="i-lucide-mouse-pointer-click" />
          <span>
            Click a row for its order lines. <UKbd value="shift" size="sm" /> click a header to sort
            by a second key. <b>Products</b> is locked: the resource disables sorting on it.
          </span>
        </p>
      </section>

      <!-- ======== under the hood ======== -->
      <PlaygroundHood
        v-model:tab="hoodTab"
        v-model:json="jsonText"
        v-model:editing="editingJson"
        :request="request"
        :result="result"
        :error="runError"
        :running="running"
        :summary="summary"
        :run-id="runId"
        :json-error="jsonError"
      />
    </div>
  </div>
</template>
