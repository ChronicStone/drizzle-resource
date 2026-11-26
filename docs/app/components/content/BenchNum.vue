<script setup lang="ts">
import { benchValue, formatCount, formatMs, sizeIndex } from "~/utils/bench-scale";

/** One number from data/bench-scale.json, inline in prose: `:bench-num{path="requests.count.outOfTheBox.ms" n="10M"}`. */
const props = defineProps<{
  path: string;
  /** table size, for a value per size: 200k, 1M or 10M (default 10M) */
  n?: string;
  format?: "ms" | "count" | "ratio" | "text";
}>();
const text = computed(() => {
  let value = benchValue(props.path);
  if (Array.isArray(value)) value = value[sizeIndex(props.n)];
  if (props.format === "text") return String(value);
  if (typeof value !== "number") throw new Error(`bench-num: "${props.path}" is not a number`);
  if (props.format === "count") return formatCount(value);
  if (props.format === "ratio") return `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`;
  return formatMs(value);
});
</script>

<template>
  <span class="bench-num">{{ text }}</span>
</template>

<style scoped>
.bench-num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
