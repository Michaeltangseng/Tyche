<template>
  <details class="inline-trace" :open="expanded" @toggle="onToggle">
    <summary>
      <TerminalOutline aria-hidden="true" />
      <span class="inline-trace-title">{{ t('trace.inline.title') }}</span>
      <small v-if="steps.length">{{ t('trace.inline.steps', { count: steps.length }) }}</small>
      <small v-if="loading" class="inline-trace-loading">{{ t('trace.steps.loading') }}</small>
      <span class="inline-trace-spacer" />
      <ChevronDownOutline class="inline-trace-chevron" aria-hidden="true" />
    </summary>
    <TraceStepList v-if="hasFullTrace" :controller="controller" />
    <p v-else-if="!loading" class="inline-trace-empty">{{ t('trace.steps.noFullTrace') }}</p>
  </details>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ChevronDownOutline, TerminalOutline } from '@vicons/ionicons5'
import { useTraceStream } from '../../composables/useTraceStream.js'
import TraceStepList from './TraceStepList.vue'

const props = defineProps({
  agentRunId: { type: String, required: true },
  defaultOpen: { type: Boolean, default: false },
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

watch(() => props.defaultOpen, (value) => {
  if (value) expanded.value = true
})

watch(expanded, (value) => {
  stream.setViewing(value)
  if (value) void stream.open()
}, { immediate: true })

function onToggle(event) {
  const open = event.target?.open === true
  if (open !== expanded.value) expanded.value = open
}
</script>
