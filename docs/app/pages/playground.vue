<script setup lang="ts">
import type { TableColumn, TabsItem } from "@nuxt/ui";
import type { PlaygroundRequest } from "../utils/playground-request";
import type { createPlaygroundClient } from "../utils/playground.client";

import {
  basePlaygroundRequest,
  defaultPlaygroundRequest,
  formatValidationError,
  playgroundContractSnippet,
  playgroundContext,
  playgroundRequestSchema,
  playgroundSeedSummary,
  playgroundTablesSnippet,
} from "../utils/playground-request";

definePageMeta({
  layout: "default",
  footer: false,
});

useSeo({
  title: "Playground",
  description:
    "Edit a real drizzle-resource request, validate it live, and run it against an in-browser SQLite database powered by sql.js and Drizzle.",
  type: "website",
});

const requestText = ref(JSON.stringify(basePlaygroundRequest, null, 2));
const isBooting = ref(true);
const isRunning = ref(false);
const bootMessage = ref("Loading playground database…");
const bootstrapError = ref<string | null>(null);
const runtimeError = ref<string | null>(null);
const validationError = ref<string | null>(null);
type PlaygroundClient = Awaited<ReturnType<typeof createPlaygroundClient>>;
type PlaygroundResult = Awaited<ReturnType<PlaygroundClient["run"]>>;
type PlaygroundRow = PlaygroundResult["rows"][number];

const lastAppliedRequest = ref<PlaygroundRequest | null>(null);
const lastRunAt = ref<string | null>(null);
const result = shallowRef<PlaygroundResult | null>(null);
const playground = shallowRef<PlaygroundClient | null>(null);

const mobileTab = ref<"editor" | "results">("editor");
const editorTab = ref<"request" | "contract" | "tables">("request");

const examples = [
  {
    label: "Base",
    value: basePlaygroundRequest,
  },
  {
    label: "Pending + Processing",
    value: defaultPlaygroundRequest,
  },
  {
    label: "Laptop Search",
    value: {
      ...basePlaygroundRequest,
      search: {
        value: "laptop",
        fields: [],
      },
    } satisfies PlaygroundRequest,
  },
  {
    label: "Nested OR Group",
    value: {
      ...basePlaygroundRequest,
      filters: [
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "condition",
              key: "status",
              operator: "is",
              value: "pending",
            },
            {
              type: "condition",
              key: "orderLines.product.category",
              operator: "is",
              value: "audio",
            },
          ],
        },
      ],
      facets: [
        { key: "status", mode: "exclude-self", limit: 10 },
        { key: "orderLines.product.category", mode: "exclude-self", limit: 10 },
      ],
    } satisfies PlaygroundRequest,
  },
] as const;

const PRODUCTS_VISIBLE = 2;

