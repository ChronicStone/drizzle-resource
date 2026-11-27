<script setup lang="ts">
import { benchScale } from "~/utils/bench-scale";

/**
 * How the numbers were measured, as paragraphs the data script writes from what the results file
 * says about itself (data/bench-scale.json: setup.method), so the page is true for whichever
 * harness made the file. `code` between backticks is shown as code.
 */
const paragraphs = benchScale.setup.method.map((text) =>
  text.split("`").map((part, i) => ({ part, code: i % 2 === 1 })),
);
</script>

<template>
  <div class="bench-method">
    <p v-for="(segments, i) in paragraphs" :key="i">
      <template v-for="(s, j) in segments" :key="j">
        <code v-if="s.code">{{ s.part }}</code><template v-else>{{ s.part }}</template>
      </template>
    </p>
  </div>
</template>
