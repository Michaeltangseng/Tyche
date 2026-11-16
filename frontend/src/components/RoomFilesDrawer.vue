<template>
  <aside class="room-files-drawer" role="complementary" :aria-label="t('room.files')">
    <header class="room-files-drawer-header">
      <strong>{{ t('room.files') }}</strong>
      <button class="icon-button" type="button" :title="t('room.closeFiles')" :aria-label="t('room.closeFiles')" @click="$emit('close')">
        <CloseOutline />
      </button>
    </header>
    <div class="room-files-tree">
      <WorkdirTree :controller="treeController" />
    </div>
    <div class="room-files-preview">
      <FilePreview :controller="previewController" />
    </div>
  </aside>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { CloseOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
import { useWorkdirTree } from '../composables/useWorkdirTree.js'
import WorkdirTree from './workdir/WorkdirTree.vue'
import FilePreview from './workdir/FilePreview.vue'

const props = defineProps({
  api: { type: Object, required: true },
  roomId: { type: String, required: true },
})
defineEmits(['close'])

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
  select: async (path) => {
    await tree.readFile(path)
  },
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

onMounted(() => { void tree.loadDirectory('') })
</script>

<style scoped>
.room-files-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(380px, 100%);
  border-left: 1px solid var(--border);
  background: var(--surface-raised);
  box-shadow: -18px 0 50px rgb(0 0 0 / 0.18);
}
.room-files-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.room-files-drawer-header strong { font-size: var(--text-sm); }
.room-files-tree {
  flex: 0 0 42%;
  min-height: 0;
  overflow: auto;
  border-bottom: 1px solid var(--border);
}
.room-files-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
@media (max-width: 720px) {
  .room-files-drawer { width: 100%; }
}
</style>
