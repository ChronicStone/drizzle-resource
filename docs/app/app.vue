<script setup lang="ts">
import type { ContentNavigationItem, PageCollections } from "@nuxt/content";
import * as nuxtUiLocales from "@nuxt/ui/locale";
import { useSubNavigation } from "../layer/app/composables/useSubNavigation";
import { transformNavigation } from "../layer/app/utils/navigation";

const appConfig = useAppConfig();
const { seo } = appConfig;
const site = useSiteConfig();
const { locale, locales, isEnabled, switchLocalePath } = useDocusI18n();

const nuxtUiLocale = computed(
  () => nuxtUiLocales[locale.value as keyof typeof nuxtUiLocales] || nuxtUiLocales.en,
);
const lang = computed(() => nuxtUiLocale.value.code);
const dir = computed(() => nuxtUiLocale.value.dir);
const collectionName = computed(() => (isEnabled.value ? `docs_${locale.value}` : "docs"));
const faviconHref = computed(() => appConfig.header?.logo?.favicon || "/favicon.svg");

useHead({
  meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  link: [{ rel: "icon", href: faviconHref }],
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

.dot-grid {
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.06) 1px, transparent 1px);
  background-size: 32px 32px;
}

.dark .dot-grid {
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.07) 1px, transparent 1px);
}

.landing-card {
  display: block;
  border-radius: 1.5rem;
  border: 1px solid color-mix(in oklab, var(--ui-border) 92%, transparent);
  background: color-mix(in oklab, var(--ui-bg) 92%, white 8%);
  padding: 1.25rem;
  transition:
    transform 160ms ease,
    border-color 160ms ease,
    background 160ms ease;
}

.landing-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in oklab, var(--ui-primary) 40%, var(--ui-border) 60%);
  background: color-mix(in oklab, var(--ui-bg) 88%, white 12%);
}

.landing-card h3 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

.landing-card p {
  margin: 0.65rem 0 0;
  line-height: 1.6;
  color: var(--ui-text-toned);
}
</style>
