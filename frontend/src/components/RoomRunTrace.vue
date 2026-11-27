<template>
  <details class="room-run-trace" @toggle="onToggle">
    <summary>
      <span>{{ t('room.trace') }}</span>
      <span v-if="thinking" class="room-run-trace-count">{{ t('room.thinking') }}</span>
      <span v-if="toolCount" class="room-run-trace-count">{{ t('room.traceSteps', { count: toolCount }) }}</span>
      <span v-if="activityLabel" class="room-run-trace-activity">{{ activityLabel }}</span>
    </summary>
    <p v-if="thinking" class="room-run-thinking">{{ thinking }}</p>
    <p v-if="loading" class="room-muted">{{ t('room.loadingTrace') }}</p>
    <p v-else-if="loadError" class="room-error" role="alert">
      {{ t('room.traceError') }}
      <button class="secondary-button" type="button" @click="load">{{ t('room.refresh') }}</button>
    </p>
    <p v-else-if="!tools.length" class="room-muted">{{ t('room.traceEmpty') }}</p>
    <article v-for="tool in tools" :key="tool.callId" class="room-tool-card" :data-status="tool.status">
      <header>
        <strong>{{ activityText(tool) }}</strong>
        <span>{{ statusLabel(tool.status) }}</span>
      </header>
      <details v-if="tool.input">
        <summary>{{ t('room.toolInput') }}</summary>
        <pre>{{ tool.input }}</pre>
      </details>
      <details v-if="tool.output">
        <summary>{{ t('room.toolOutput') }}</summary>
        <pre>{{ shownOutput(tool) }}</pre>
        <button
          v-if="outputPreview(tool).truncated && !expandedOutputs[tool.callId]"
          class="secondary-button room-output-more"
          type="button"
          @click="expandedOutputs[tool.callId] = true"
        >{{ t('room.showAllOutput') }}</button>
      </details>
      <p v-if="tool.exitCode !== undefined" class="room-muted">{{ t('room.toolExit', { code: tool.exitCode }) }}</p>
    </article>
  </details>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { t } from '../i18n.js'
import { previewText, toolActivity } from '../room-usage.js'

const props = defineProps({
  api: { type: Object, required: true },
  roomId: { type: String, required: true },
  chatId: { type: String, required: true },
  runId: { type: String, required: true },
  live: { type: Object, default: null },
  steps: { type: Array, default: null },
  thinking: { type: String, default: '' },
})

const events = ref([])
const loading = ref(false)
const loadError = ref(false)
const expandedOutputs = reactive({})
let loaded = false

const tools = computed(() => {
  if (props.live?.tools?.length) return props.live.tools
  if (props.steps?.length) return props.steps
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

const toolCount = computed(() => tools.value.length)

const currentActivity = computed(() => {
  const list = tools.value
  if (!list.length) return null
  const running = [...list].reverse().find(tool => tool.status === 'running')
  return toolActivity(running || list[list.length - 1])
})

const activityLabel = computed(() => activityText(currentActivity.value))

function activityText(activity) {
  if (!activity) return ''
  const source = activity.verb ? activity : toolActivity(activity)
  if (source.verb === 'tool') return source.name
  const label = t(`room.activity.${source.verb}`, { target: source.target || '' }).replace(/\s+$/, '')
  return source.target ? label : label.replace(/\s+$/, '')
}

function outputPreview(tool) {
  return previewText(tool.output)
}

function shownOutput(tool) {
  return expandedOutputs[tool.callId] ? String(tool.output ?? '') : outputPreview(tool).text
}

function statusLabel(status) {
  const key = `room.status.${status || 'unknown'}`
  const label = t(key)
  return label === key ? String(status || '') : label
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
  if (!event.target?.open || loaded || props.live || props.steps?.length) return
  void load()
}
</script>

<style scoped>
.room-run-trace { margin-top: 8px; padding-top: 6px; font-size: var(--text-xs); }
.room-run-trace > summary { display: flex; gap: 8px; align-items: center; color: var(--text-soft); cursor: pointer; }
.room-run-trace-count { padding: 1px 6px; border-radius: 999px; background: var(--surface-active); color: var(--faint); font-size: 10px; }
.room-run-trace-activity { overflow: hidden; color: var(--accent-text); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-run-thinking { max-height: 16rem; overflow: auto; margin: 4px 0 8px; padding: 7px 8px; border-radius: 6px; background: var(--surface); color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.room-tool-card { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--surface) 82%, var(--surface-raised)); }
.room-tool-card[data-status="failed"] { border-color: color-mix(in srgb, var(--danger, #b94c4c) 45%, var(--border)); }
.room-tool-card header { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.room-tool-card header span { color: var(--faint); font-size: var(--text-2xs); }
.room-tool-card details { margin-top: 4px; }
.room-tool-card summary { color: var(--text-soft); cursor: pointer; }
.room-tool-card pre { max-height: 16rem; overflow: auto; margin: 4px 0 0; padding: 7px 8px; border-radius: 6px; background: var(--surface); font-size: var(--text-2xs); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
