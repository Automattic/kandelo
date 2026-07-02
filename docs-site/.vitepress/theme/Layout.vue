<script setup lang="ts">
import DefaultTheme from "vitepress/theme";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #layout-top>
      <div class="docs-review-notice">
        <strong>Draft docs:</strong>
        These docs are unreviewed. They are an attempt at accuracy based on the
        current Kandelo source tree, but they are also a placeholder and may be
        incomplete, stale, or wrong.
      </div>
    </template>
  </Layout>
</template>
