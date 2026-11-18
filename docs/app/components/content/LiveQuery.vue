<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import { hl } from "../landing/px";

/*
 * Runs a request against the real drizzle-resource engine, in the browser, on the playground's
 * SQLite database (10,000 orders). Shows the rows, page info, facets and every SQL statement.
 * The request is editable: errors come from the engine itself.
 */
const props = withDefaults(
  defineProps<{
    request?: Record<string, unknown>;
    title?: string;
    show?: string[];
  }>(),
  { request: () => ({}), title: "", show: () => ["rows", "facets", "sql"] },
);

const BASE = {
  context: {},
  pagination: { mode: "offset", pageIndex: 1, pageSize: 5, count: "exact" },
  sorting: [],
  search: { value: "", fields: [] },
  filters: [],
  facets: [],
};

const source = ref(JSON.stringify(props.request, null, 2));
const editing = ref(false);
const running = ref(false);
const error = ref("");
const root = ref<HTMLElement | null>(null);
type RunResult = Awaited<
  ReturnType<
    Awaited<
      ReturnType<typeof import("../../utils/playground.client").createPlaygroundClient>
    >["run"]
  >
>;
const result = shallowRef<RunResult | null>(null);
const tab = ref<"rows" | "facets" | "sql">((props.show[0] as "rows") ?? "rows");
let observer: IntersectionObserver | undefined;
let debounce = 0;

const highlighted = computed(() => hl(source.value));
const playgroundLink = computed(() => {
  try {
    const json = JSON.stringify({ ...BASE, ...JSON.parse(source.value) });
    return `/playground?request=${encodeURIComponent(btoa(json))}`;
  } catch {
    return "/playground";
  }
});

async function run() {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source.value);
  } catch (e) {
    error.value = `Invalid JSON: ${(e as Error).message}`;
    return;
  }
  running.value = true;
  error.value = "";
  try {
    const { getSharedPlaygroundClient } = await import("../../utils/playground.client");
    const client = await getSharedPlaygroundClient();
    result.value = await client.run({ ...BASE, ...parsed } as never);
  } catch (e) {
    result.value = null;
    error.value = (e as Error).message || String(e);
  } finally {
    running.value = false;
  }
}

function onInput(e: Event) {
  source.value = (e.target as HTMLTextAreaElement).value;
  window.clearTimeout(debounce);
  debounce = window.setTimeout(run, 450);
}
function reset() {
  source.value = JSON.stringify(props.request, null, 2);
  run();
}

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect();
        run();
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(root.value!);
});
onBeforeUnmount(() => observer?.disconnect());

const money = (n: unknown) => `$${Number(n).toLocaleString("en-US")}`;
const pageInfo = computed(() => result.value?.pageInfo);
const facets = computed(() => result.value?.facets ?? []);
const statements = computed(() => result.value?.statements ?? []);
const sqlHtml = (sql: string) =>
  hl(
    sql
      .replace(/\s+/g, " ")
      .replace(
        / (from|where|order by|group by|limit|inner join|left join|and|union all) /gi,
        "\n$1 ",
      ),
    "sql",
  );
const maxCount = (opts: { count: number }[]) => Math.max(1, ...opts.map((o) => o.count));
</script>

<template>
  <div ref="root" class="px-embed px-live not-prose">
    <div class="px-win">
      <div class="px-win-h">
        <i />{{ title || "Live query" }}
        <small>real engine · 10,000 sample orders in your browser</small>
      </div>
      <div class="px-live-grid">
        <div class="px-live-req">
          <div class="px-live-bar">
            <span>request</span>
            <button type="button" @click="editing = !editing">
              {{ editing ? "done" : "edit" }}
            </button>
            <button type="button" @click="reset">reset</button>
            <NuxtLink :to="playgroundLink" class="px-live-open">playground →</NuxtLink>
          </div>
          <textarea
            v-if="editing"
            :value="source"
            spellcheck="false"
            aria-label="Request JSON"
            @input="onInput"
          />
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre v-else v-html="highlighted" />
        </div>
        <div class="px-live-res">
          <div class="px-live-bar">
            <button
              v-for="t in show"
              :key="t"
              type="button"
              :class="{ on: tab === t }"
              @click="tab = t as typeof tab"
            >
              {{ t === "sql" ? `sql (${statements.length})` : t }}
            </button>
            <span v-if="result" class="px-live-meta">
              {{ pageInfo?.rowCount?.toLocaleString("en-US") }} rows ·
              {{ result.elapsedMs.toFixed(1) }} ms
            </span>
            <span v-else-if="running" class="px-live-meta">running…</span>
          </div>
          <div v-if="error" class="px-live-err">{{ error }}</div>
          <div v-else-if="!result" class="px-live-wait">
            {{ running ? "Loading the in-browser database…" : "Runs when scrolled into view." }}
          </div>
          <template v-else>
            <table v-if="tab === 'rows'" class="px-live-table">
              <thead>
                <tr>
                  <th>reference</th>
                  <th>status</th>
                  <th>customer.name</th>
                  <th class="r">totalAmount</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in result.rows" :key="r.id">
                  <td class="mono">{{ r.reference }}</td>
                  <td>{{ r.status }}</td>
                  <td>{{ r.customer.name }}</td>
                  <td class="r">{{ money(r.totalAmount) }}</td>
                </tr>
                <tr v-if="!result.rows.length">
                  <td colspan="4" class="px-live-none">No rows match.</td>
                </tr>
              </tbody>
            </table>
            <div v-else-if="tab === 'facets'" class="px-live-facets">
              <p v-if="!facets.length" class="px-live-none">No facets requested.</p>
              <div v-for="f in facets" :key="f.key">
                <h4>{{ f.key }}</h4>
                <div v-for="o in f.options" :key="String(o.value)" class="px-live-bucket">
                  <span>{{ o.value }}</span>
                  <i><b :style="{ width: `${(o.count / maxCount(f.options)) * 100}%` }" /></i>
                  <em>{{ o.count.toLocaleString("en-US") }}</em>
                </div>
              </div>
            </div>
            <div v-else class="px-live-sql">
              <div v-for="(s, i) in statements" :key="i">
                <span class="px-live-n">{{ i + 1 }}</span>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <pre v-html="sqlHtml(s.sql)" />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