const statusColor: Record<string, "warning" | "primary" | "success" | "error" | "neutral"> = {
  pending: "warning",
  processing: "primary",
  shipped: "success",
  cancelled: "error",
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const tableColumns: TableColumn<PlaygroundRow>[] = [
  { accessorKey: "reference", header: "Reference" },
  { accessorKey: "status", header: "Status" },
  { accessorKey: "customer", header: "Customer", cell: ({ row }) => row.original.customer.name },
  { accessorKey: "orderLines", header: "Products" },
  {
    accessorKey: "totalAmount",
    header: "Total",
    cell: ({ row }) => currencyFormatter.format(row.original.totalAmount),
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => dateFormatter.format(new Date(row.original.createdAt)),
  },
];

const rows = computed(() => result.value?.rows ?? []);
const facets = computed(() => result.value?.facets ?? []);
const rowCount = computed(() => result.value?.rowCount ?? 0);
const activeFilterCount = computed(() => lastAppliedRequest.value?.filters.length ?? 0);

const sampleOptions = computed(() =>
  examples.map((example) => ({
    label: example.label,
    value: example.label,
  })),
);

const selectedExample = ref<(typeof examples)[number]["label"]>(examples[0]!.label);

const editorTabs = [
  {
    label: "Request",
    value: "request",
    icon: "i-lucide-file-json-2",
    slot: "request",
  },
  {
    label: "Contract",
    value: "contract",
    icon: "i-lucide-file-code-2",
    slot: "contract",
  },
  {
    label: "Tables",
    value: "tables",
    icon: "i-lucide-database",
    slot: "tables",
  },
] satisfies TabsItem[];

const contractMarkdown = `\`\`\`ts [orders.resource.ts]
${playgroundContractSnippet}
\`\`\``;

const tablesMarkdown = `\`\`\`ts [schema.ts]
${playgroundTablesSnippet}
\`\`\``;

let runTimer: ReturnType<typeof setTimeout> | undefined;

function setExample(label: string) {
  const example = examples.find((entry) => entry.label === label) ?? examples[0]!;
  selectedExample.value = example.label;
  requestText.value = JSON.stringify(example.value, null, 2);
}

function parseRequestText() {
  try {
    const parsed = JSON.parse(requestText.value);
    const validated = playgroundRequestSchema.safeParse(parsed);

    if (!validated.success) {
      return {
        data: null,
        error: formatValidationError(validated.error),
      };
    }

    return {
      data: validated.data,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: formatValidationError(error as Error),
    };
  }
}

async function runRequest(request: PlaygroundRequest) {
  if (!playground.value) return;

  isRunning.value = true;
  runtimeError.value = null;
  console.debug("[playground-page] applying request");

  try {
    const nextResult = await playground.value.run(request);
    result.value = nextResult;
    lastAppliedRequest.value = request;
    lastRunAt.value = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
  } catch (error) {
    runtimeError.value = formatValidationError(error as Error);
    console.error("[playground-page] request failed", error);
  } finally {
    isRunning.value = false;
  }
}

watch(
  requestText,
  () => {
    clearTimeout(runTimer);

    const parsed = parseRequestText();
    validationError.value = parsed.error;

    if (!parsed.data || !playground.value) {
      return;
    }

    runTimer = setTimeout(() => {
      void runRequest(parsed.data);
    }, 250);
  },
  { immediate: false },
);

onMounted(async () => {
  try {
    bootMessage.value = "Loading SQL engine…";
    const { createPlaygroundClient } = await import("../utils/playground.client");
    bootMessage.value = "Opening pre-seeded playground database…";
    playground.value = await createPlaygroundClient();

    bootMessage.value = "Running initial query…";
    const parsed = parseRequestText();
    validationError.value = parsed.error;

    if (parsed.data) {
      await runRequest(parsed.data);
    }
  } catch (error) {
    bootstrapError.value = formatValidationError(error as Error);
    console.error("[playground-page] bootstrap failed", error);
  } finally {
    isBooting.value = false;
    bootMessage.value = "Playground ready";
  }
});

onBeforeUnmount(() => {
  clearTimeout(runTimer);
  playground.value?.dispose();
});
</script>

<template>
  <div class="flex h-[calc(100svh-var(--ui-header-height,64px))] flex-col overflow-hidden">
    <!-- Top bar -->
    <div
      class="flex shrink-0 items-center gap-3 border-b border-default bg-default/80 px-4 py-2.5 backdrop-blur"
    >
      <UBadge color="primary" variant="soft" size="sm">Browser Playground</UBadge>

      <div class="hidden items-center gap-2 text-xs text-toned sm:flex">
        <span>
          {{ playgroundSeedSummary.orders.toLocaleString() }} orders ·
          {{ playgroundSeedSummary.customers.toLocaleString() }} customers ·
          {{ playgroundSeedSummary.products.toLocaleString() }} products
        </span>
        <UBadge color="neutral" variant="subtle" size="sm">
          orgId: {{ playgroundContext.orgId }}
        </UBadge>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <div v-if="isBooting || isRunning" class="flex items-center gap-1.5">
          <span class="size-1.5 animate-pulse rounded-full bg-primary" />
          <span class="text-xs text-primary">{{ isBooting ? "Booting…" : "Running…" }}</span>
        </div>
        <div v-else-if="!validationError" class="flex items-center gap-1.5">
          <span class="size-1.5 rounded-full bg-success" />
          <span class="text-xs text-success">Valid</span>
        </div>
        <div v-else-if="validationError" class="flex items-center gap-1.5">
          <span class="size-1.5 rounded-full bg-error" />
          <span class="text-xs text-error">Invalid</span>
        </div>
      </div>
    </div>

    <!-- Mobile tab bar -->
    <div class="flex shrink-0 border-b border-default sm:hidden">
      <button
        v-for="tab in [
          { id: 'editor', label: 'Editor', icon: 'i-lucide-code-2' },
          { id: 'results', label: 'Results', icon: 'i-lucide-table-2' },
        ]"
        :key="tab.id"
        class="flex flex-1 items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors"
        :class="
          mobileTab === tab.id
            ? 'border-b-2 border-primary text-primary'
            : 'text-toned hover:text-default'
        "
        @click="mobileTab = tab.id as 'editor' | 'results'"
      >
        <UIcon :name="tab.icon" class="size-4" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Split body -->
    <div class="flex min-h-0 flex-1">
      <!-- Editor panel -->
      <div
        :class="[
          'flex flex-col border-r border-default',
          mobileTab !== 'editor' ? 'hidden sm:flex' : 'flex',
          'w-full sm:w-[400px] lg:w-[460px] xl:w-[500px] shrink-0',
        ]"
      >
        <UTabs
          v-model="editorTab"
          :items="editorTabs"
          size="sm"
          variant="pill"
          color="neutral"
          class="flex min-h-0 flex-1 flex-col"
          :ui="{
            root: 'min-h-0 flex flex-1 flex-col',
            list: 'rounded-none',
            content: 'min-h-0 flex-1',
          }"
        >
          <template #request>
            <div class="flex h-full min-h-0 flex-col">
              <div
                class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-default p-4"
              >
                <USelectMenu
                  v-model="selectedExample"
                  value-key="value"
                  label-key="label"
                  :items="sampleOptions"
                  :search-input="false"
                  size="sm"
                  class="w-full"
                  @update:model-value="setExample"
                />
                <UButton
                  color="neutral"
                  icon="i-lucide-rotate-ccw"
                  size="sm"
                  @click="setExample(selectedExample)"
                >
                  Reset
                </UButton>
              </div>

              <div class="min-h-0 flex-1 overflow-hidden">
                <UTextarea
                  v-model="requestText"
                  :color="validationError ? 'error' : 'neutral'"
                  :variant="validationError ? 'outline' : 'none'"
                  size="sm"
                  :rows="26"
                  :autoresize="false"
                  spellcheck="false"
                  class="h-full min-h-0 w-full"
                  :ui="{
                    root: 'flex h-full min-h-0 w-full',
                    base: 'flex-1 h-full min-h-0 w-full rounded-none',
                  }"
                  placeholder="Paste a QueryRequest payload here"
                />
              </div>

              <div v-if="validationError" class="shrink-0 border-t border-default">
                <UAlert
                  color="error"
                  variant="soft"
                  title="Invalid request"
                  :description="validationError"
                  size="sm"
                  class="w-full rounded-none"
                />
              </div>

              <div v-if="bootstrapError" class="shrink-0 border-t border-default">
                <UAlert
                  color="error"
                  variant="soft"
                  title="Playground failed to boot"
                  :description="bootstrapError"
                  size="sm"
                  class="w-full rounded-none"
                />
              </div>
            </div>
          </template>

          <template #contract>
            <div class="flex h-full min-h-0 flex-col">
              <div class="min-h-0 flex-1 overflow-auto px-4 pb-4">
                <article class="prose prose-sm max-w-none [&_pre]:mt-0">
                  <MDC :value="contractMarkdown" tag="div" />
                </article>
              </div>
            </div>
          </template>

          <template #tables>
            <div class="flex h-full min-h-0 flex-col">
              <div class="min-h-0 flex-1 overflow-auto px-4 pb-4">
                <article class="prose prose-sm max-w-none [&_pre]:mt-0">
                  <MDC :value="tablesMarkdown" tag="div" />
                </article>
              </div>
            </div>
          </template>
        </UTabs>
      </div>

      <!-- Results panel -->
      <div
        :class="[
          'min-h-0 flex-1 overflow-y-auto',
          mobileTab !== 'results' ? 'hidden sm:block' : 'block',
        ]"
      >
        <div class="space-y-4 p-4">
          <!-- Stats row -->
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div
              v-for="stat in [
                { label: 'Matching rows', value: rowCount.toLocaleString() },
                { label: 'Page size', value: rows.length.toLocaleString() },
                { label: 'Active filters', value: activeFilterCount.toLocaleString() },
                { label: 'Last run', value: lastRunAt ?? '--:--:--', mono: true },
              ]"
              :key="stat.label"
              class="rounded-xl border border-default bg-default px-4 py-3"
            >
              <p class="text-xs text-toned">{{ stat.label }}</p>
              <p
                class="mt-1 text-xl font-semibold text-highlighted"
                :class="stat.mono ? 'font-mono text-base' : ''"
              >
                {{ stat.value }}
              </p>
            </div>
          </div>

          <!-- Runtime error -->
          <UAlert
            v-if="runtimeError"
            color="warning"
            variant="soft"
            title="Runtime constraint"
            :description="runtimeError"
          />

          <UCard
            v-if="isBooting"
            class="border-primary/20 bg-primary/5"
            :ui="{ body: 'p-5 sm:p-5' }"
          >
            <div class="flex items-start gap-4">
              <div
                class="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10"
              >
                <UIcon name="i-lucide-database-zap" class="size-5 animate-pulse text-primary" />
              </div>
              <div class="space-y-1">
                <p class="text-sm font-medium text-highlighted">Booting playground</p>
                <p class="text-sm text-toned">{{ bootMessage }}</p>
                <p class="text-xs text-toned">
                  Loading the pre-seeded SQLite file and warming the real drizzle-resource query
                  engine.
                </p>
              </div>
            </div>
          </UCard>

          <!-- Rows table -->
          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <template #header>
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium text-highlighted">Rows</p>
                  <p class="text-xs text-toned">
                    Showing {{ rows.length }} row{{ rows.length === 1 ? "" : "s" }} from the current
                    page
                  </p>
                </div>
                <UBadge color="neutral" variant="subtle" size="sm">
                  {{
                    lastAppliedRequest ? "Last valid request applied" : "Waiting for valid request"
                  }}
                </UBadge>
              </div>
            </template>

            <div class="table-scroll max-h-[400px] overflow-y-auto">
              <UTable
                :data="rows"
                :columns="tableColumns"
                :loading="isBooting || isRunning"
                empty="No rows match the current request."
                :ui="{ thead: 'sticky top-0 z-10 bg-default' }"
              >
                <template #reference-cell="{ row }">
                  <span class="font-mono text-xs text-highlighted">
                    {{ row.original.reference }}
                  </span>
                </template>

                <template #status-cell="{ row }">
                  <UBadge
                    :color="statusColor[row.original.status] ?? 'neutral'"
                    variant="subtle"
                    size="sm"
                    class="capitalize"
                  >
                    {{ row.original.status }}
                  </UBadge>
                </template>

                <template #orderLines-cell="{ row }">
                  <div class="flex flex-wrap items-center gap-1">
                    <UBadge
                      v-for="line in row.original.orderLines.slice(0, PRODUCTS_VISIBLE)"
                      :key="line.id"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      class="max-w-[140px] truncate"
                    >
                      {{ line.product.name }}
                    </UBadge>

                    <UTooltip
                      v-if="row.original.orderLines.length > PRODUCTS_VISIBLE"
                      :content="{
                        align: 'start',
                        side: 'top',
                      }"
                    >
                      <UBadge color="neutral" variant="soft" size="sm">
                        +{{ row.original.orderLines.length - PRODUCTS_VISIBLE }}
                      </UBadge>
                      <template #content>
                        <ul class="space-y-0.5 text-xs">
                          <li
                            v-for="line in row.original.orderLines.slice(PRODUCTS_VISIBLE)"
                            :key="line.id"
                          >
                            {{ line.product.name }}
                          </li>
                        </ul>
                      </template>
                    </UTooltip>

                    <span v-if="row.original.orderLines.length === 0" class="text-xs text-toned"
                      >—</span
                    >
                  </div>
                </template>
              </UTable>
            </div>
          </UCard>

          <!-- Facets -->
          <div class="space-y-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-highlighted">Facet buckets</p>
                <p class="text-xs text-toned">
                  Live aggregation results returned alongside the current query.
                </p>
              </div>
              <UBadge color="neutral" variant="subtle" size="sm">
                {{ facets.length }} facet{{ facets.length === 1 ? "" : "s" }}
              </UBadge>
            </div>

            <div v-if="facets.length > 0" class="grid gap-3 sm:grid-cols-2">
              <UCard v-for="facet in facets" :key="facet.key">
                <template #header>
                  <div class="flex items-center justify-between gap-2">
                    <p class="text-sm font-medium text-highlighted">{{ facet.key }}</p>
                    <UBadge color="neutral" variant="subtle" size="sm">
                      {{ facet.total ?? facet.options.length }} bucket{{
                        (facet.total ?? facet.options.length) === 1 ? "" : "s"
                      }}
                    </UBadge>
                  </div>
                </template>

                <div class="space-y-2">
                  <div
                    v-for="option in facet.options"
                    :key="`${facet.key}-${String(option.value)}`"
                    class="flex items-center justify-between gap-3"
                  >
                    <span class="truncate text-sm text-highlighted">{{ option.value }}</span>
                    <UBadge color="neutral" variant="soft" size="sm">{{ option.count }}</UBadge>
                  </div>
                  <p v-if="facet.options.length === 0" class="text-sm text-toned">
                    No options for the current request.
                  </p>
                </div>
              </UCard>
            </div>

            <UAlert
              v-else
              color="neutral"
              variant="soft"
              title="No facets requested"
              description="Add entries to request.facets to showcase live bucket counts in the playground."
            />
          </div>

          <!-- Last applied request -->
          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium text-highlighted">Last applied request</p>
                  <p class="text-xs text-toned">The most recent valid payload that actually ran.</p>
                </div>
                <UBadge color="neutral" variant="subtle" size="sm">
                  {{
                    lastAppliedRequest?.pagination.pageSize ??
                    basePlaygroundRequest.pagination.pageSize
                  }}
                  per page
                </UBadge>
              </div>
            </template>

            <pre
              class="max-h-64 overflow-y-auto rounded-lg bg-muted text-xs leading-6 text-toned"
              >{{ JSON.stringify(lastAppliedRequest ?? basePlaygroundRequest, null, 2) }}</pre
            >
          </UCard>
        </div>
      </div>
    </div>
  </div>
</template>
