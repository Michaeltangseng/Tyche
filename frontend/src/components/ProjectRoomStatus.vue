<template>
  <section v-if="hasContent" class="project-room-status" :aria-label="t('projectRoom.status.title')">
    <div v-if="errorBar" class="status-error" role="alert">
      <span class="status-error-text">
        {{ errorLabel }}
        <small v-if="errorScopeLabel">· {{ errorScopeLabel }}</small>
      </span>
      <button v-if="errorBar.retryable" class="status-action" type="button" :disabled="busy" @click="retry">
        {{ t('projectRoom.status.retry') }}
      </button>
      <button class="status-action" type="button" :disabled="busy" @click="showDiagnostics">
        {{ t('projectRoom.status.diagnostics') }}
      </button>
      <button class="status-action" type="button" :disabled="busy" @click="compact">
        {{ t('projectRoom.status.compact') }}
      </button>
    </div>
    <pre v-if="diagnosticsOpen && diagnostics" class="status-diagnostics">{{ diagnosticsText }}</pre>
    <p v-if="statusErrorLabel" class="status-inline-error" role="alert">{{ statusErrorLabel }}</p>

    <section v-if="driftItems.length" class="status-section">
      <header class="status-heading">
        <h3>{{ t('projectRoom.status.driftTitle') }}</h3>
        <span>{{ t('projectRoom.status.driftHint') }}</span>
      </header>
      <div class="status-list">
        <div v-for="item in driftItems" :key="item.id" class="status-row">
          <input
            v-model="selectedDriftIds"
            type="checkbox"
            :value="item.id"
            :aria-label="item.path"
            :disabled="item.status === 'resolving' || isAccepting(item)"
          />
          <span class="status-row-main">
            <strong>{{ item.path }}</strong>
            <small>
              {{ item.checkpointName }} · {{ formatNavTime(item.foundAt) }}
              <template v-if="item.placeholder">
                · {{ t(`projectRoom.status.placeholder.${item.placeholder}`) }}
              </template>
            </small>
          </span>
          <span class="status-row-state">
            <template v-if="item.status === 'resolving'">
              {{ t(isResolvePaused(item) ? 'projectRoom.status.resolvePaused' : 'projectRoom.status.waitingWrite') }}
            </template>
            <template v-else-if="isAccepting(item)">{{ t('projectRoom.status.waitingAccept') }}</template>
            <button class="status-link" type="button" @click="openDriftDiff(item)">
              {{ t('projectRoom.status.viewDiff') }}
            </button>
            <button
              v-if="item.status === 'resolving'"
              class="status-link"
              type="button"
              :disabled="busy"
              @click="cancelResolution(item)"
            >
              {{ t('projectRoom.status.cancelResolution') }}
            </button>
          </span>
        </div>
      </div>
      <div class="status-actions">
        <button
          class="status-action"
          type="button"
          :disabled="busy || !selectedDriftIds.length || selectedDriftItems.some(item => !item.restorable || item.status === 'resolving' || isAccepting(item))"
          :title="restoreDisabledReason"
          @click="resolveSelected('accepted')"
        >
          {{ t('projectRoom.status.restoreAccepted') }}
        </button>
        <button
          class="status-action primary"
          type="button"
          :disabled="busy || !selectedDriftIds.length || selectedDriftItems.some(item => item.status === 'resolving' || isAccepting(item))"
          @click="resolveSelected('workdir')"
        >
          {{ t('projectRoom.status.useWorkdir') }}
        </button>
      </div>
    </section>

    <section v-if="outOfScopeItems.length" class="status-section">
      <header class="status-heading">
        <h3>{{ t('projectRoom.status.outOfScopeTitle') }}</h3>
        <span>{{ t('projectRoom.status.outOfScopeHint') }}</span>
      </header>
      <div class="status-list">
        <div v-for="item in outOfScopeItems" :key="item.id" class="status-row">
          <span class="status-row-main">
            <strong>{{ item.path }}</strong>
            <small>{{ attributionLabel(item) }} · {{ formatNavTime(item.detectedAt) }}</small>
          </span>
          <button class="status-action" type="button" :disabled="busy" @click="resolveOutOfScope(item)">
            {{ t('projectRoom.status.resolveOutOfScope') }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="residuals.length" class="status-section">
      <header class="status-heading">
        <h3>{{ t('projectRoom.status.residualTitle') }}</h3>
        <span>{{ t('projectRoom.status.residualHint') }}</span>
      </header>
      <div class="status-list">
        <div v-for="item in residuals" :key="item.residualId" class="status-row">
          <span class="status-row-main">
            <strong>{{ item.programName || item.residualId }}</strong>
            <small>
              PID {{ item.pid ?? '?' }}
              <template v-if="item.agentKind"> · {{ item.agentKind }}</template>
              <template v-if="item.startedAt"> · {{ formatNavTime(item.startedAt) }}</template>
              <template v-if="item.containerMarked"> · {{ t('projectRoom.status.containerMarked') }}</template>
            </small>
          </span>
          <span class="status-row-state">
            <button class="status-action" type="button" :disabled="busy" @click="handleResidual(item, 'manuallyEnded')">
              {{ t('projectRoom.status.residualEnded') }}
            </button>
            <button class="status-action" type="button" :disabled="busy" @click="handleResidual(item, 'notRelated')">
              {{ t('projectRoom.status.residualNotRelated') }}
            </button>
          </span>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  cancelDriftResolution,
  compactProject,
  diagnostics,
  driftItems,
  errorBar,
  formatNavTime,
  loadDiagnostics,
  openDriftDiff,
  outOfScopeItems,
  progressItems,
  resolveDriftItems,
  resolveOutOfScopeItems,
  resolveResidual,
  residuals,
  retryProjectError,
  statusErrorKey,
  t,
} = props.controller

