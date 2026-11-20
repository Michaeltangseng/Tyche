<template>
  <span class="trace-status-icon" :data-status="tone" role="img" :aria-label="label">
    <CheckmarkCircleOutline v-if="tone === 'completed'" aria-hidden="true" />
    <CloseCircleOutline v-else-if="tone === 'failed'" aria-hidden="true" />
    <WarningOutline v-else-if="tone === 'partial'" aria-hidden="true" />
    <span v-else class="trace-status-spinner" aria-hidden="true" />
  </span>
</template>

<script setup>
import { computed } from 'vue'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { runStatusTone } from '../../conversationTimelineModel.js'

const props = defineProps({
  status: { type: String, default: '' },
  t: { type: Function, required: true },
})

const normalized = computed(() => (
  String(props.status || '').toLowerCase() === 'in_progress' ? 'running' : String(props.status || '')
))
const tone = computed(() => runStatusTone(normalized.value) || 'running')
const label = computed(() => {
  const key = `trace.steps.status.${normalized.value || 'running'}`
  const value = props.t(key)
  return value === key ? (props.status || '') : value
})
</script>
