<script setup lang="ts">
import type { ContentNavigationItem, PageCollections } from "@nuxt/content";
import * as nuxtUiLocales from "@nuxt/ui/locale";
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/docs-theme.css";
import { useSubNavigation } from "../layer/app/composables/useSubNavigation";
import { transformNavigation } from "../layer/app/utils/navigation";

const appConfig = useAppConfig();
const { seo } = appConfig;
const site = useSiteConfig();
const { locale, locales, isEnabled, switchLocalePath } = useDocusI18n();

const localeByCode: Record<string, (typeof nuxtUiLocales)["en"]> = nuxtUiLocales;
const nuxtUiLocale = computed(() => localeByCode[locale.value] || localeByCode.en);
const lang = computed(() => nuxtUiLocale.value.code);
const dir = computed(() => nuxtUiLocale.value.dir);
const collectionName = computed(() => (isEnabled.value ? `docs_${locale.value}` : "docs"));
const faviconHref = computed(() => appConfig.header?.logo?.favicon || "/favicon.svg");

useHead({
  meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  link: [
    { rel: "icon", href: faviconHref },
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Doto:ROND,wght@0..100,300..900&family=Geist:wght@400..800&family=Geist+Mono:wght@400..600&display=swap",
    },
  ],
  htmlAttrs: {
    lang,
    dir,
  },
});

useSeoMeta({
  titleTemplate: seo.titleTemplate,
  title: seo.title,
  description: seo.description,
  ogSiteName: site.name,
  twitterCard: "summary_large_image",
});

if (isEnabled.value) {
  const route = useRoute();
  const defaultLocale = useRuntimeConfig().public.i18n.defaultLocale!;

  onMounted(() => {
    const currentLocale = route.path.split("/")[1];

    if (!locales.some((item) => item.code === currentLocale)) {
      return navigateTo(switchLocalePath(defaultLocale) as string);
    }
  });
}

const { data: navigation } = await useAsyncData(
  () => `navigation_${collectionName.value}`,
  () => queryCollectionNavigation(collectionName.value as keyof PageCollections),
  {
    transform: (data: ContentNavigationItem[]) =>
      transformNavigation(data, isEnabled.value, locale.value),
    watch: [locale],
  },
);

const { data: files } = useLazyAsyncData(
  `search_${collectionName.value}`,
  () => queryCollectionSearchSections(collectionName.value as keyof PageCollections),
  {
    server: false,
    watch: [locale],
  },
);

provide("navigation", navigation);

const { subNavigationMode } = useSubNavigation(navigation);
</script>

<template>
  <UApp :locale="nuxtUiLocale">
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <div
      :class="[
        'transition-[margin-right] duration-200 ease-linear will-change-[margin-right]',
        { 'docus-sub-header': subNavigationMode === 'header' },
      ]"
      :style="{ marginRight: '0' }"
    >
      <AppHeader v-if="$route.meta.header !== false" />
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
      <AppFooter v-if="$route.meta.footer !== false" />
    </div>

    <ClientOnly>
      <LazyUContentSearch :files="files" :navigation="navigation" />
    </ClientOnly>
  </UApp>
</template>

<style>
@media (min-width: 1024px) {
  .docus-sub-header {
    --ui-header-height: 112px;
  }
}

:root {
  --vp-c-bg: var(--ui-bg);
  --vp-c-text-1: var(--ui-text-highlighted);
  --vp-c-text-2: var(--ui-text-toned);
  --vp-c-text-3: color-mix(in oklab, var(--ui-text-toned) 76%, transparent);
  --vp-c-border: color-mix(in oklab, var(--ui-border) 72%, transparent);
  --vp-c-brand: var(--ui-primary);
  --vp-font-family-base: inherit;
  --vp-font-family-mono: var(--font-mono);
  --vp-code-font-size: 0.85rem;
  --vp-code-line-height: 1.6;
  --vp-code-block-bg: color-mix(in oklab, var(--ui-bg) 97%, white 3%);
  --vp-code-block-color: var(--ui-text-highlighted);
  --vp-code-tab-bg: var(--vp-code-block-bg);
  --vp-code-tab-text-color: var(--ui-text-toned);
  --vp-code-tab-active-text-color: var(--ui-text-highlighted);
  --vp-code-tab-hover-text-color: var(--ui-text-highlighted);
  --vp-code-copy-code-bg: var(--vp-code-block-bg);
  --vp-code-copy-code-hover-bg: var(--vp-code-block-bg);
  --twoslash-popup-bg: color-mix(in oklab, var(--ui-bg) 96%, white 4%);
  --twoslash-popup-color: var(--ui-text-highlighted);
  --twoslash-border-color: color-mix(in oklab, var(--ui-border) 72%, transparent);
  --twoslash-docs-color: var(--ui-text-toned);
  --twoslash-underline-color: color-mix(in oklab, var(--ui-primary) 55%, transparent);
  --twoslash-cursor-color: var(--ui-primary);
  --twoslash-matched-color: var(--ui-primary);
  --twoslash-unmatched-color: var(--ui-text-toned);
  --twoslash-popup-shadow: 0 18px 48px -24px rgb(0 0 0 / 0.3), 0 6px 18px -10px rgb(0 0 0 / 0.18);
}

