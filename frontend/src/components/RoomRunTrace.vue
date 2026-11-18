<template>
  <details class="room-run-trace" @toggle="onToggle">
    <summary>
      <span>{{ t('room.trace') }}</span>
      <span v-if="toolCount" class="room-run-trace-count">{{ toolCount }}</span>
      <span v-if="usageLabel" class="room-run-trace-count">{{ t('room.usageContext') }} {{ usageLabel }}</span>
    </summary>
    <p v-if="loading" class="room-muted">{{ t('room.loadingTrace') }}</p>
    <p v-else-if="loadError" class="room-error" role="alert">
      {{ t('room.traceError') }}
      <button class="secondary-button" type="button" @click="load">{{ t('room.refresh') }}</button>
    </p>
    <p v-else-if="!tools.length && !usage" class="room-muted">{{ t('room.traceEmpty') }}</p>
    <p v-if="usage" class="room-usage-row">
      <span v-if="usage.inputTokens != null">{{ t('room.usageInput') }} {{ usage.inputTokens }}</span>
      <span v-if="usage.outputTokens != null">{{ t('room.usageOutput') }} {{ usage.outputTokens }}</span>
      <span v-if="usage.totalTokens != null">{{ t('room.usageTotal') }} {{ usage.totalTokens }}</span>
      <span v-if="usage.context?.percent != null">{{ t('room.usageContext') }} {{ Math.round(usage.context.percent) }}%</span>
      <span v-else-if="usage.context?.tokens != null">{{ t('room.usageContext') }} {{ usage.context.tokens }}</span>
    </p>
    <article v-for="tool in tools" :key="tool.callId" class="room-tool-card" :data-status="tool.status">
      <header>
        <strong>{{ toolLabel(tool.name) }}</strong>
        <span>{{ statusLabel(tool.status) }}</span>
      </header>
      <details v-if="tool.input">
        <summary>{{ t('room.toolInput') }}</summary>
        <pre>{{ tool.input }}</pre>
      </details>
      <details v-if="tool.output">
        <summary>{{ t('room.toolOutput') }}</summary>
        <pre>{{ tool.output }}</pre>
      </details>
      <p v-if="tool.exitCode !== undefined" class="room-muted">{{ t('room.toolExit', { code: tool.exitCode }) }}</p>
    </article>
  </details>
</template>

<script setup>
import { computed, ref } from 'vue'
import { t } from '../i18n.js'

const props = defineProps({
  api: { type: Object, required: true },
  roomId: { type: String, required: true },
  chatId: { type: String, required: true },
  runId: { type: String, required: true },
  live: { type: Object, default: null },
})

const events = ref([])
const loading = ref(false)
const loadError = ref(false)
let loaded = false

const tools = computed(() => {
  if (props.live?.tools?.length) return props.live.tools
  const byCallId = new Map()
  for (const event of events.value) {
    const payload = event.payload || {}
    if (!['tool_call_started', 'tool_call_input', 'tool_call_ended'].includes(payload.kind)) continue
    const callId = payload.callId || payload.toolName || `tool-${event.id}`
    const previous = byCallId.get(callId) || { callId, name: payload.toolName || 'tool', input: '', output: '', status: 'running' }
    byCallId.set(callId, {
      ...previous,
      name: payload.toolName || previous.name,
      input: payload.input ?? previous.input,
      output: payload.output ?? previous.output,
      status: payload.status || previous.status,
      ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
    })
  }
  return [...byCallId.values()]
})

const usage = computed(() => {
  if (props.live?.usage) return props.live.usage
  for (let index = events.value.length - 1; index >= 0; index -= 1) {
    const payload = events.value[index].payload
    if (payload?.kind === 'usage' && payload.usage) return payload.usage
  }
  return null
})

const usageLabel = computed(() => {
  if (!usage.value) return ''
  if (usage.value.context?.percent != null) return `${Math.round(usage.value.context.percent)}%`
  if (usage.value.totalTokens != null) return String(usage.value.totalTokens)
  return ''
})

const toolCount = computed(() => tools.value.length)

function statusLabel(status) {
  const key = `room.status.${status || 'unknown'}`
  const label = t(key)
  return label === key ? String(status || '') : label
}

function toolLabel(name) {
  return String(name || 'tool')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^tyche_/, '')
}

async function load() {
  if (loading.value) return
  loading.value = true
  loadError.value = false
  try {
    events.value = await props.api.runtimeEvents({
      roomId: props.roomId,
      chatId: props.chatId,
      runId: props.runId,
      limit: 1000,
    })
    loaded = true
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function onToggle(event) {
  if (!event.target?.open || loaded || props.live) return
  void load()
}
</script>