const busy = ref(false)
const diagnosticsOpen = ref(false)
const selectedDriftIds = ref([])
const progressById = computed(() => new Map(
  (progressItems.value || []).map(item => [item.checkpointId, item]),
))
const selectedDriftItems = computed(() => driftItems.value
  .filter(item => selectedDriftIds.value.includes(item.id)))
const hasContent = computed(() => Boolean(
  errorBar.value
    || driftItems.value.length
    || outOfScopeItems.value.length
    || residuals.value.length,
))
const statusErrorLabel = computed(() => (statusErrorKey.value ? t(statusErrorKey.value) : ''))
const diagnosticsText = computed(() => diagnostics.value ? JSON.stringify(diagnostics.value, null, 2) : '')
const errorLabel = computed(() => {
  const code = String(errorBar.value?.error || '')
  if (!code) return t('projectRoom.status.error.generic')
  const key = `errors.${code}`
  const translated = t(key)
  return translated === key ? t('projectRoom.status.error.generic') : translated
})
const errorScopeLabel = computed(() => {
  if (!errorBar.value) return ''
  if (errorBar.value.checkpointId) {
    const item = progressById.value.get(errorBar.value.checkpointId)
    return item?.name || errorBar.value.checkpointId
  }
  return t('projectRoom.status.projectScope')
})
const restoreDisabledReason = computed(() => (
  selectedDriftItems.value.some(item => !item.restorable)
    ? t('projectRoom.status.placeholderRestoreUnavailable')
    : ''
))

function isAccepting(item) {
  return progressById.value.get(item.checkpointId)?.state === 'accepting'
}

function isResolvePaused(item) {
  return errorBar.value?.scope === 'instance'
    && errorBar.value?.checkpointId === item.checkpointId
}

function attributionLabel(item) {
  return t(`projectRoom.status.attribution.${item.attribution || 'uncertain'}`)
}

async function resolveSelected(choice) {
  busy.value = true
  await resolveDriftItems(selectedDriftIds.value, choice)
  selectedDriftIds.value = []
  busy.value = false
}

async function cancelResolution(item) {
  busy.value = true
  await cancelDriftResolution(item.id)
  busy.value = false
}

async function resolveOutOfScope(item) {
  busy.value = true
  await resolveOutOfScopeItems([item.id])
  busy.value = false
}

async function handleResidual(item, action) {
  busy.value = true
  await resolveResidual(item.residualId, action)
  busy.value = false
}

async function retry() {
  busy.value = true
  await retryProjectError()
  busy.value = false
}

async function compact() {
  busy.value = true
  await compactProject()
  busy.value = false
}

async function showDiagnostics() {
  if (!diagnostics.value) {
    const result = await loadDiagnostics()
    if (result) diagnostics.value = result
  }
  diagnosticsOpen.value = !diagnosticsOpen.value
}
</script>
