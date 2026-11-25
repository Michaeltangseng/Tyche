<template>
  <div class="project-room-drawer-layer" :class="{ drawer }">
    <button
      v-if="drawer"
      class="project-room-drawer-scrim"
      type="button"
      :aria-label="t('room.closeFiles')"
      @click="$emit('close')"
    />
    <aside
      ref="panelElement"
      class="project-room-drawer"
      :role="drawer ? 'dialog' : 'complementary'"
      :aria-modal="drawer ? 'true' : undefined"
      :aria-label="t('room.files')"
      :style="drawer ? undefined : { width: `${width}px` }"
      tabindex="-1"
    >
      <header class="project-room-drawer-header">
        <span class="project-room-drawer-title">{{ t('room.files') }}</span>
        <button class="icon-button" type="button" :title="t('room.closeDrawer')" :aria-label="t('room.closeDrawer')" @click="$emit('close')">
          <CloseOutline />
        </button>
      </header>
      <section
        ref="filesPanel"
        class="project-room-drawer-body project-room-drawer-files"
        :class="{ 'preview-hidden': !previewVisible }"
      >
        <div class="file-panel-toolbar">
          <span>{{ t('room.files') }}</span>
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
        <WorkdirTree :controller="treeController" :style="treeStyle" />
        <div
          v-if="previewVisible"
          class="file-panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          :aria-label="t('workdir.preview.resize')"
          @pointerdown.prevent="startFilePanelResize"
        />
        <FilePreview v-if="previewVisible" :controller="previewController" />
      </section>

      <div
        class="project-room-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('room.drawerResize')"
        @pointerdown.prevent="startResize"
      />
    </aside>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CloseOutline, EyeOffOutline, EyeOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
import { useWorkdirTree } from '../composables/useWorkdirTree.js'
import WorkdirTree from './workdir/WorkdirTree.vue'
import FilePreview from './workdir/FilePreview.vue'

const props = defineProps({
  api: { type: Object, required: true },
  roomId: { type: String, required: true },
  width: { type: Number, default: 420 },
})
const emit = defineEmits(['close', 'resize'])

const panelElement = ref(null)
const filesPanel = ref(null)
const drawer = ref(false)
let drawerMediaQuery = null
const previewVisible = ref(true)
const treeHeight = ref(42)
let resizeState = null
let fileResizeState = null
let resizeFrame = 0
let fileResizeFrame = 0
const treeStyle = computed(() => (
  previewVisible.value
    ? { flex: `0 0 ${treeHeight.value}%`, height: `${treeHeight.value}%` }
    : { flex: '1 1 auto', height: 'auto' }
))

const roomScope = computed(() => props.roomId)
const fileApi = {
  list: input => props.api.filesList({
    roomId: props.roomId,
    relPath: input.relPath || '',
    ...(input.cursor ? { cursor: input.cursor } : {}),
  }),
  read: input => props.api.filesRead({
    roomId: props.roomId,
    relPath: input.relPath,
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.length !== undefined ? { length: input.length } : {}),
  }),
}
const tree = useWorkdirTree({ projectId: roomScope, api: fileApi })
const treeController = {
  error: tree.error,
  expanded: tree.expanded,
  loading: tree.loading,
  rows: tree.visibleRows,
  select: async (path) => { await tree.readFile(path) },
  selected: tree.selected,
  t,
  toggle: tree.toggle,
}
const previewController = {
  error: tree.error,
  loadMorePreview: tree.loadMorePreview,
  loading: tree.loading,
  preview: tree.preview,
  t,
}

const MIN_WIDTH = 280
const MAX_WIDTH = 760

function renderedWidth() {
  const value = Number(panelElement.value?.getBoundingClientRect?.().width)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : props.width
}

function startResize(event) {
  resizeState = { startX: event.clientX, lastX: event.clientX, startWidth: renderedWidth() }
  document.body.classList.add('drawer-resizing')
  window.addEventListener('pointermove', handleResize)
  window.addEventListener('pointerup', finishResize, { once: true })
  window.addEventListener('pointercancel', finishResize, { once: true })
  window.addEventListener('blur', finishResize, { once: true })
}

function handleResize(event) {
  if (!resizeState) return
  resizeState.lastX = event.clientX
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    if (!resizeState) return
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeState.startWidth + (resizeState.startX - resizeState.lastX)))
    emit('resize', width)
  })
}

function finishResize() {
  if (!resizeState) return
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeState.startWidth + (resizeState.startX - resizeState.lastX)))
  window.removeEventListener('pointermove', handleResize)
  window.removeEventListener('pointerup', finishResize)
  window.removeEventListener('pointercancel', finishResize)
  window.removeEventListener('blur', finishResize)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  resizeState = null
  document.body.classList.remove('drawer-resizing')
  emit('resize', width)
}

function startFilePanelResize(event) {
  const rect = filesPanel.value?.getBoundingClientRect?.()
  if (!rect) return
  fileResizeState = { top: rect.top, height: rect.height, lastY: event.clientY }
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

function handleEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

function syncDrawerMode() {
  drawer.value = drawerMediaQuery?.matches === true
}

watch(drawer, (value) => {
  document.body.classList.toggle('project-room-drawer-open', value)
})

onMounted(() => {
  drawerMediaQuery = window.matchMedia?.('(max-width: 1179px)') || null
  drawerMediaQuery?.addEventListener?.('change', syncDrawerMode)
  syncDrawerMode()
  panelElement.value?.focus?.()
  window.addEventListener('keydown', handleEscape)
  ensureFiles()
})

let filesLoaded = false
function ensureFiles() {
  if (filesLoaded) return
  filesLoaded = true
  void tree.loadDirectory('')
}

onBeforeUnmount(() => {
  drawerMediaQuery?.removeEventListener?.('change', syncDrawerMode)
  document.body.classList.remove('project-room-drawer-open')
  window.removeEventListener('pointermove', handleResize)
  window.removeEventListener('pointerup', finishResize)
  window.removeEventListener('pointercancel', finishResize)
  window.removeEventListener('blur', finishResize)
  window.removeEventListener('pointermove', handleFilePanelResize)
  window.removeEventListener('keydown', handleEscape)
  resizeState = null
  fileResizeState = null
  document.body.classList.remove('drawer-resizing')
  document.body.classList.remove('file-panel-resizing')
})
</script>

<style scoped>
.project-room-drawer-title { color: var(--text-soft); font-size: var(--text-sm); font-weight: 650; }
</style>
