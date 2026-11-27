<script setup lang="ts">
const { sidebarNavigation } = useSubNavigation();
</script>

<template>
  <UContentNavigation
    highlight
    type="multiple"
    :collapsible="false"
    :navigation="sidebarNavigation"
  />
</template>
