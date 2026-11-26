<script setup lang="ts">
import examples from "~/data/scale-examples.json";

/** Console output captured by tools/scale-examples.ts: `::tool-output{name="explainList"}`. */
const props = defineProps<{
  name: string;
  label?: string;
  /** output that reads only the schema (checkIndexes without live): no database, no timings */
  static?: boolean;
}>();
const data = examples as {
  generatedAt: string;
  engine: string;
  postgres: string;
  rows: number;
  outputs: Record<string, string>;
};
const text = computed(() => {
  const value = data.outputs[props.name];
  if (value === undefined) throw new Error(`scale-examples.json has no output "${props.name}"`);
  return value;
});
/* Wrap long lines under their own text column, so a wrapped message stays readable and the
   columns before it (stage, time, level, resource) stay aligned: the hanging indent is the last
   place, within the first 28 characters, where text starts after two spaces. */
const lines = computed(() =>
  text.value.split("\n").map((line) => {
    let indent = 0;
    for (let i = 2; i < Math.min(line.length, 28); i++) {
      if (line[i - 1] === " " && line[i - 2] === " " && line[i] !== " ") indent = i;
    }
    if (indent === 0) indent = line.length - line.trimStart().length;
    return { line: line || " ", indent };
  }),
);
const source = computed(() =>
  props.static
    ? `From the Drizzle schema, no database. Captured ${data.generatedAt} by tools/scale-examples.ts.`
    : `${data.rows.toLocaleString("en-US")} orders, PostgreSQL ${data.postgres.split(" ")[0]}, captured ${data.generatedAt} by tools/scale-examples.ts. One run, not a benchmark.`,
);
</script>

<template>
  <figure class="tool-out not-prose">
    <figcaption>
      <span class="tool-out-label">{{ label ?? "Output" }}</span>
      <span class="tool-out-src">{{ source }}</span>
    </figcaption>
    <pre><code><span
      v-for="(l, i) in lines"
      :key="i"
      class="ln"
      :style="{ paddingLeft: `${l.indent}ch`, textIndent: `-${l.indent}ch` }"
    >{{ l.line }}</span></code></pre>
  </figure>
</template>

<style scoped>
.tool-out {
  margin: 16px 0 20px;
  border: 1px solid var(--ui-border-muted);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg-muted);
  overflow: hidden;
}
figcaption {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 2px 12px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--ui-border-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tool-out-label {
  font-weight: 600;
  color: var(--ui-text-toned);
}
pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ui-text-highlighted);
}
.ln {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  pre {
    padding: 10px 12px;
    font-size: 11.5px;
  }
}
</style>
