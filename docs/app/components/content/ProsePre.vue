<script setup lang="ts">
/**
 * Renders ```mermaid fenced blocks as themed SVG diagrams and delegates every
 * other language to Nuxt UI's own ProsePre (keeping Shiki, Twoslash, filename
 * headers and the copy button untouched).
 *
 * beautiful-mermaid renders synchronously with zero DOM dependencies, so the
 * SVG is produced during SSR/prerender and hydrates byte-identically. Colors
 * are emitted as CSS custom properties (`var(--ui-*)`), which means a single
 * render serves both light and dark themes and reacts to the theme toggle
 * through the cascade — no re-render, no client-only fallback.
 */
import { renderMermaidSVG } from "beautiful-mermaid";
import UProsePre from "@nuxt/ui/runtime/components/prose/Pre.vue";

const props = defineProps<{
  code?: string;
  language?: string;
  filename?: string;
  meta?: string;
  highlights?: number[];
  hideHeader?: boolean;
  icon?: string;
  copy?: boolean | Record<string, unknown>;
  class?: unknown;
  ui?: Record<string, unknown>;
}>();

const isMermaid = computed(() => props.language === "mermaid");

/**
 * Only forward keys that were actually provided. Spreading `props` wholesale
 * would pass `copy: undefined`, which suppresses Nuxt UI's copy button.
 */
const passthrough = computed(() =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
);

/** `title="..."` in the fence meta becomes the figure caption. */
const caption = computed(() => {
  const match = props.meta?.match(/title="([^"]+)"|title='([^']+)'/u);
  return match?.[1] ?? match?.[2] ?? props.filename;
});

const diagram = computed(() => {
  if (!isMermaid.value || !props.code) return { svg: null, error: null };
  try {
    return {
      svg: renderMermaidSVG(props.code.trim(), {
        bg: "var(--ui-bg)",
        fg: "var(--ui-text-highlighted)",
        accent: "var(--ui-primary)",
        line: "var(--ui-border-accented)",
        muted: "var(--ui-text-muted)",
        surface: "var(--ui-bg-elevated)",
        border: "var(--ui-border-accented)",
        transparent: true,
      }),
      error: null,
    };
  } catch (error) {
    return { svg: null, error: error instanceof Error ? error.message : String(error) };
  }
});
</script>

<template>
  <figure v-if="isMermaid && diagram.svg" class="mermaid-figure">
    <!-- eslint-disable-next-line vue/no-v-html -- SVG string produced locally by beautiful-mermaid -->
    <div class="mermaid-canvas" v-html="diagram.svg" />
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>

  <UProsePre v-else v-bind="passthrough">
    <slot />
  </UProsePre>
</template>

<style scoped>
.mermaid-figure {
  margin: 1.75rem 0;
  border-radius: 0.875rem;
  border: 1px solid color-mix(in oklab, var(--ui-border) 90%, transparent);
  background: color-mix(in oklab, var(--ui-bg) 97%, var(--ui-text) 3%);
  padding: 1.25rem 1rem 0.85rem;
}

.mermaid-canvas {
  overflow-x: auto;
  display: flex;
  justify-content: center;
}

.mermaid-canvas :deep(svg) {
  max-width: 100%;
  height: auto;
}

.mermaid-figure figcaption {
  margin-top: 0.75rem;
  text-align: center;
  font-size: 0.78rem;
  color: var(--ui-text-muted);
}
</style>
