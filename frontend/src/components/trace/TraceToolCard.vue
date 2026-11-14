<template>
  <article class="trace-tool-card" :data-status="status || 'running'">
    <header>
      <strong>{{ title || t('trace.steps.tool') }}</strong>
      <span v-if="status" class="trace-tool-status" :data-status="status">{{ statusLabel }}</span>
      <button
        v-if="command"
        class="trace-copy"
        type="button"
        :title="t('trace.steps.copyCommand')"
        :aria-label="t('trace.steps.copyCommand')"
        @click="copy(command)"
      >
        {{ t('trace.steps.copy') }}
      </button>
    </header>
    <pre v-if="command" class="trace-tool-command">{{ command }}</pre>
    <div v-if="inputText" class="trace-tool-input">
      <span>{{ t('trace.steps.input') }}</span>
      <pre>{{ inputText }}</pre>
    </div>
    <div class="trace-tool-output">
      <button class="trace-tool-toggle" type="button" @click="toggleExpanded">
        {{ expanded ? t('trace.steps.hideOutput') : t('trace.steps.showOutput') }}
      </button>
      <span v-if="hasBlob" class="trace-tool-blob">{{ t('trace.steps.largeOutput') }}</span>
      <template v-if="expanded">
        <p v-if="loadingBlob" class="trace-tool-empty">{{ t('trace.steps.loadingOutput') }}</p>
        <pre v-else-if="outputText" class="trace-tool-output-text">{{ outputText }}</pre>
        <p v-else class="trace-tool-empty">{{ t('trace.steps.noOutput') }}</p>
        <button
          v-if="outputText"
          class="trace-copy"
          type="button"
          :title="t('trace.steps.copyOutput')"
          :aria-label="t('trace.steps.copyOutput')"
          @click="copy(outputText)"
        >
          {{ t('trace.steps.copy') }}
        </button>
      </template>
    </div>
  </article>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  steps: { type: Array, required: true },
  controller: { type: Object, required: true },
})

const { loadBlob, t } = props.controller
const expanded = ref(false)
const loadingBlob = ref(false)
const blobText = ref('')

const first = computed(() => props.steps[0] || {})
const lastOutput = computed(() => {
  for (let index = props.steps.length - 1; index >= 0; index -= 1) {
    const step = props.steps[index]
    if (typeof step.output === 'string' && step.output) return step.output
  }
  return ''
})
const outputBlob = computed(() => {
  for (let index = props.steps.length - 1; index >= 0; index -= 1) {
    const blob = props.steps[index].blobs?.output
    if (blob) return blob
  }
  return null
})
const hasBlob = computed(() => Boolean(outputBlob.value))
const outputText = computed(() => blobText.value || lastOutput.value)
const title = computed(() => String(first.value.title || ''))
const command = computed(() => String(first.value.command || ''))
const status = computed(() => String(first.value.status || props.steps.at(-1)?.status || ''))
const statusLabel = computed(() => {
  const key = `trace.steps.status.${status.value}`
  const label = t(key)
  return label === key ? status.value : label
})
const inputText = computed(() => {
  const input = first.value.input
  if (input === undefined || input === null || input === '') return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return '' }
})

async function toggleExpanded() {
  expanded.value = !expanded.value
  if (!expanded.value || blobText.value || !outputBlob.value) return
  loadingBlob.value = true
  try {
    const result = await loadBlob?.(outputBlob.value.blobId, {
      offset: 0,
      length: Math.min(Number(outputBlob.value.bytes) || 256 * 1024, 256 * 1024),
    })
    blobText.value = String(result?.text || '')
  } finally {
    loadingBlob.value = false
  }
}

async function copy(value) {
  try { await navigator.clipboard?.writeText(String(value || '')) } catch { /* clipboard may be unavailable */ }
}
</script>
