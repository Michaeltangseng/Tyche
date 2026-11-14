<template>
  <section class="trace-step-list">
    <header class="trace-step-list-header">
      <div class="trace-step-list-title">
        <strong>{{ t('trace.steps.title') }}</strong>
        <small v-if="items.length">{{ visibleItems.length }} / {{ items.length }}</small>
      </div>
      <button class="trace-step-view-toggle" type="button" @click="rawView = !rawView">
        {{ rawView ? t('trace.steps.structuredView') : t('trace.steps.rawView') }}
      </button>
    </header>
    <p v-if="incomplete" class="trace-step-incomplete" role="status">
      {{ t('trace.steps.incomplete') }}
    </p>
    <TraceRawView v-if="rawView" :steps="rawSteps" />
    <template v-else>
      <template v-for="item in visibleItems" :key="item.key">
        <TraceToolCard
          v-if="item.kind === 'tool-group'"
          :steps="item.steps"
          :controller="controller"
        />
        <details v-else-if="item.kind === 'thinking'" class="trace-activity trace-activity-thinking">
          <summary>
            <SparklesOutline aria-hidden="true" />
            <span>{{ t('trace.steps.thinking') }}</span>
            <small v-if="item.count > 1">{{ t('trace.steps.chunks', { count: item.count }) }}</small>
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <pre>{{ item.output }}</pre>
        </details>
        <details v-else-if="item.kind === 'lifecycle'" class="trace-activity" :data-status="item.status">
          <summary>
            <WarningOutline aria-hidden="true" />
            <span>{{ lifecycleLabel(item) }}</span>
            <small v-if="item.status">{{ item.status }}</small>
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <pre v-if="item.output">{{ item.output }}</pre>
        </details>
      </template>
      <p v-if="!items.length && !loading" class="trace-step-empty">
        {{ t('trace.steps.empty') }}
      </p>
      <button
        v-if="hasMore"
        class="trace-step-more"
        type="button"
        :disabled="loading"
        @click="loadOlder"
      >
        {{ loading ? t('trace.steps.loading') : t('trace.steps.loadOlder') }}
      </button>
      <button
        v-else-if="visibleCount < items.length"
        class="trace-step-more"
        type="button"
        @click="visibleCount += STEP_PAGE"
      >
        {{ t('trace.steps.showMore') }}
      </button>
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  ChevronDownOutline,
  SparklesOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import TraceRawView from './TraceRawView.vue'
import TraceToolCard from './TraceToolCard.vue'

const STEP_PAGE = 40
const RAW_LIMIT = 200

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  steps,
  loading,
  hasMore,
  incomplete,
  loadOlder,
  t,
} = props.controller

const rawView = ref(false)
const visibleCount = ref(STEP_PAGE)

const meaningfulSteps = computed(() => (steps.value || []).filter(step => (
  !['raw', 'stderr', 'message'].includes(step.kind)
)))
const rawSteps = computed(() => (steps.value || [])
  .filter(step => ['raw', 'stderr', 'message'].includes(step.kind))
  .slice(-RAW_LIMIT))

const items = computed(() => {
  const result = []
  const tools = new Map()
  let thinking = null
  for (const step of meaningfulSteps.value) {
    if (step.kind === 'thinking') {
      if (!thinking) {
        thinking = {
          key: `thinking:${step.seq}`,
          kind: 'thinking',
          count: 0,
          output: '',
          seq: step.seq,
        }
        result.push(thinking)
      }
      thinking.count += 1
      thinking.output += step.output || ''
      continue
    }
    thinking = null
    if (step.kind === 'tool') {
      const id = step.toolCallId || `tool-step-${step.seq}`
      const existing = tools.get(id)
      if (existing) {
        existing.steps.push(step)
      } else {
        const group = { key: `tool:${id}`, kind: 'tool-group', steps: [step] }
        tools.set(id, group)
        result.push(group)
      }
      continue
    }
    if (step.kind === 'lifecycle') {
      if (step.status !== 'failed' && step.status !== 'incomplete') continue
      result.push({
        key: `lifecycle:${step.seq}`,
        kind: 'lifecycle',
        status: step.status,
        title: step.title,
        output: step.output || '',
      })
    }
  }
  return result
})

const visibleItems = computed(() => items.value.slice(0, visibleCount.value))

function lifecycleLabel(item) {
  const key = `trace.steps.lifecycle.${item.title}`
  const label = t(key)
  return label === key ? item.title || t('trace.steps.status') : label
}
</script>
