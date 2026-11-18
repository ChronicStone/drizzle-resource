<script setup lang="ts">
// eslint-disable-next-line import/no-unassigned-import
import "~/assets/css/pixel.css";
import PxSky from "../landing/PxSky.vue";
import PxHero from "../landing/PxHero.vue";
import PxDemo from "../landing/PxDemo.vue";
import PxFeatures from "../landing/PxFeatures.vue";
import PxPipeline from "../landing/PxPipeline.vue";
import PxBench from "../landing/PxBench.vue";
import PxStart from "../landing/PxStart.vue";

useHead({
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: "drizzle-resource",
        description:
          "Typed list endpoints for Drizzle ORM: filters, search, sorting, pagination, facets and totals from one resource definition, scoped on the server.",
        url: "https://drizzle-resource.vercel.app",
        codeRepository: "https://github.com/ChronicStone/drizzle-resource",
        programmingLanguage: "TypeScript",
        license: "https://opensource.org/licenses/MIT",
        keywords: "drizzle, drizzle orm, typescript, filtering, pagination, facets, search, api",
      }),
    },
  ],
});
</script>

<template>
  <div class="px-land">
    <PxSky />
    <div class="px-wrap">
      <PxHero />
      <PxFeatures />
      <PxPipeline />
      <PxDemo />
      <PxBench />
      <PxStart />
    </div>
  </div>
</template>
