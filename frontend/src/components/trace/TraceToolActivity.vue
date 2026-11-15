<template>
  <details
    class="trace-activity-block trace-tool-block"
    :data-kind="block.kind"
    :open="block.status === 'running' || defaultOpen"
  >
    <summary class="trace-activity-header">
      <component
        :is="block.kind === 'command' ? TerminalOutline : BuildOutline"
        class="trace-activity-icon"
        aria-hidden="true"
      />
      <span class="trace-activity-title">{{ title }}</span>
      <span class="trace-activity-spacer" />
      <TraceStatusIcon :status="block.status" :t="t" />
      <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
    </summary>

    <ul class="trace-step-rows">
      <li v-for="item in block.items" :key="item.key">
        <details class="trace-step-row" :data-status="item.status || 'completed'">
          <summary class="trace-step-row-summary">
            <template v-if="block.kind === 'command'">
              <span class="trace-step-row-command">
                {{ item.command || item.summary || item.title || t('trace.steps.tool') }}
              </span>
            </template>
            <template v-else>
              <span class="trace-step-row-title">{{ item.title || t('trace.steps.tool') }}</span>
              <span v-if="item.summary" class="trace-step-row-note">{{ item.summary }}</span>
            </template>
            <span class="trace-activity-spacer" />
            <TraceStatusIcon :status="item.status" :t="t" />
            <ChevronDownOutline class="trace-step-row-chevron" aria-hidden="true" />
          </summary>

          <div class="trace-step-row-detail">
            <pre v-if="item.command" class="trace-step-command"><span aria-hidden="true">$ </span>{{ item.command }}</pre>
            <pre v-if="item.output" class="trace-step-output">{{ item.output }}</pre>
            <button
              v-else-if="item.outputBlob && !loadedBlobs[item.key]"
              class="trace-step-load"
              type="button"
              :disabled="loadingBlobs[item.key]"
              @click="loadBlob(item)"
            >
              {{ loadingBlobs[item.key] ? t('trace.steps.loadingOutput') : t('trace.steps.loadLargeOutput') }}
            </button>
            <pre v-else-if="loadedBlobs[item.key]" class="trace-step-output">{{ loadedBlobs[item.key] }}</pre>
            <details v-if="item.inputText" class="trace-step-input">
              <summary>{{ t('trace.steps.input') }}</summary>
              <pre>{{ item.inputText }}</pre>
            </details>
            <p
              v-if="item.exitCode !== null && item.exitCode !== undefined"
              class="trace-step-exit"
            >
              {{ t('trace.activity.exitCode', { code: item.exitCode }) }}
            </p>
            <p
              v-if="!item.command && !item.output && !item.inputText && !item.outputBlob"
              class="trace-step-empty"
            >
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
import TraceStatusIcon from './TraceStatusIcon.vue'

const props = defineProps({
  block: { type: Object, required: true },
  controller: { type: Object, required: true },
  defaultOpen: { type: Boolean, default: false },
  t: { type: Function, required: true },
})

const loadedBlobs = reactive({})
const loadingBlobs = reactive({})

const title = computed(() => (
  props.block.kind === 'command'
    ? props.t('trace.activity.commands', { count: props.block.count })
    : props.t('trace.activity.tools', { count: props.block.count })
))

async function loadBlob(item) {
  if (!item.outputBlob || loadingBlobs[item.key]) return
  loadingBlobs[item.key] = true
  try {
    const result = await props.controller.loadBlob?.(item.outputBlob.blobId, {
      offset: 0,
      length: Math.min(Number(item.outputBlob.bytes) || 256 * 1024, 256 * 1024),
    })
    loadedBlobs[item.key] = String(result?.text || '')
  } finally {
    loadingBlobs[item.key] = false
  }
}
</script>
