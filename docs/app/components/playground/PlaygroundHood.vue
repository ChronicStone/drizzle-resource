<script setup lang="ts">
import { hl } from "../landing/px";
import type { PlaygroundRequest } from "../../utils/playground-request";
import {
  SCHEMA,
  callLines,
  changedLines,
  describeStatement,
  resourceHtml,
  sqlHtml,
} from "../../utils/playground-ui";
import type { HoodTab, PlaygroundResult } from "../../utils/playground-ui";

const props = defineProps<{
  request: PlaygroundRequest;
  result: PlaygroundResult | null;
  error: string | null;
  running: boolean;
  summary: boolean;
  /** bumps on every completed run, so changed lines flash again */
  runId: number;
  jsonError?: string | null;
}>();
const tab = defineModel<HoodTab>("tab", { required: true });
const json = defineModel<string>("json", { required: true });
const editing = defineModel<boolean>("editing", { required: true });

/* ----- request as a call, with the lines this change touched ----- */
const lines = computed(() => callLines(props.request, props.summary));
let previous: string[] = [];
const changed = ref(new Set<number>());
const body = ref<HTMLElement | null>(null);
watch(
  () => props.runId,
  async () => {
    changed.value = changedLines(previous, lines.value);
    previous = lines.value;
    await nextTick();
    /* bring the first changed line into view, inside the panel only */
    const line = body.value?.querySelector<HTMLElement>(".ln.chg");
    if (!line || !body.value) return;
    const box = body.value.getBoundingClientRect();
    const at = line.getBoundingClientRect();
    if (at.top < box.top || at.bottom > box.bottom)
      body.value.scrollTop += at.top - box.top - box.height / 3;
  },
);

