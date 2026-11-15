<template>
  <section class="trace-step-list" :class="{ compact }">
    <header v-if="!compact" class="trace-step-list-header">
      <div class="trace-step-list-title">
        <strong>{{ t('trace.steps.title') }}</strong>
      </div>
      <button class="trace-step-view-toggle" type="button" @click="rawView = !rawView">
        {{ rawView ? t('trace.steps.structuredView') : t('trace.steps.rawView') }}
      </button>
    </header>
    <p v-if="incomplete" class="trace-step-incomplete" role="status">
      {{ t('trace.steps.incomplete') }}
    </p>
    <TraceRawView v-if="!compact && rawView" :steps="rawSteps" />
    <template v-else>
      <button
        v-if="!compact && hasMore"
        class="trace-step-more"
        type="button"
        :disabled="loading"
        @click="loadOlder"
      >
        {{ loading ? t('trace.steps.loading') : t('trace.steps.loadOlder') }}
      </button>
      <template v-for="(block, blockIndex) in blocks" :key="block.key">
        <TraceToolActivity
          v-if="block.kind === 'command' || block.kind === 'tool'"
          :block="block"
          :controller="controller"
          :default-open="(compact && block.kind === 'command') || blockIndex === blocks.length - 1"
          :t="t"
        />

        <details
          v-else-if="block.kind === 'thinking'"
          class="trace-activity-block trace-thinking-block"
        >
          <summary class="trace-activity-header">
            <SparklesOutline class="trace-activity-icon" aria-hidden="true" />
            <span class="trace-activity-title">
              {{ t('trace.activity.thinking', { count: block.count }) }}
            </span>
            <span class="trace-activity-spacer" />
            <TraceStatusIcon :status="block.status" :t="t" />
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <pre class="trace-thinking-text">{{ block.text }}</pre>
        </details>

        <details
          v-else-if="block.kind === 'file'"
          class="trace-activity-block trace-file-block"
          open
        >
          <summary class="trace-activity-header">
            <DocumentTextOutline class="trace-activity-icon" aria-hidden="true" />
            <span class="trace-activity-title">
              {{ t('trace.activity.files', { count: block.count }) }}
            </span>
            <span class="trace-activity-spacer" />
            <TraceStatusIcon :status="block.status" :t="t" />
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <ul class="trace-file-list">
            <li
              v-for="file in block.files"
              :key="file.path"
              class="trace-file-row"
              :data-status="file.status"
            >
              <component :is="fileIcon(file.path)" class="trace-file-icon" aria-hidden="true" />
              <span class="trace-file-copy">
                <span class="trace-file-name">
                  <strong>{{ file.name }}</strong>
                  <span
                    v-if="file.deleted"
                    class="trace-file-badge removed"
                  >{{ t('trace.files.deleted') }}</span>
                  <span
                    v-else-if="file.created"
                    class="trace-file-badge"
                  >{{ t('trace.files.created') }}</span>
                </span>
                <small>{{ file.path }}</small>
              </span>
              <span class="trace-file-stats" aria-hidden="true">
                <span v-if="file.additions" class="added">+{{ file.additions }}</span>
                <span v-if="file.deletions" class="removed">-{{ file.deletions }}</span>
              </span>
              <button
                v-if="previewFile && file.relativePath"
                class="trace-file-preview"
                type="button"
                @click.stop="emit('preview-file', file.relativePath)"
              >
                {{ t('trace.files.preview') }}
              </button>
            </li>
          </ul>
        </details>

        <details v-else-if="block.kind === 'plan'" class="trace-activity-block trace-plan-block">
          <summary class="trace-activity-header">
            <ListOutline class="trace-activity-icon" aria-hidden="true" />
            <span class="trace-activity-title">{{ t('trace.activity.plan') }}</span>
            <span class="trace-activity-spacer" />
            <TraceStatusIcon :status="block.status" :t="t" />
            <ChevronDownOutline class="trace-activity-chevron" aria-hidden="true" />
          </summary>
          <pre class="trace-thinking-text">{{ block.text }}</pre>
        </details>
      </template>

      <p v-if="!blocks.length && !loading" class="trace-step-empty">
        {{ t('trace.steps.empty') }}
      </p>
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  ChevronDownOutline,
  CodeSlashOutline,
  DocumentOutline,
  DocumentTextOutline,
  ImageOutline,
  ListOutline,
  SparklesOutline,
} from '@vicons/ionicons5'
import { buildTraceActivities } from '../../tracePresentation.js'
import TraceRawView from './TraceRawView.vue'
import TraceStatusIcon from './TraceStatusIcon.vue'
import TraceToolActivity from './TraceToolActivity.vue'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const CODE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'less',
  'html', 'json', 'yml', 'yaml', 'toml', 'sh', 'zsh', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'sql',
])

const props = defineProps({
  compact: { type: Boolean, default: false },
  controller: { type: Object, required: true },
  live: { type: Boolean, default: false },
  previewFile: { type: Function, default: null },
  workdir: { type: String, default: '' },
})

const emit = defineEmits(['preview-file'])
const {
  steps,
  loading,
  hasMore,
  incomplete,
  loadOlder,
  t,
} = props.controller

const rawView = ref(false)
const activities = computed(() => buildTraceActivities(steps.value || [], {
  workdir: props.workdir,
}))
const blocks = computed(() => activities.value.blocks)
const rawSteps = computed(() => (steps.value || [])
  .filter(step => ['message', 'raw', 'stderr'].includes(step.kind))
  .slice(-200))

function fileExtension(path) {
  return String(path || '').split('.').at(-1).toLowerCase()
}

function fileIcon(path) {
  const extension = fileExtension(path)
  if (IMAGE_EXTENSIONS.has(extension)) return ImageOutline
  if (CODE_EXTENSIONS.has(extension)) return CodeSlashOutline
  if (extension === 'md' || extension === 'txt') return DocumentTextOutline
  return DocumentOutline
}
</script>
