<script setup lang="ts">
const route = useRoute();

const isPlaygroundPage = computed(() => route.path === "/playground");
</script>

<template>
  <UButton
    to="/playground"
    icon="i-lucide-square-terminal"
    color="neutral"
    :variant="isPlaygroundPage ? 'soft' : 'ghost'"
    size="sm"
    class="hidden md:inline-flex"
  >
    Playground
  </UButton>
</template>
