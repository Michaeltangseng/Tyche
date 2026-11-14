<template>
  <details class="trace-tool-activity" open>
    <summary>
      <BuildOutline aria-hidden="true" />
      <span>{{ t('trace.steps.toolActivity') }}</span>
      <small>{{ t('trace.steps.toolCount', { count: tools.length }) }}</small>
      <span class="trace-tool-activity-status" :data-status="overallStatus">{{ statusLabel(overallStatus) }}</span>
      <span class="trace-activity-spacer" />
      <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
    </summary>
    <ul class="trace-tool-activity-list">
      <li v-for="tool in tools" :key="tool.key">
        <details class="trace-tool-row" :data-status="tool.status || 'running'">
          <summary>
            <TerminalOutline aria-hidden="true" />
            <span class="trace-tool-row-copy">
              <strong>{{ tool.title }}</strong>
              <small v-if="tool.summary">{{ tool.summary }}</small>
            </span>
            <span class="trace-tool-row-status" :data-status="tool.status">
              {{ statusLabel(tool.status) }}
            </span>
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <div class="trace-tool-row-detail">
            <pre v-if="tool.command" class="trace-tool-shell"><span aria-hidden="true">$ </span>{{ tool.command }}</pre>
            <pre v-if="tool.output" class="trace-tool-row-output">{{ tool.output }}</pre>
            <button
              v-else-if="tool.outputBlob && !loadedBlobs[tool.key]"
              class="trace-tool-load"
              type="button"
              :disabled="loadingBlobs[tool.key]"
              @click="loadBlob(tool)"
            >
              {{ loadingBlobs[tool.key] ? t('trace.steps.loadingOutput') : t('trace.steps.loadLargeOutput') }}
            </button>
            <pre v-else-if="loadedBlobs[tool.key]" class="trace-tool-row-output">{{ loadedBlobs[tool.key] }}</pre>
            <details v-if="tool.inputText" class="trace-tool-input">
              <summary>{{ t('trace.steps.input') }}</summary>
              <pre>{{ tool.inputText }}</pre>
            </details>
            <p v-if="!tool.command && !tool.output && !tool.inputText && !tool.outputBlob" class="trace-tool-empty">
              {{ t('trace.steps.noOutput') }}
            </p>
          </div>
        </details>
      </li>
    </ul>
  </details>
</template>

<script setup>
import { computed, reactive } from 'vue'
import {
  BuildOutline,
  ChevronDownOutline,
  TerminalOutline,
} from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
  steps: { type: Array, required: true },
  t: { type: Function, required: true },
})

const loadedBlobs = reactive({})
const loadingBlobs = reactive({})

const tools = computed(() => {
  const groups = new Map()
  for (const step of props.steps) {
    const key = step.toolCallId || `tool:${step.seq}`
    let group = groups.get(key)
    if (!group) {
      group = { key, steps: [] }
      groups.set(key, group)
    }
    group.steps.push(step)
  }
  return [...groups.values()].map(group => {
    const inputStep = [...group.steps].reverse().find(step => step.input !== undefined)
    const commandStep = group.steps.find(step => step.command)
    const outputStep = [...group.steps].reverse().find(step => step.output)
    const blobStep = [...group.steps].reverse().find(step => step.blobs?.output)
    const last = group.steps.at(-1) || {}
    const title = group.steps
      .map(step => String(step.title || '').trim())
      .find(title => title && !['tool', 'tool_result', 'event'].includes(title.toLowerCase()))
      || commandSummary(group.steps)
      || props.t('trace.steps.tool')
    return {
      key: group.key,
      title,
      summary: commandSummary(group.steps),
      status: last.status || group.steps[0]?.status || '',
      command: commandStep?.command || '',
      inputText: inputText(inputStep?.input),
      output: outputStep?.output || '',
      outputBlob: blobStep?.blobs?.output || null,
    }
  })
})

const overallStatus = computed(() => {
  if (tools.value.some(tool => tool.status === 'running')) return 'running'
  if (tools.value.some(tool => tool.status === 'failed')) return 'failed'
  return 'completed'
})

function commandSummary(steps) {
  for (const step of steps) {
    if (step.command) return oneLine(step.command)
    const input = step.input
    if (!input) continue
    if (typeof input === 'string') return oneLine(input)
    const value = input.command || input.file_path || input.path || input.pattern
      || input.query || input.description
    if (typeof value === 'string' && value.trim()) return oneLine(value)
    try { return oneLine(JSON.stringify(input)) } catch { return '' }
  }
  return ''
}

function inputText(input) {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return '' }
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function statusLabel(status) {
  const key = `trace.steps.status.${status}`
  const label = props.t(key)
  return label === key ? status || '' : label
}

async function loadBlob(tool) {
  if (!tool.outputBlob || loadingBlobs[tool.key]) return
  loadingBlobs[tool.key] = true
  try {
    const result = await props.controller.loadBlob?.(tool.outputBlob.blobId, {
      offset: 0,
      length: Math.min(Number(tool.outputBlob.bytes) || 256 * 1024, 256 * 1024),
    })
    loadedBlobs[tool.key] = String(result?.text || '')
  } finally {
    loadingBlobs[tool.key] = false
  }
}
</script>
