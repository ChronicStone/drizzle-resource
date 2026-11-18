<script setup lang="ts">
/*
 * The header brand: the resource block mark and the name in Geist Mono, drawn inline so the
 * web font applies (an <img> of the wordmark can't load it). Right click still offers the
 * logo downloads.
 */
const { contextMenuItems } = useLogoAssets();
</script>

<template>
  <UContextMenu :items="contextMenuItems">
    <span class="dr-brand" aria-label="drizzle-resource">
      <svg class="dr-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 2.5 L28.5 9.2 L16 15.9 L3.5 9.2 Z" fill="#FFD23F" />
        <path d="M3.5 11.3 L14.9 17.4 L14.9 20.5 L3.5 14.4 Z" />
        <path d="M3.5 15.8 L14.9 21.9 L14.9 25 L3.5 18.9 Z" />
        <path d="M3.5 20.3 L14.9 26.4 L14.9 29.5 L3.5 23.4 Z" />
        <path d="M17.1 17.4 L28.5 11.3 L28.5 23.4 L17.1 29.5 Z" fill-opacity=".42" />
      </svg>
      <span class="dr-name">drizzle<span>/</span>resource</span>
    </span>
  </UContextMenu>
</template>

<style scoped>
.dr-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ui-text-highlighted);
}
.dr-mark {
  width: 26px;
  height: 26px;
  flex: none;
  fill: currentColor;
}
.dr-name {
  font-family: var(--font-mono);
  font-size: 16.5px;
  font-weight: 600;
  letter-spacing: -0.02em;
  white-space: nowrap;
}
.dr-name span {
  color: var(--ui-text-dimmed);
  margin: 0 1px;
}
@media (max-width: 400px) {
  .dr-name {
    font-size: 15px;
  }
}
</style>
