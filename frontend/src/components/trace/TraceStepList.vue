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
        <TraceToolActivity
          v-if="item.kind === 'tool-block'"
          :steps="item.steps"
          :controller="controller"
          :t="t"
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
} from '@vicons/ionicons5'
import TraceRawView from './TraceRawView.vue'
import TraceToolActivity from './TraceToolActivity.vue'

const STEP_PAGE = 40
const RAW_LIMIT = 200

const props = defineProps({
  controller: { type: Object, required: true },
  live: { type: Boolean, default: false },
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
  let thinking = null
  let toolBlock = null
  for (const step of meaningfulSteps.value) {
    if (step.kind === 'thinking') {
      toolBlock = null
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
    if (step.kind === 'tool') {
      thinking = null
      if (!toolBlock) {
        toolBlock = {
          key: `tools:${step.seq}`,
          kind: 'tool-block',
          steps: [],
        }
        result.push(toolBlock)
      }
      toolBlock.steps.push(step)
      continue
    }
    thinking = null
    toolBlock = null
  }
  return result
})

const visibleItems = computed(() => (
  props.live
    ? items.value.slice(-visibleCount.value)
    : items.value.slice(0, visibleCount.value)
))
</script>
