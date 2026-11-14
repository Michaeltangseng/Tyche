<template>
  <section class="trace-step-list">
    <header class="trace-step-list-header">
      <strong>{{ t('trace.steps.title') }}</strong>
      <button class="trace-step-view-toggle" type="button" @click="rawView = !rawView">
        {{ rawView ? t('trace.steps.structuredView') : t('trace.steps.rawView') }}
      </button>
    </header>
    <p v-if="incomplete" class="trace-step-incomplete" role="status">
      {{ t('trace.steps.incomplete') }}
    </p>
    <TraceRawView v-if="rawView" :steps="steps" />
    <template v-else>
      <template v-for="item in visibleItems" :key="item.key">
        <TraceToolCard
          v-if="item.kind === 'tool-group'"
          :steps="item.steps"
          :controller="controller"
        />
        <details v-else-if="item.kind === 'thinking'" class="trace-step trace-step-thinking">
          <summary>{{ t('trace.steps.thinking') }}</summary>
          <pre>{{ item.output }}</pre>
        </details>
        <div v-else class="trace-step" :data-kind="item.kind">
          <span class="trace-step-kind">{{ kindLabel(item.kind) }}</span>
          <pre v-if="item.output">{{ item.output }}</pre>
          <small v-else-if="item.title">{{ item.title }}</small>
        </div>
      </template>
      <p v-if="!steps.length && !loading" class="trace-step-empty">
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
import TraceRawView from './TraceRawView.vue'
import TraceToolCard from './TraceToolCard.vue'

const STEP_PAGE = 200

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

const items = computed(() => {
  const result = []
  const tools = new Map()
  for (const step of steps.value || []) {
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
    result.push({ ...step, key: `step:${step.seq}` })
  }
  return result
})

const visibleItems = computed(() => items.value.slice(0, visibleCount.value))

function kindLabel(kind) {
  const key = `trace.steps.kind.${kind}`
  const label = t(key)
  return label === key ? String(kind || '') : label
}
</script>
