<template>
  <div class="project-room-overlay" @keydown.esc.stop.prevent="handleEscape">
    <template v-if="kind === 'reject'">
      <template v-if="step === 1">
        <p class="overlay-description">{{ t('projectRoom.overlay.rejectStepOne') }}</p>
        <div class="overlay-list">
          <button
            v-for="item in upstreamCheckpoints"
            :key="item.checkpointId"
            class="overlay-list-row"
            type="button"
            :disabled="busy"
            @click="chooseUpstream(item.checkpointId)"
          >
            <span>
              <strong>{{ item.name }}</strong>
              <small>{{ item.label }}<template v-if="item.gate"> · {{ t('projectRoom.overlay.hasGate') }}</template></small>
            </span>
            <span aria-hidden="true">›</span>
          </button>
          <p v-if="!upstreamCheckpoints.length" class="overlay-empty">
            {{ t('projectRoom.overlay.noUpstream') }}
          </p>
        </div>
      </template>
      <template v-else>
        <div class="impact-preview">
          <p class="overlay-description">
            {{ t('projectRoom.overlay.affected', { count: impactItems.length }) }}
          </p>
          <div class="overlay-list">
            <div v-for="item in impactItems" :key="item.id" class="overlay-list-row">
              <span>
                <strong>{{ item.name }}</strong>
                <small>{{ item.label }}</small>
              </span>
              <span class="impact-tags">
                <em v-if="item.hard">{{ t('projectRoom.overlay.hardGate') }}</em>
                <em v-if="item.milestone">{{ t('projectRoom.overlay.milestone') }}</em>
              </span>
            </div>
          </div>
          <p v-if="preview && preview.activeInvocationEffectIds && preview.activeInvocationEffectIds.length" class="overlay-description">
            {{ t('projectRoom.overlay.cancelCalls', { count: preview.activeInvocationEffectIds.length }) }}
          </p>
        </div>
        <p v-if="impactChanged" class="overlay-warning">{{ t('projectRoom.overlay.impactChanged') }}</p>
        <label class="overlay-field">
          <span>{{ t('projectRoom.overlay.rejectReason') }}</span>
          <textarea v-model="reason" rows="4" :placeholder="t('projectRoom.overlay.reasonHint')" />
        </label>
        <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
        <footer class="overlay-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="step = 1">
            {{ t('projectRoom.overlay.back') }}
          </button>
          <button class="primary-button" type="button" :disabled="busy || !reason.trim()" @click="confirmReject">
            {{ t('projectRoom.overlay.confirmReject') }}
          </button>
        </footer>
      </template>
    </template>

    <template v-else-if="kind === 'reopen'">
      <p class="overlay-description">{{ t('projectRoom.overlay.reopenDescription') }}</p>
      <ImpactPreview :preview="preview" :progress-items="progressItems" :checkpoint-defs="checkpointDefs" :t="t" />
      <p v-if="impactChanged" class="overlay-warning">{{ t('projectRoom.overlay.impactChanged') }}</p>
      <label class="overlay-field">
        <span>{{ t('projectRoom.overlay.reopenReason') }}</span>
        <textarea v-model="reason" rows="4" :placeholder="t('projectRoom.overlay.reasonHint')" />
      </label>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </button>
        <button class="primary-button" type="button" :disabled="busy || !reason.trim()" @click="confirmReopen">
          {{ t('projectRoom.overlay.confirmReopen') }}
        </button>
      </footer>
    </template>

    <template v-else-if="kind === 'delete'">
      <p class="overlay-warning">{{ t('projectRoom.overlay.deleteWarning', { name: overlayName }) }}</p>
      <p class="overlay-description">{{ t('projectRoom.overlay.deleteCannotCancel') }}</p>
      <label class="overlay-check">
        <input v-model="keepChats" type="checkbox" />
        <span>{{ t('projectRoom.overlay.keepChats') }}</span>
      </label>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </button>
        <button class="danger-button" type="button" :disabled="busy" @click="confirmDelete">
          {{ t('projectRoom.overlay.confirmDelete') }}
        </button>
      </footer>
    </template>

    <template v-else-if="kind === 'unlock'">
      <p class="overlay-description">{{ t('projectRoom.overlay.unlockDescription') }}</p>
      <label class="overlay-field">
        <span>{{ t('projectRoom.overlay.folderName') }}</span>
        <input v-model="folderName" type="text" :placeholder="workdirName" />
      </label>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="busy || folderName.trim() !== workdirName"
          @click="confirmUnlock"
        >
          {{ t('projectRoom.overlay.confirmUnlock') }}
        </button>
      </footer>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { errorCode, projectRoomErrorKey } from '../desktop.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  checkpointDefs,
  close,
  deleteProjectRoom,
  onDeleted,
  overlay,
  previewRejectUpstream,
  previewReopenCheckpoint,
  progressItems,
  projectName,
  rejectPreview,
  submitReject,
  submitReopen,
  t,
  unlockProjectDirectory,
  upstreamCheckpoints,
  workdirName,
} = props.controller

