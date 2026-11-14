<template>
  <div v-if="open" class="project-room-drawer-layer" :class="{ drawer }">
    <button
      v-if="drawer"
      class="project-room-drawer-scrim"
      type="button"
      :aria-label="t('projectRoom.drawer.close')"
      @click="close"
    />
    <aside
      ref="panelElement"
      class="project-room-drawer"
      :role="drawer ? 'dialog' : 'complementary'"
      :aria-modal="drawer ? 'true' : undefined"
      :aria-label="t('projectRoom.drawer.title')"
      :style="drawer ? undefined : { width: `${width}px` }"
      tabindex="-1"
    >
      <header class="project-room-drawer-header">
        <strong class="project-room-drawer-title">{{ t('projectRoom.drawer.files') }}</strong>
        <button
          class="icon-button"
          type="button"
          :title="t('projectRoom.drawer.close')"
          :aria-label="t('projectRoom.drawer.close')"
          @click="close"
        >
          <CloseOutline />
        </button>
      </header>

      <section
        ref="filesPanel"
        class="project-room-drawer-body project-room-drawer-files"
        :class="{ 'preview-hidden': !previewVisible }"
      >
        <div class="file-panel-toolbar">
          <span>{{ t('projectRoom.drawer.files') }}</span>
          <button
            class="file-panel-toggle"
            type="button"
            :aria-pressed="String(previewVisible)"
            @click="previewVisible = !previewVisible"
          >
            <EyeOutline v-if="previewVisible" aria-hidden="true" />
            <EyeOffOutline v-else aria-hidden="true" />
            {{ previewVisible ? t('workdir.preview.hide') : t('workdir.preview.show') }}
          </button>
        </div>
        <WorkdirTree
          :controller="workdirTreeController"
          :style="treeStyle"
        />
        <div
          v-if="previewVisible"
          class="file-panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          :aria-label="t('workdir.preview.resize')"
          @pointerdown.prevent="startFilePanelResize"
        />
        <template v-if="previewVisible">
          <FilePreview :controller="filePreviewController" />
          <FileDiff v-if="workdirTree.diff.value" :controller="fileDiffController" />
        </template>
      </section>

      <div
        class="project-room-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('projectRoom.drawer.resize')"
        @pointerdown.prevent="startResize"
      />
    </aside>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CloseOutline, EyeOffOutline, EyeOutline } from '@vicons/ionicons5'
import FileDiff from './workdir/FileDiff.vue'
import FilePreview from './workdir/FilePreview.vue'
import WorkdirTree from './workdir/WorkdirTree.vue'
import { useWorkdirTree } from '../composables/useWorkdirTree.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  close,
  drawer,
  onResize,
  open,
  projectId,
  projectSnapshot,
  savePreferences,
  t,
  theme,
  workdir,
} = props.controller

const DEFAULT_WIDTH = 420
const MIN_WIDTH = 280
const MAX_WIDTH = 760
const width = ref(DEFAULT_WIDTH)
const panelElement = ref(null)
const filesPanel = ref(null)
const previewVisible = ref(true)
const treeHeight = ref(42)
let fileResizeState = null
const treeStyle = computed(() => (
  previewVisible.value
    ? { flex: `0 0 ${treeHeight.value}%`, height: `${treeHeight.value}%` }
    : { flex: '1 1 auto', height: 'auto' }
))
let resizeState = null

const workdirTree = useWorkdirTree({
  projectId,
  api: workdir?.value || null,
})
const workdirTreeController = {
  error: workdirTree.error,
  expanded: workdirTree.expanded,
  loading: workdirTree.loading,
  rows: workdirTree.visibleRows,
  select: async (path) => {
    workdirTree.diff.value = null
    await workdirTree.readFile(path)
  },
  selected: workdirTree.selected,
  t,
  toggle: workdirTree.toggle,
}
const filePreviewController = {
  error: workdirTree.error,
  loadMorePreview: workdirTree.loadMorePreview,
  loading: workdirTree.loading,
  preview: workdirTree.preview,
  t,
}
const fileDiffController = {
  diff: workdirTree.diff,
  error: workdirTree.error,
  t,
  theme: theme?.value || 'light',
}

watch(() => projectSnapshot.value?.revision, () => {
  void workdirTree.refresh()
})

function applyPreferences() {
  const preferences = projectSnapshot.value?.preferences || {}
  if (Number.isInteger(preferences.drawerWidth)) {
    width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, preferences.drawerWidth))
  } else {
    width.value = DEFAULT_WIDTH
  }
}

watch(() => projectSnapshot.value?.preferences, applyPreferences, { immediate: true })
watch(() => projectId.value, applyPreferences)

function persistPreferences(preferences) {
  if (projectSnapshot.value?.readOnly) return
  void savePreferences(preferences)
}

function startResize(event) {
  resizeState = {
    startX: event.clientX,
    lastX: event.clientX,
    startWidth: width.value,
  }
  document.body.classList.add('drawer-resizing')
  window.addEventListener('pointermove', handleResize)
  window.addEventListener('pointerup', finishResize, { once: true })
}

let resizeFrame = 0

function handleResize(event) {
  if (!resizeState) return
  resizeState.lastX = event.clientX
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    if (!resizeState) return
    width.value = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, resizeState.startWidth + (resizeState.startX - resizeState.lastX)),
    )
    onResize?.(width.value)
  })
}

function finishResize() {
  window.removeEventListener('pointermove', handleResize)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  resizeState = null
  document.body.classList.remove('drawer-resizing')
  persistPreferences({ drawerWidth: width.value })
}

let fileResizeFrame = 0

function startFilePanelResize(event) {
  const rect = filesPanel.value?.getBoundingClientRect?.()
  if (!rect) return
  fileResizeState = {
    top: rect.top,
    height: rect.height,
    lastY: event.clientY,
  }
  document.body.classList.add('file-panel-resizing')
  window.addEventListener('pointermove', handleFilePanelResize)
  window.addEventListener('pointerup', finishFilePanelResize, { once: true })
}

function handleFilePanelResize(event) {
  if (!fileResizeState) return
  fileResizeState.lastY = event.clientY
  if (fileResizeFrame) return
  fileResizeFrame = requestAnimationFrame(() => {
    fileResizeFrame = 0
    if (!fileResizeState) return
    const ratio = (fileResizeState.lastY - fileResizeState.top) / fileResizeState.height
    treeHeight.value = Math.min(72, Math.max(20, Math.round(ratio * 100)))
  })
}

function finishFilePanelResize() {
  window.removeEventListener('pointermove', handleFilePanelResize)
  if (fileResizeFrame) cancelAnimationFrame(fileResizeFrame)
  fileResizeFrame = 0
  fileResizeState = null
  document.body.classList.remove('file-panel-resizing')
}

watch([open, drawer], ([isOpen, isDrawer]) => {
  document.body.classList.toggle('project-room-drawer-open', Boolean(isOpen && isDrawer))
}, { immediate: true })

function handleEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

onMounted(() => {
  panelElement.value?.focus?.()
  window.addEventListener('keydown', handleEscape)
  void workdirTree.loadDirectory('')
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handleResize)
  window.removeEventListener('pointermove', handleFilePanelResize)
  window.removeEventListener('keydown', handleEscape)
  document.body.classList.remove('project-room-drawer-open')
  document.body.classList.remove('drawer-resizing')
  document.body.classList.remove('file-panel-resizing')
})
</script>
