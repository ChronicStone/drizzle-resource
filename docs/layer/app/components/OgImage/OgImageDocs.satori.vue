<script lang="ts" setup>
const props = withDefaults(
  defineProps<{ pageTitle?: string; pageDescription?: string; headline?: string }>(),
  {
    pageTitle: "title",
    pageDescription: "description",
  },
);

const title = (props.pageTitle || "").slice(0, 60);
const description = (props.pageDescription || "").slice(0, 180);
</script>

<template>
  <div class="w-full h-full flex" style="background-color: #0a0b0c; padding: 72px 80px">
    <div class="flex flex-col justify-between" style="width: 760px">
      <div class="flex items-center" style="gap: 16px">
        <svg
          width="44"
          height="44"
          viewBox="0 0 32 32"
          xmlns="http://www.w3.org/2000/svg"
          style="opacity: 1"
        >
          <path d="M16 2.5 L28.5 9.2 L16 15.9 L3.5 9.2 Z" fill="#FFD23F" />
          <path d="M3.5 11.3 L14.9 17.4 L14.9 20.5 L3.5 14.4 Z" fill="#EDEFEF" />
          <path d="M3.5 15.8 L14.9 21.9 L14.9 25 L3.5 18.9 Z" fill="#EDEFEF" />
          <path d="M3.5 20.3 L14.9 26.4 L14.9 29.5 L3.5 23.4 Z" fill="#EDEFEF" />
          <path d="M17.1 17.4 L28.5 11.3 L28.5 23.4 L17.1 29.5 Z" fill="#6B6F72" />
        </svg>
        <span
          style="
            font-size: 30px;
            font-weight: 600;
            color: #edefef;
            font-family: monospace;
            white-space: nowrap;
          "
          >drizzle<span style="color: #5b6266">/</span>resource</span
        >
      </div>
      <div class="flex flex-col">
        <p
          v-if="headline"
          style="
            margin: 0 0 16px;
            font-size: 24px;
            color: #ffd23f;
            text-transform: uppercase;
            letter-spacing: 3px;
            font-family: monospace;
          "
        >
          {{ headline }}
        </p>
        <h1
          style="
            margin: 0;
            font-size: 72px;
            line-height: 1.05;
            font-weight: 700;
            color: #f2f4f4;
            letter-spacing: -2px;
          "
        >
          {{ title }}
        </h1>
        <p
          v-if="description"
          style="margin: 24px 0 0; font-size: 28px; line-height: 1.35; color: #a3a9ac"
        >
          {{ description }}
        </p>
      </div>
      <div class="flex" style="font-size: 22px; color: #697075; font-family: monospace">
        drizzle-resource.vercel.app
      </div>
    </div>
    <div class="flex items-end justify-end" style="flex: 1">
      <svg
        width="300"
        height="300"
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        style="opacity: 1"
      >
        <path d="M16 2.5 L28.5 9.2 L16 15.9 L3.5 9.2 Z" fill="#FFD23F" />
        <path d="M3.5 11.3 L14.9 17.4 L14.9 20.5 L3.5 14.4 Z" fill="#EDEFEF" />
        <path d="M3.5 15.8 L14.9 21.9 L14.9 25 L3.5 18.9 Z" fill="#EDEFEF" />
        <path d="M3.5 20.3 L14.9 26.4 L14.9 29.5 L3.5 23.4 Z" fill="#EDEFEF" />
        <path d="M17.1 17.4 L28.5 11.3 L28.5 23.4 L17.1 29.5 Z" fill="#6B6F72" />
      </svg>
    </div>
  </div>
</template>