const kind = computed(() => String(overlay.value?.kind || ''))
const overlayName = computed(() => String(
  overlay.value?.projectName || projectName.value || '',
))
const projectId = computed(() => String(overlay.value?.projectId || ''))
const checkpointId = computed(() => String(overlay.value?.checkpointId || ''))
const step = ref(1)
const reason = ref('')
const busy = ref(false)
const localError = ref('')
const impactChanged = ref(false)
const keepChats = ref(false)
const folderName = ref('')
const preview = ref(overlay.value?.preview || null)
const progressById = computed(() => new Map(
  (progressItems.value || []).map(item => [item.checkpointId, item]),
))
const impactItems = computed(() => {
  const defs = new Map((checkpointDefs.value || []).map(def => [def.key, def]))
  return (preview.value?.affectedCheckpointIds || []).map((id) => {
    const item = progressById.value.get(id)
    const def = defs.get(item?.checkpointKey)
    return {
      id,
      name: item?.name || id,
      label: item?.label || '',
      hard: def?.gate === 'hard',
      milestone: def?.type === 'milestone',
    }
  })
})

const upstreamIds = computed(() => new Set(
  (upstreamCheckpoints.value || []).map(item => item.checkpointId),
))

function translateError(error) {
  return t(projectRoomErrorKey(errorCode(error)))
}

onMounted(async () => {
  if (kind.value !== 'reopen' || preview.value) return
  busy.value = true
  preview.value = await previewReopenCheckpoint(checkpointId.value)
  busy.value = false
})

async function chooseUpstream(upstreamId) {
  if (!upstreamIds.value.has(upstreamId)) return
  busy.value = true
  localError.value = ''
  const result = await previewRejectUpstream(upstreamId)
  busy.value = false
  if (!result) {
    localError.value = t('projectRoom.overlay.previewFailed')
    return
  }
  preview.value = result
  step.value = 2
}

async function confirmReject() {
  if (!reason.value.trim()) {
    localError.value = t('projectRoom.overlay.reasonRequired')
    return
  }
  busy.value = true
  localError.value = ''
  const result = await submitReject(reason.value, preview.value?.impactHash)
  busy.value = false
  if (result?.ok) {
    close()
    return
  }
  if (result?.impactChanged) {
    impactChanged.value = true
    preview.value = rejectPreview.value
    return
  }
  if (!result?.stale) localError.value = t('projectRoom.overlay.submitFailed')
}

async function confirmReopen() {
  if (!reason.value.trim()) {
    localError.value = t('projectRoom.overlay.reasonRequired')
    return
  }
  busy.value = true
  localError.value = ''
  const result = await submitReopen(checkpointId.value, reason.value, preview.value?.impactHash)
  busy.value = false
  if (result?.ok) {
    close()
    return
  }
  if (result?.impactChanged) {
    impactChanged.value = true
    preview.value = await previewReopenCheckpoint(checkpointId.value)
    return
  }
  localError.value = t('projectRoom.overlay.submitFailed')
}

async function confirmDelete() {
  busy.value = true
  localError.value = ''
  try {
    await deleteProjectRoom(projectId.value, keepChats.value)
    close()
    onDeleted?.()
  } catch (error) {
    localError.value = translateError(error)
  } finally {
    busy.value = false
  }
}

async function confirmUnlock() {
  busy.value = true
  localError.value = ''
  try {
    await unlockProjectDirectory(folderName.value)
    close()
  } catch (error) {
    localError.value = translateError(error)
  } finally {
    busy.value = false
  }
}

function handleEscape() {
  if (kind.value === 'reject' && step.value === 2) {
    step.value = 1
    return
  }
  close()
}
</script>