/* ----- statements ----- */
const statements = computed(() =>
  (props.error ? [] : (props.result?.statements ?? [])).map((s) => ({
    ...describeStatement(s.sql, props.request),
    html: sqlHtml(s.sql, s.params),
  })),
);
const open = ref(new Set<number>());
watch(
  () => props.runId,
  () => (open.value = new Set()),
);
function toggleOpen(i: number) {
  const next = new Set(open.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  open.value = next;
}

/* ----- pipeline ----- */
const steps = computed(() => {
  const kinds = statements.value.map((s) => s.kind);
  const facets = props.request.facets?.length ?? 0;
  const failed = !!props.error;
  const st = (on: boolean) => (failed ? "off" : on ? "ok" : "skip");
  return [
    { id: "validate", label: "validate", state: failed ? "err" : "ok", jump: "resource" },
    { id: "scope", label: "scope", state: st(true), jump: "resource" },
    {
      id: "count",
      label: props.summary ? "summary" : "count",
      state: st(kinds.includes("count") || kinds.includes("summary")),
      jump: "sql",
    },
    { id: "ids", label: "page ids", state: st(kinds.includes("ids")), jump: "sql" },
    { id: "rows", label: "rows", state: st(kinds.includes("rows")), jump: "sql" },
    {
      id: "facets",
      label: facets ? `facets ×${facets}` : "facets",
      state: st(kinds.includes("facet")),
      jump: "sql",
    },
  ] as const;
});

const resource = computed(() => resourceHtml(props.request, props.summary, props.error));
const schemaHtml = hl(SCHEMA);

const response = computed(() => {
  if (!props.result) return "";
  const { statements: _s, elapsedMs: _e, rows, ...rest } = props.result;
  const preview = {
    rows: rows.length
      ? [rows[0], ...(rows.length > 1 ? [`… ${rows.length - 1} more rows`] : [])]
      : [],
    ...rest,
  };
  return hl(
    JSON.stringify(preview, null, 2)
      .split("\n")
      .map((l) => l.replace(/^(\s*)"([A-Za-z_]\w*)":/, "$1$2:"))
      .join("\n"),
  );
});

const TABS: { id: HoodTab; label: string }[] = [
  { id: "request", label: "Request" },
  { id: "sql", label: "SQL" },
  { id: "resource", label: "Resource" },
  { id: "response", label: "Response" },
  { id: "schema", label: "Schema" },
];
</script>

<template>
  <section class="pg-hood" aria-label="What the engine did">
    <header class="pg-hood-h">
      <span class="pg-kicker">Under the hood</span>
      <span class="pg-hood-stat">
        <template v-if="error">rejected · 0 statements</template>
        <template v-else-if="result">
          <b>{{ statements.length }}</b> statements · <b>{{ result.elapsedMs.toFixed(1) }}</b> ms
        </template>
      </span>
    </header>

    <ol class="pg-pipe" :class="{ busy: running }">
      <li v-for="(s, i) in steps" :key="s.id" :data-state="s.state">
        <button type="button" @click="tab = s.jump">
          <span class="pg-pipe-dot" :style="{ animationDelay: `${i * 70}ms` }" />{{ s.label }}
        </button>
      </li>
    </ol>

    <nav class="pg-tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        :class="{ on: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}<sup v-if="t.id === 'sql' && !error && result">{{ statements.length }}</sup>
      </button>
    </nav>

    <div ref="body" class="pg-hood-b">
      <!-- request -->
      <div v-if="tab === 'request'" class="pg-pane">
        <div class="pg-pane-h">
          <p>
            What the client sends, inside the server call. Lines that changed with your last action
            are marked.
          </p>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            :icon="editing ? 'i-lucide-check' : 'i-lucide-braces'"
            :label="editing ? 'Done' : 'Edit JSON'"
            @click="editing = !editing"
          />
        </div>
        <div v-if="editing" class="pg-json">
          <PlaygroundJsonEditor v-model="json" :invalid="!!jsonError" />
          <p v-if="jsonError" class="pg-json-err">{{ jsonError }}</p>
        </div>
        <!-- eslint-disable vue/no-v-html -->
        <pre v-else :key="runId" class="pg-code pg-call"><code><span
          v-for="(l, i) in lines"
          :key="i"
          class="ln"
          :class="{ chg: changed.has(i) }"
          v-html="hl(l) || ' '"
        /></code></pre>
        <!-- eslint-enable vue/no-v-html -->
      </div>

      <!-- sql -->
      <div v-else-if="tab === 'sql'" class="pg-pane">
        <div v-if="error" class="pg-none">
          <b>No SQL ran.</b> The engine checks every key against the resource before it builds a
          query.
        </div>
        <template v-else>
          <p class="pg-pane-p">
            Every statement for this request, in order, with its bound values. The scope value
            <code>'acme'</code> is in each one.
          </p>
          <article
            v-for="(s, i) in statements"
            :key="`${runId}-${i}`"
            class="pg-stmt"
            :data-kind="s.kind"
            :style="{ animationDelay: `${i * 60}ms` }"
          >
            <button type="button" class="pg-stmt-h" @click="toggleOpen(i)">
              <span class="pg-stmt-n">{{ String(i + 1).padStart(2, "0") }}</span>
              <b>{{ s.label }}</b>
              <span class="pg-stmt-note">{{ s.note }}</span>
            </button>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <pre class="pg-code" :class="{ clamp: !open.has(i) }" v-html="s.html" />
            <button
              v-if="!open.has(i) && s.html.split('\n').length > 7"
              type="button"
              class="pg-more"
              @click="toggleOpen(i)"
            >
              show all {{ s.html.split("\n").length }} lines
            </button>
          </article>
        </template>
      </div>

      <!-- resource -->
      <div v-else-if="tab === 'resource'" class="pg-pane">
        <p class="pg-pane-p">
          The resource behind this page. Highlighted parts are the ones this request used<template
            v-if="error"
            >, and in red the rule that rejected it</template
          >.
        </p>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <pre class="pg-code pg-res-code" v-html="resource" />
      </div>

      <!-- response -->
      <div v-else-if="tab === 'response'" class="pg-pane">
        <p class="pg-pane-p">
          The typed response. The first row is shown in full; order lines come from the relations.
        </p>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <pre class="pg-code" v-html="response" />
      </div>

      <!-- schema -->
      <div v-else class="pg-pane">
        <p class="pg-pane-p">
          The Drizzle tables. Field paths like <code>orderLines.product.category</code> are typed
          from these and the relations.
        </p>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <pre class="pg-code" v-html="schemaHtml" />
      </div>
    </div>
  </section>
</template>
