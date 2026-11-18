<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";

/** One headline number with a line of context. */
defineProps<{ value: string }>();
</script>

<template>
  <div class="px-embed not-prose bst">
    <b class="px-pix">{{ value }}</b>
    <span><slot /></span>
  </div>
</template>

<style scoped>
.bst {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 16px 0 4px;
}
.bst b {
  font-size: 52px;
  line-height: 1;
  color: var(--hit-text);
}
.bst span {
  font-size: 15px;
  color: var(--ink2);
}
.bst :deep(code) {
  font-family: var(--font-mono);
  color: var(--ink);
}
</style>