.dark {
  --vp-code-block-bg: color-mix(in oklab, var(--ui-bg) 90%, white 10%);
  --twoslash-popup-bg: color-mix(in oklab, var(--ui-bg) 94%, white 6%);
  --twoslash-popup-shadow: 0 20px 56px -28px rgb(0 0 0 / 0.55), 0 8px 24px -12px rgb(0 0 0 / 0.3);
}

.v-popper--theme-twoslash .v-popper__inner {
  border: 1px solid color-mix(in oklab, var(--ui-border) 70%, transparent) !important;
  border-radius: 0.75rem !important;
  background: color-mix(in oklab, var(--ui-bg) 94%, black 6%) !important;
  box-shadow:
    0 20px 48px -26px rgb(0 0 0 / 0.42),
    0 6px 16px -10px rgb(0 0 0 / 0.24) !important;
  color: var(--ui-text-highlighted) !important;
  padding: 0.875rem !important;
  max-height: min(70vh, 34rem) !important;
  overflow: auto !important;
  overscroll-behavior: contain !important;
}

.v-popper--theme-twoslash .v-popper__wrapper,
.v-popper--theme-twoslash .v-popper__backdrop {
  background: transparent !important;
}

.v-popper--theme-twoslash .v-popper__wrapper {
  overflow: visible !important;
}

.v-popper--theme-twoslash .twoslash-popup-container {
  display: block !important;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  padding: 0 !important;
  line-height: normal !important;
  transform: none !important;
}

/* Strip Nuxt UI code chrome from the intermediate wrapper */
.v-popper--theme-twoslash .twoslash-popup-code {
  border: none !important;
  background: transparent !important;
  padding: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  display: block !important;
}

.v-popper--theme-twoslash .twoslash-popup-code > .relative,
.v-popper--theme-twoslash .twoslash-popup-code > .group,
.v-popper--theme-twoslash .twoslash-popup-code > .vp-code,
.v-popper--theme-twoslash .twoslash-popup-code > .vp-code-group {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.v-popper--theme-twoslash .twoslash-popup-code button {
  display: none !important;
}

.v-popper--theme-twoslash .twoslash-popup-code pre.shiki,
.v-popper--theme-twoslash .twoslash-popup-code pre[class*="shiki"] {
  margin: 0 !important;
  min-width: 0 !important;
  width: auto !important;
  max-width: min(40rem, calc(100vw - 5rem)) !important;
  overflow-x: auto !important;
  border: none !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.v-popper--theme-twoslash .twoslash-popup-code pre.shiki > code,
.v-popper--theme-twoslash .twoslash-popup-code pre[class*="shiki"] > code {
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  line-height: 1.65 !important;
  padding-bottom: 0.08rem !important;
}

.v-popper--theme-twoslash .twoslash-popup-code pre.shiki .line,
.v-popper--theme-twoslash .twoslash-popup-code pre[class*="shiki"] .line,
.v-popper--theme-twoslash .twoslash-popup-code pre.shiki span,
.v-popper--theme-twoslash .twoslash-popup-code pre[class*="shiki"] span {
  background: transparent !important;
}

.v-popper--theme-twoslash .twoslash-popup-code code:not(pre code) {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

/* Fix arrow colors to match popup in both light/dark */
.v-popper--theme-twoslash .v-popper__arrow-outer {
  border-top-color: color-mix(in oklab, var(--ui-border) 70%, transparent) !important;
}

.v-popper--theme-twoslash .v-popper__arrow-inner {
  border-top-color: var(--ui-bg) !important;
}

/* Hide the redundant custom arrow inside the popup container */
.twoslash-popup-arrow {
  display: none !important;
}

.twoslash-floating {
  max-width: 36rem !important;
}

.twoslash-floating .twoslash-popup-docs,
.twoslash-floating .twoslash-popup-error,
.twoslash-floating .twoslash-popup-code {
  font-size: 0.82rem !important;
  line-height: 1.55 !important;
}

.twoslash-floating .twoslash-popup-docs {
  color: var(--ui-text-toned) !important;
  margin-top: 0.75rem !important;
  padding: 0.75rem 0 0.3rem !important;
  border-top: 1px solid color-mix(in oklab, var(--ui-border) 50%, transparent) !important;
}

.twoslash-floating .twoslash-popup-docs-tags {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 0.5rem !important;
  padding: 0.85rem 0 0.15rem !important;
}

.twoslash-floating .twoslash-popup-docs-tag-name {
  display: inline-flex !important;
  align-items: center !important;
  border-radius: 999px !important;
  border: 1px solid color-mix(in oklab, var(--ui-primary) 18%, var(--ui-border) 82%) !important;
  background: color-mix(in oklab, var(--ui-primary) 7%, var(--ui-bg) 93%) !important;
  padding: 0.18rem 0.55rem !important;
  color: color-mix(in oklab, var(--ui-primary) 72%, var(--ui-text) 28%) !important;
  font-size: 0.72rem !important;
  font-weight: 600 !important;
  line-height: 1.1 !important;
  margin: 0 !important;
  vertical-align: middle !important;
}

.twoslash .twoslash-hover {
  border-bottom-color: color-mix(in oklab, var(--ui-primary) 55%, transparent) !important;
}
</style>
