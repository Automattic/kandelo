<script setup lang="ts">
import { CREDITS, CREDITS_DEVELOPER } from "../../web-libs/kandelo-session/src/credits";
</script>

# Credits

<p>Kandelo is developed by <a :href="CREDITS_DEVELOPER.url">{{ CREDITS_DEVELOPER.name }}</a>, with help from many open source projects. These have been the most helpful, and we are grateful to them.</p>

<template v-for="section in CREDITS" :key="section.title">
  <h2>{{ section.title }}</h2>
  <p v-if="section.intro">{{ section.intro }}</p>
  <dl class="credits-list">
    <template v-for="entry in section.entries" :key="entry.name">
      <dt><a :href="entry.url">{{ entry.name }}</a><span v-if="entry.by" class="credits-by"> · {{ entry.by }}</span></dt>
      <dd>{{ entry.use }}</dd>
    </template>
  </dl>
</template>
