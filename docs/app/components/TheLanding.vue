<script setup lang="ts">
import { getHighlighter, bundledThemes } from "shiki";

const shikiLightTheme = "catppuccin-latte";
const shikiDarkTheme = "dracula";

const stripOuterCode = (html: string) =>
  html
    .replace(/^[\s\S]*?<code[^>]*>/, "")
    .replace(/<\/code>\s*<\/pre>[\s\S]*$/, "")
    .replace(/\n(?=<span class="line">)/g, "")
    .trim();

const rawHeroCode = [
  "const result = await orders.query({",
  "  context: { orgId: 'acme' },",
  "  request: {",
  "    pagination: { pageIndex: 1, pageSize: 25 },",
  "    sorting:    [{ key: 'createdAt', dir: 'desc' }],",
  "    search:     { value: 'laptop', fields: [] },",
  "    filters: {",
  "      type: 'group', combinator: 'and',",
  "      children: [{ type: 'condition', key: 'status',",
  "        operator: 'isAnyOf', value: ['pending', 'processing'] }],",
  "    },",
  "    facets: [{ key: 'status', mode: 'exclude-self', limit: 10 }],",
  "  },",
  "})",
].join("\n");

const rawRequestCode = [
  "await orders.query({",
  "  context: { orgId: 'acme' },",
  "  request: {",
  "    pagination: { pageIndex: 1, pageSize: 25 },",
  "    sorting:    [{ key: 'createdAt', dir: 'desc' }],",
  "    search:     { value: 'laptop', fields: [] },",
  "    filters: {",
  "      type: 'group', combinator: 'and',",
  "      children: [{",
  "        type: 'condition', key: 'status',",
  "        operator: 'isAnyOf',",
  "        value: ['pending', 'processing'],",
  "      }],",
  "    },",
  "    facets: [{ key: 'status', mode: 'exclude-self', limit: 10 }],",
  "  },",
  "})",
].join("\n");

const rawResourceCode = [
  "export const ordersResource = engine.defineResource('orders', {",
  "  relations: {",
  "    customer:   true,",
  "    orderLines: { with: { product: true } },",
  "  },",
  "  query: {",
  "    scope: (f, ctx) => f.is('customer.orgId', ctx.orgId),",
  "    search: {",
  "      allowed:  ['reference', 'customer.name'],",
  "      defaults: ['reference', 'customer.name'],",
  "    },",
  "    sort:   { defaults: [{ key: 'createdAt', dir: 'desc' }] },",
  "    facets: { allowed: ['status', 'customer.name'] },",
  "  },",
  "})",
].join("\n");

const highlighter = await getHighlighter({
  themes: [bundledThemes[shikiLightTheme], bundledThemes[shikiDarkTheme]],
  langs: ["ts"],
});

const heroHtmlLight = stripOuterCode(
  highlighter.codeToHtml(rawHeroCode, { lang: "ts", theme: shikiLightTheme }),
);
const heroHtmlDark = stripOuterCode(
  highlighter.codeToHtml(rawHeroCode, { lang: "ts", theme: shikiDarkTheme }),
);
const resourceHtmlLight = stripOuterCode(
  highlighter.codeToHtml(rawResourceCode, { lang: "ts", theme: shikiLightTheme }),
);
const resourceHtmlDark = stripOuterCode(
  highlighter.codeToHtml(rawResourceCode, { lang: "ts", theme: shikiDarkTheme }),
);
const requestHtmlLight = stripOuterCode(
  highlighter.codeToHtml(rawRequestCode, { lang: "ts", theme: shikiLightTheme }),
);
const requestHtmlDark = stripOuterCode(
  highlighter.codeToHtml(rawRequestCode, { lang: "ts", theme: shikiDarkTheme }),
);

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");

const pipeline = [
  {
    label: "Scope merge",
    desc: "Tenant filters run before any client filter",
    icon: "i-lucide-shield",
  },
  {
    label: "Field validation",
    desc: "Sort keys and filter paths checked against your schema",
    icon: "i-lucide-check-circle",
  },
  {
    label: "ID select",
    desc: "Paginated primary-key query with all filters applied",
    icon: "i-lucide-hash",
  },
  {
    label: "Row hydration",
    desc: "Rows loaded by ID with declared relations, in order",
    icon: "i-lucide-database",
  },
  {
    label: "Facets",
    desc: "Bucket counts resolved only when requested",
    icon: "i-lucide-bar-chart-2",
  },
];

