<template>
  <div class="trace-raw-view">
    <pre v-for="step in stepsWithRaw" :key="step.seq">{{ rawText(step) }}</pre>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  steps: { type: Array, required: true },
})

const stepsWithRaw = computed(() => props.steps.filter(step => step.raw !== undefined))

function rawText(step) {
  const raw = step.raw
  if (raw?.coalesced === true) return String(step.output || '')
  if (typeof raw === 'string') return raw
  try { return JSON.stringify(raw, null, 2) } catch { return String(raw || '') }
}
</script>
