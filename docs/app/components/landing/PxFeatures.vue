<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import PxFeatureArt from "./PxFeatureArt.vue";

/*
 * Everything a resource gives you, one tile each, with an illustration that only animates
 * while the grid is on screen.
 */
const TILES = [
  {
    id: "filters",
    title: "Filters",
    text: "Nested AND / OR groups, with the operators that fit each field's type.",
    to: "/query/filters",
  },
  {
    id: "search",
    title: "Search",
    text: "One search box across the fields and relations you allow.",
    to: "/query/search",
  },
  {
    id: "sort",
    title: "Sorting",
    text: "Several sort keys at once. Turn sorting off for any field.",
    to: "/query/sorting",
  },
  {
    id: "pages",
    title: "Pagination",
    text: "Offset or cursor pages, with an exact count or none.",
    to: "/query/pagination",
  },
  {
    id: "facets",
    title: "Facets",
    text: "Counts per value for filter sidebars, each ignoring its own filter.",
    to: "/query/facets",
  },
  {
    id: "summary",
    title: "Totals",
    text: "Your own aggregates over every matching row, typed from the expression.",
    to: "/query/summaries",
  },
  {
    id: "scan",
    title: "Bulk scans",
    text: "Read every matching row in batches for exports and jobs, from one cursor.",
    to: "/query/bulk-scans",
  },
  {
    id: "scope",
    title: "Tenant scope",
    text: "A condition from the server context on every statement. Clients can't lift it.",
    to: "/resource/scope",
  },
  {
    id: "policy",
    title: "Field policy",
    text: "Hide a field, or stop it from being filtered, searched or sorted.",
    to: "/resource/field-policy",
  },
  {
    id: "views",
    title: "Views",
    text: "Several response shapes from one resource: a list, an export, a client view.",
    to: "/resource/views",
  },
  {
    id: "virtual",
    title: "Virtual fields",
    text: "A SQL expression or a correlated subquery, filtered and sorted like a column.",
    to: "/resource/models",
  },
  {
    id: "relations",
    title: "Relations",
    text: "Filter, sort and search through relations with a dotted path.",
    to: "/resource/relations",
  },
  {
    id: "types",
    title: "Typed paths",
    text: "Field paths, operators and rows are typed from your Drizzle schema.",
    to: "/validation/typed-clients",
  },
  {
    id: "validation",
    title: "Validation",
    text: "Request schemas for Zod, Valibot and Vine, generated from the resource.",
    to: "/validation/schemas",
  },
] as const;

const root = ref<HTMLElement | null>(null);
const playing = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  observer = new IntersectionObserver(([e]) => (playing.value = !!e?.isIntersecting), {
    threshold: 0.1,
  });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="px-blk">
    <div class="px-head">
      <h2>One resource, <span class="px-acc">every list feature</span></h2>
      <p class="px-lede">
        Define a resource once on a Drizzle table. Each of these works on the server from that
        definition, with no endpoint code of your own.
      </p>
    </div>

    <div ref="root" class="pf">
      <NuxtLink v-for="t in TILES" :key="t.id" :to="t.to" class="pf-t">
        <div class="pf-v">
          <PxFeatureArt :id="t.id" :playing="playing" />
        </div>
        <h3>{{ t.title }}</h3>
        <p>{{ t.text }}</p>
      </NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.pf {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.pf-t {
  display: flex;
  flex-direction: column;
  padding: 10px 10px 14px;
  border: 1px solid var(--line2);
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.2s,
    transform 0.2s var(--ease);
}
.pf-t:hover {
  border-color: color-mix(in srgb, var(--hit) 55%, transparent);
  transform: translateY(-2px);
}
.pf-t h3 {
  margin-top: 9px;
  padding: 0 6px;
  font-size: 15px;
}
.pf-t p {
  margin-top: 2px;
  padding: 0 6px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--ink2);
}
.pf-v {
  aspect-ratio: 280 / 112;
  padding: 0;
  border-radius: 9px;
  border: 1px solid var(--line);
  background:
    radial-gradient(var(--px-dot) 1px, transparent 1.3px) 0 0 / 10px 10px,
    var(--bg);
  overflow: hidden;
}

@media (max-width: 1100px) {
  .pf {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 820px) {
  .pf {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
/* phones: a swipeable row, each tile wide enough for its illustration to read */
@media (max-width: 640px) {
  .pf {
    grid-template-columns: none;
    grid-auto-flow: column;
    grid-auto-columns: 82%;
    gap: 10px;
    margin: 0 -20px;
    padding: 0 20px 6px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-padding: 0 20px;
    scrollbar-width: none;
  }
  .pf::-webkit-scrollbar {
    display: none;
  }
  .pf-t {
    scroll-snap-align: start;
  }
  .pf-t:hover {
    transform: none;
  }
}
</style>
