<script setup lang="ts">
import { benchScale } from "~/utils/bench-scale";

/* Shown while data/bench-scale.json says the numbers are provisional; gone once the
   benchmark's results file sets "provisional": false. */
</script>

<template>
  <div v-if="benchScale.provisional" class="bench-note not-prose" role="note">
    <b>Provisional numbers.</b>
    These were measured on {{ benchScale.measuredOn }} while the machine was busy with other work,
    so some medians are higher than a quiet run would give. A quiet run will replace them.
    <NuxtLink to="/scale/benchmarks#how-it-was-measured">How they were measured</NuxtLink>
  </div>
</template>

<style scoped>
.bench-note {
  margin: 16px 0 20px;
  padding: 10px 14px;
  border: 1px dashed color-mix(in oklab, var(--ui-warning) 55%, transparent);
  border-radius: 10px;
  background: color-mix(in oklab, var(--ui-warning) 7%, transparent);
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ui-text-toned);
}
.bench-note b {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.bench-note a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
