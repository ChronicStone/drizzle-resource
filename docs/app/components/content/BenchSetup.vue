<script setup lang="ts">
import { benchScale, formatCount, verdictText } from "~/utils/bench-scale";

/** How the numbers of the Scale pages were measured, read from data/bench-scale.json. */
const d = benchScale;
const settings = Object.entries(d.setup.postgresSettings)
  .map(([key, value]) => (key === "other" ? `${value} otherwise` : `${key} ${value}`))
  .join(", ");
const sizeName = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`);
/** A request measured against itself should read "no change"; its ratios show the noise of the run. */
const nullText = (d.setup.nullPairs ?? [])
  .map(
    (p) =>
      `${sizeName(p.rows)}: ${verdictText(p.verdict)}, ratios ${p.ratioMin.toFixed(2)} to ${p.ratioMax.toFixed(2)}`,
  )
  .join("; ");
const rows = [
  ["Measured on", `${d.measuredOn}, engine commit ${d.engine}`],
  ["Status", d.provisional ? "provisional: taken while the machine ran other work" : "final"],
  ["Database", d.setup.database],
  ["Settings", settings],
  ["Data", d.setup.dataset],
  ["Sizes", d.sizes.map((n) => `${formatCount(n)} orders`).join(", ")],
  ["Client", d.setup.client],
  ...Object.entries(d.setup.profiles ?? {}).map(([name, text]) => [`Profile "${name}"`, text]),
  ...(nullText ? [["Same request against itself", nullText]] : []),
  ["Engine", d.setup.engineNote],
  ["Results", d.source],
];
</script>

<template>
  <dl class="bench-setup not-prose">
    <template v-for="[term, text] in rows" :key="term">
      <dt>{{ term }}</dt>
      <dd>{{ text }}</dd>
    </template>
  </dl>
</template>

<style scoped>
.bench-setup {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 18px;
  margin: 16px 0 20px;
  font-size: 13.5px;
  line-height: 1.5;
}
dt {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
dd {
  margin: 0;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
@media (max-width: 560px) {
  .bench-setup {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  dd {
    margin-bottom: 8px;
  }
}
</style>
