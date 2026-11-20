<template>
  <section class="agent-activity" :class="{ live, collapsed: !expanded }">
    <button
      class="agent-activity-summary"
      type="button"
      :aria-expanded="expanded ? 'true' : 'false'"
      :title="summaryText"
      @click="toggle"
    >
      <ChevronForwardOutline class="agent-activity-chevron" :class="{ expanded }" aria-hidden="true" />
      <span class="agent-activity-text">{{ summaryText }}</span>
      <span v-if="live" class="agent-activity-live" aria-hidden="true" />
      <span
        v-if="hasStatus"
        class="agent-activity-status"
        :data-status="tone"
        role="img"
        :aria-label="statusText"
      >
        <CheckmarkCircleOutline v-if="tone === 'completed'" aria-hidden="true" />
        <CloseCircleOutline v-else-if="tone === 'failed'" aria-hidden="true" />
        <WarningOutline v-else-if="tone === 'partial'" aria-hidden="true" />
        <span v-else class="agent-activity-spinner" aria-hidden="true" />
      </span>
    </button>

    <div v-if="expanded" class="agent-activity-details">
      <TraceStepList
        v-if="hasFullTrace"
        :compact="compact"
        :controller="controller"
        :live="live"
        :preview-file="previewFile"
        :workdir="workdir"
        @preview-file="previewPath"
      />
      <p v-else-if="!loading" class="inline-trace-empty">
        {{ live ? t('trace.inline.waiting') : t('trace.steps.noFullTrace') }}
      </p>
    </div>

    <div v-if="!expanded && visibleFiles.length" class="agent-file-list">
      <article
        v-for="file in visibleFiles"
        :key="file.path"
        class="agent-file-card"
        :data-status="file.status"
        :title="file.path"
      >
        <span class="agent-file-icon" :data-kind="fileKind(file.path)" aria-hidden="true">
          <component :is="fileIcon(file.path)" />
        </span>
        <span class="agent-file-copy">
          <span class="agent-file-name">
            <strong>{{ file.name }}</strong>
            <span v-if="file.deleted" class="agent-file-badge removed">{{ t('trace.files.deleted') }}</span>
            <span v-else-if="file.created" class="agent-file-badge">{{ t('trace.files.created') }}</span>
          </span>
          <small>{{ file.path }}</small>
        </span>
        <span class="agent-file-stats" aria-hidden="true">
          <span v-if="file.additions" class="added">+{{ file.additions }}</span>
          <span v-if="file.deletions" class="removed">-{{ file.deletions }}</span>
        </span>
        <span class="agent-file-actions">
          <button
            v-if="previewFile && file.relativePath"
            type="button"
            @click.stop="preview(file)"
          >
            {{ t('trace.files.preview') }}
          </button>
        </span>
      </article>
      <p v-if="hiddenFileCount" class="agent-file-more">
        {{ t('trace.files.more', { count: hiddenFileCount }) }}
      </p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  CloseCircleOutline,
  CodeSlashOutline,
  DocumentOutline,
  DocumentTextOutline,
  ImageOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { runStatusTone } from '../../conversationTimelineModel.js'
import { buildTraceActivities } from '../../tracePresentation.js'
import { useTraceStream } from '../../composables/useTraceStream.js'
import TraceStepList from './TraceStepList.vue'

const MAX_FILES = 6
const INLINE_TRACE_PAGE = 200
const CODE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'less',
  'html', 'json', 'yml', 'yaml', 'toml', 'sh', 'zsh', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'sql',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'log', 'pdf', 'doc', 'docx'])

const props = defineProps({
  agentRunId: { type: String, required: true },
  compact: { type: Boolean, default: true },
  defaultOpen: { type: Boolean, default: false },
  elapsedLabel: { type: String, default: '' },
  live: { type: Boolean, default: false },
  previewFile: { type: Function, default: null },
  runId: { type: String, required: true },
  status: { type: String, default: '' },
  statusLabel: { type: String, default: '' },
  t: { type: Function, required: true },
  workdir: { type: String, default: '' },
})

const emit = defineEmits(['preview-file'])

const expanded = ref(props.defaultOpen)
const stream = useTraceStream({
  runId: computed(() => props.runId),
  agentRunId: computed(() => props.agentRunId),
  pageSize: INLINE_TRACE_PAGE,
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

const activities = computed(() => buildTraceActivities(steps.value || [], {
  workdir: props.workdir,
}))
const summary = computed(() => activities.value.summary)
const visibleFiles = computed(() => summary.value.fileList.slice(0, MAX_FILES))
const hiddenFileCount = computed(() => Math.max(0, summary.value.fileList.length - MAX_FILES))
const summaryText = computed(() => {
  if (loading.value && !steps.value.length) return props.t('trace.inline.loading')
  if (!hasFullTrace.value) {
    return props.t(props.live ? 'trace.inline.waiting' : 'trace.inline.noSteps')
  }
  const parts = []
  if (summary.value.commands) {
    parts.push(props.t('trace.activity.commands', { count: summary.value.commands }))
  }
  if (summary.value.files) {
    parts.push(props.t('trace.activity.files', { count: summary.value.files }))
  }
  if (summary.value.thinking) {
    parts.push(props.t('trace.activity.thinkingShort'))
  }
  if (summary.value.tools) {
    parts.push(props.t('trace.activity.tools', { count: summary.value.tools }))
  }
  const shown = parts.slice(0, 3)
  if (props.elapsedLabel) shown.push(props.elapsedLabel)
  return shown.length ? shown.join(' · ') : props.t('trace.inline.title')
})
const hasStatus = computed(() => Boolean(props.status) || props.live)
const tone = computed(() => (
  props.live && !props.status ? 'running' : (runStatusTone(props.status) || 'running')
))
const statusText = computed(() => props.statusLabel || props.status || props.t('trace.inline.live'))

watch(() => props.defaultOpen, (value) => {
  if (value) expanded.value = true
})

watch(expanded, (value) => {
  stream.setViewing(value || props.live)
  if (value || props.live) void stream.open()
})

onMounted(() => {
  stream.setViewing(props.live)
  void stream.open()
})

function toggle() {
  expanded.value = !expanded.value
}

function previewPath(path) {
  if (!path) return
  emit('preview-file', path)
}

function preview(file) {
  previewPath(file?.relativePath)
}

function fileExtension(path) {
  return String(path || '').split('.').at(-1).toLowerCase()
}

function fileKind(path) {
  const extension = fileExtension(path)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  return 'file'
}

function fileIcon(path) {
  const kind = fileKind(path)
  if (kind === 'image') return ImageOutline
  if (kind === 'code') return CodeSlashOutline
  if (kind === 'document') return DocumentTextOutline
  return DocumentOutline
}
</script>
