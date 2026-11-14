<template>
  <details class="inline-trace" :class="{ live }" :open="expanded" @toggle="onToggle">
    <summary>
      <TerminalOutline aria-hidden="true" />
      <span class="inline-trace-title">{{ t('trace.inline.title') }}</span>
      <small v-if="activitySummary" class="inline-trace-summary">{{ activitySummary }}</small>
      <small v-else-if="live" class="inline-trace-loading">{{ t('trace.inline.live') }}</small>
      <small v-else-if="loading" class="inline-trace-loading">{{ t('trace.steps.loading') }}</small>
      <span v-if="live" class="inline-trace-live" aria-label="live" />
      <span class="inline-trace-spacer" />
      <ChevronDownOutline class="inline-trace-chevron" aria-hidden="true" />
    </summary>
    <TraceStepList v-if="expanded && hasFullTrace" :controller="controller" :live="live" />
    <p v-else-if="expanded && !loading" class="inline-trace-empty">
      {{ live ? t('trace.inline.waiting') : t('trace.steps.noFullTrace') }}
    </p>
  </details>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDownOutline, TerminalOutline } from '@vicons/ionicons5'
import { useTraceStream } from '../../composables/useTraceStream.js'
import TraceStepList from './TraceStepList.vue'

const props = defineProps({
  agentRunId: { type: String, required: true },
  defaultOpen: { type: Boolean, default: false },
  live: { type: Boolean, default: false },
  runId: { type: String, required: true },
  t: { type: Function, required: true },
})

const expanded = ref(props.defaultOpen)
const stream = useTraceStream({
  runId: computed(() => props.runId),
  agentRunId: computed(() => props.agentRunId),
})
const steps = stream.steps
const loading = stream.loading
const hasFullTrace = stream.hasFullTrace
const controller = {
  complete: stream.complete,
  hasMore: stream.hasMore,
  incomplete: stream.incomplete,
  loadBlob: stream.loadBlob,
  loadOlder: stream.loadOlder,
  loading: stream.loading,
  steps,
  t: props.t,
}

const activitySummary = computed(() => {
  const values = steps.value || []
  if (!hasFullTrace.value || !values.length) return ''
  let thinking = 0
  const tools = new Set()
  for (const step of values) {
    if (step.kind === 'thinking') thinking += 1
    else if (step.kind === 'tool') tools.add(step.toolCallId || step.seq)
  }
  const parts = []
  if (thinking) parts.push(props.t('trace.inline.thinking', { count: thinking }))
  if (tools.size) parts.push(props.t('trace.inline.tools', { count: tools.size }))
  return parts.join(' · ')
})

watch(() => props.defaultOpen, (value) => {
  if (value) expanded.value = true
})

watch(expanded, (value) => {
  stream.setViewing(value || props.live)
  if (value || props.live) void stream.open()
})

onMounted(() => {
  stream.setViewing(props.live)
  void stream.open()
})

function onToggle(event) {
  const open = event.target?.open === true
  if (open !== expanded.value) expanded.value = open
}
</script>