const features = [
  {
    icon: "i-lucide-table-2",
    title: "Admin & data tables",
    desc: "One request shape drives filter bars, column sorting, search, pagination, and row selection. No bespoke API per table.",
    to: "/getting-started/introduction",
  },
  {
    icon: "i-lucide-filter",
    title: "Faceted explorer UIs",
    desc: "Facet requests travel in the same payload as the main query. No parallel API needed.",
    to: "/query-contract/facets",
  },
  {
    icon: "i-lucide-split",
    title: "Ids-first pipelines",
    desc: "Cache or delay row hydration by splitting into queryIds and queryRows. The contract stays identical.",
    to: "/resource-setup/strategies",
  },
  {
    icon: "i-lucide-shield-check",
    title: "Multi-tenant APIs",
    desc: "Scope filters merge before any client filter and cannot be bypassed. Tenancy is a structural guarantee.",
    to: "/resource-setup/scope",
  },
  {
    icon: "i-lucide-gauge",
    title: "Tunable performance",
    desc: "Start with automatic execution. Replace only the expensive stage when benchmarks show a bottleneck.",
    to: "/performance/overview",
  },
  {
    icon: "i-lucide-code-2",
    title: "Fully typed field paths",
    desc: "Field paths inferred from your schema and relations. Typos in sort keys or filter fields are compile-time errors.",
    to: "/reference/methods",
  },
];
</script>

