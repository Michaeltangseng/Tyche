<template>
  <details class="room-assignment-trace" @toggle="onToggle">
    <summary>
      {{ t('room.trace') }}
      <span v-if="steps.length"> · {{ steps.length }}</span>
    </summary>
    <p v-if="loading && !loaded" class="room-muted">{{ t('room.loadingTrace') }}</p>
    <p v-if="error" class="room-error" role="alert">
      {{ t('room.error') }}
      <button class="secondary-button" type="button" @click="load(false)">{{ t('room.refresh') }}</button>
    </p>
    <TraceStepList
      v-if="loaded"
      :controller="controller"
      :workdir="workdir"
      compact
    />
  </details>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { t } from '../i18n.js'
import TraceStepList from './trace/TraceStepList.vue'

const props = defineProps({
  api: { type: Object, required: true },
  roomId: { type: String, required: true },
  assignment: { type: Object, required: true },
  workdir: { type: String, default: '' },
})

const steps = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref(false)
const hasMore = ref(false)
const cursor = ref('')
const incomplete = ref(false)
let generation = 0

const controller = {
  steps,
  loading,
  hasMore,
  incomplete,
  loadOlder: () => load(true),
  loadBlob: (blobId, { offset = 0, length = 256 * 1024 } = {}) => props.api.assignmentTraceBlob({
    roomId: props.roomId,
    assignmentId: props.assignment.id,
    blobId,
    offset,
    length,
  }),
  t,
}

async function load(older = false) {
  if (loading.value) return
  const assignmentId = props.assignment.id
  const targetGeneration = generation
  loading.value = true
  error.value = false
  try {
    const page = await props.api.assignmentTrace({
      roomId: props.roomId,
      assignmentId,
      direction: 'backward',
      limit: 100,
      ...(older && cursor.value ? { cursor: cursor.value } : {}),
    })
    if (targetGeneration !== generation) return
    steps.value = older ? [...(page?.steps || []), ...steps.value] : [...(page?.steps || [])]
    cursor.value = page?.cursor || ''
    hasMore.value = Boolean(page?.hasMore)
    loaded.value = true
  } catch {
    if (targetGeneration === generation) error.value = true
  } finally {
    if (targetGeneration === generation) loading.value = false
  }
}

function onToggle(event) {
  if (!event?.target?.open || loaded.value || loading.value) return
  void load(false)
}

watch(() => props.assignment?.id, () => {
  generation += 1
  steps.value = []
  loaded.value = false
  error.value = false
  hasMore.value = false
  cursor.value = ''
})
</script>

<style scoped>
.room-assignment-trace { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-assignment-trace > summary { cursor: pointer; color: var(--text-soft); }
</style>