<template>
  <div class="relative">
    <!-- ─── Page-level ambient glow (overflows freely) ────────── -->
    <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-visible">
      <div
        class="absolute left-1/2 top-0 h-[400px] w-[70vw] max-w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[100px] bg-amber-400/25 dark:bg-amber-500/18 sm:h-[500px] lg:h-[600px]"
      />
      <div class="dot-grid absolute inset-0 h-screen opacity-20" />
    </div>

    <div class="mx-auto max-w-[80rem] px-4 sm:px-6 lg:px-8">
      <!-- ─── Hero ──────────────────────────────────────────────── -->
      <section class="relative pb-12 pt-8">
        <div class="relative flex flex-col gap-8 py-10 lg:flex-row lg:items-center lg:gap-10">
          <!-- Left: headline + CTAs -->
          <div class="lg:w-1/2 lg:shrink-0">
            <UBadge color="primary" variant="subtle" icon="i-lucide-layers" class="mb-8">
              For Drizzle ORM
            </UBadge>

            <h1
              class="mb-6 text-5xl font-bold leading-[1.08] tracking-tight sm:text-6xl lg:text-[62px]"
            >
              One contract.
              <br />
              <span class="text-primary">Every table</span>
              <br />
              endpoint.
            </h1>

            <p class="mb-10 max-w-lg text-lg leading-relaxed text-stone-600 dark:text-stone-400">
              <code
                class="rounded px-1.5 py-0.5 font-mono text-base bg-stone-100 text-stone-700 dark:bg-white/8 dark:text-stone-200"
                >drizzle-resource</code
              >
              gives your server a typed query layer for filters, search, sorting, pagination, row
              hydration, and facets — all inferred from your Drizzle schema.
            </p>

            <div class="flex flex-wrap items-center gap-3">
              <UButton
                color="primary"
                size="xl"
                trailing-icon="i-lucide-arrow-right"
                to="/getting-started/quick-start"
              >
                Get started
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                size="xl"
                to="/getting-started/introduction"
              >
                Introduction
              </UButton>
            </div>
          </div>

          <!-- Right: Shiki-rendered code panel -->
          <div class="min-w-0 lg:flex-1">
            <ProsePre language="ts" filename="orders.ts" :code="rawHeroCode">
              <code class="landing-shiki" v-html="isDark ? heroHtmlDark : heroHtmlLight" />
            </ProsePre>
          </div>
        </div>
      </section>

      <!-- ─── Problem section ───────────────────────────────────── -->
      <section class="py-12">
        <div class="mb-10 max-w-2xl">
          <h2 class="mb-4 text-3xl font-bold sm:text-4xl">The problem it solves</h2>
          <p class="text-lg leading-relaxed text-stone-600 dark:text-stone-400">
            Every table API ends up with the same ad-hoc logic: parse sort params, build WHERE
            clauses, run a count, hydrate rows, maybe group buckets for a filter sidebar. You
            rewrite it slightly differently each time, and the client has to learn a different shape
            each time.
            <span class="text-stone-800 dark:text-stone-200"
              >drizzle-resource standardizes that entirely.</span
            >
          </p>
        </div>

        <div class="flex flex-col gap-6 lg:flex-row lg:items-stretch">
          <!-- Pipeline card -->
          <UPageCard class="shrink-0 lg:w-[38%]" spotlight>
            <template #header>
              <div>
                <p class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-primary">
                  Staged pipeline
                </p>
                <h3 class="text-lg font-semibold">Not a monolithic query</h3>
                <p class="mt-1 text-sm text-stone-500">
                  Each stage runs in order. Any stage can be replaced independently.
                </p>
              </div>
            </template>

            <div class="flex flex-col">
              <div v-for="(stage, i) in pipeline" :key="i" class="flex gap-3">
                <div class="flex flex-col items-center">
                  <div
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 dark:bg-primary/10"
                  >
                    <UIcon :name="stage.icon" class="h-4 w-4 text-primary" />
                  </div>
                  <div
                    v-if="i < pipeline.length - 1"
                    class="mt-1 w-px bg-stone-200 dark:bg-white/8"
                    style="min-height: 24px"
                  />
                </div>
                <div class="pb-4 pt-0.5 last:pb-0">
                  <div class="text-sm font-medium text-stone-800 dark:text-white">
                    {{ stage.label }}
                  </div>
                  <div class="mt-0.5 text-xs leading-relaxed text-stone-500">{{ stage.desc }}</div>
                </div>
              </div>
            </div>
          </UPageCard>

          <!-- Shiki code group -->
          <div class="min-w-0 flex-1">
            <ProseCodeGroup>
              <ProsePre language="ts" filename="orders.resource.ts" :code="rawResourceCode">
                <code
                  class="landing-shiki"
                  v-html="isDark ? resourceHtmlDark : resourceHtmlLight"
                />
              </ProsePre>
              <ProsePre language="ts" filename="request.ts" :code="rawRequestCode">
                <code class="landing-shiki" v-html="isDark ? requestHtmlDark : requestHtmlLight" />
              </ProsePre>
            </ProseCodeGroup>
          </div>
        </div>
      </section>

      <!-- ─── Features ─────────────────────────────────────────── -->
      <section class="py-12">
        <div class="mb-8">
          <p class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-primary">
            Use cases
          </p>
          <h2 class="text-3xl font-bold sm:text-4xl">Where it fits in your stack</h2>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <UPageCard
            v-for="feature in features"
            :key="feature.title"
            :title="feature.title"
            :description="feature.desc"
            :icon="feature.icon"
            :to="feature.to"
            spotlight
          />
        </div>
      </section>

      <!-- ─── CTA ──────────────────────────────────────────────── -->
      <section class="pb-28 pt-8">
        <div
          class="mx-auto max-w-2xl rounded-3xl border p-12 text-center border-amber-200 bg-amber-50 dark:border-primary/15 dark:bg-primary/5"
        >
          <h2 class="mb-3 text-3xl font-bold sm:text-4xl text-stone-900 dark:text-white">
            Ready to standardize<br />your table APIs?
          </h2>
          <p class="mb-8 text-base text-stone-600 dark:text-stone-400">
            Define your engine, add a resource, run your first query.
          </p>
          <UButton
            color="primary"
            size="xl"
            trailing-icon="i-lucide-arrow-right"
            to="/getting-started/quick-start"
          >
            Quick Start
          </UButton>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dot-grid {
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.06) 1px, transparent 1px);
  background-size: 32px 32px;
}

:global(.dark) .dot-grid {
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.07) 1px, transparent 1px);
}

:global(.landing-shiki) {
  display: block;
  font-size: 0.875rem;
  line-height: 1.7;
}
</style>
