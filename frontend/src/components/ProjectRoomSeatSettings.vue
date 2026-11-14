<template>
  <div class="seat-persona-editor" @keydown.esc.stop.prevent="close">
    <template v-if="activeSeat">
      <aside class="seat-persona-rail">
        <div class="seat-persona-portrait">
          <img :src="agentLogo(activeSeat.agentKind)" :alt="agentLabel(activeSeat.agentKind)" />
        </div>
        <strong class="seat-persona-name">{{ activeSeat.roleName || activeSeat.id }}</strong>
        <p class="seat-persona-agent-name">{{ agentLabel(activeSeat.agentKind) }}</p>
        <div class="seat-persona-agent-choices" role="radiogroup" :aria-label="t('projectRoom.setup.seatAgent')">
          <button
            v-for="agent in agentOptions"
            :key="agent.kind"
            type="button"
            role="radio"
            :class="{ active: activeSeat.agentKind === agent.kind }"
            :aria-checked="String(activeSeat.agentKind === agent.kind)"
            :title="agent.label"
            :aria-label="agent.label"
            @click="selectAgent(agent.kind)"
          >
            <img :src="agentLogo(agent.kind)" :alt="agent.label" />
          </button>
        </div>
        <p class="seat-persona-rail-label">{{ t('projectRoom.seats.agentLabel') }}</p>
        <div class="seat-persona-rail-divider" />
        <div class="seat-persona-capability-list">
          <span v-for="capability in activeSeat.capabilities" :key="capability">
            {{ capabilityLabel(capability) }}
          </span>
        </div>
        <div class="seat-persona-rail-actions">
          <button class="seat-persona-add" type="button" :disabled="busy" @click="addSeat">
            <AddOutline aria-hidden="true" />
            {{ t('projectRoom.seats.add') }}
          </button>
          <button
            v-if="seats.length > 1"
            class="seat-persona-remove"
            type="button"
            :disabled="busy || seatReferenced(activeSeat.id)"
            :title="seatReferenced(activeSeat.id) ? t('projectRoom.setup.seatReferenced') : t('projectRoom.seats.remove')"
            @click="removeSeat(activeSeat)"
          >
            <TrashOutline aria-hidden="true" />
            {{ t('projectRoom.seats.remove') }}
          </button>
        </div>
      </aside>

      <section class="seat-persona-form">
        <p class="seat-persona-kicker">PERSONA</p>
        <p class="seat-persona-hint">{{ t('projectRoom.seats.hint') }}</p>
        <p v-if="staleNotice" class="overlay-warning">{{ t('projectRoom.seats.staleReloaded') }}</p>
        <p v-if="errorLabel" class="overlay-error" role="alert">{{ errorLabel }}</p>

        <label class="seat-persona-field">
          <span>{{ t('projectRoom.setup.seatRole') }}</span>
          <input v-model="activeSeat.roleName" class="seat-persona-name-input" type="text" maxlength="40" />
        </label>

        <label class="seat-persona-field">
          <span>{{ t('projectRoom.setup.seatDuty') }}</span>
          <input v-model="activeSeat.duty" type="text" maxlength="200" />
        </label>

        <div class="seat-persona-field-row">
          <label class="seat-persona-field">
            <span>{{ t('projectRoom.setup.seatAgent') }}</span>
            <select v-model="activeSeat.agentKind" @change="ensureCapabilities(activeSeat.agentKind)">
              <option v-for="agent in agentOptions" :key="agent.kind" :value="agent.kind">
                {{ agent.label }}{{ agent.available ? '' : ` (${t('projectRoom.setup.unavailable')})` }}
              </option>
            </select>
          </label>
          <fieldset class="seat-persona-capabilities">
            <legend>{{ t('projectRoom.seats.capabilities') }}</legend>
            <label v-for="capability in capabilityOptions" :key="capability.value">
              <input
                v-model="activeSeat.capabilities"
                type="checkbox"
                :value="capability.value"
                :disabled="!capabilitySupported(activeSeat.agentKind, capability.value)"
              />
              <span>{{ t(capability.labelKey) }}</span>
            </label>
          </fieldset>
        </div>

        <label class="seat-persona-field seat-persona-profile">
          <span>{{ t('projectRoom.setup.profile') }}</span>
          <textarea v-model="activeSeat.profileText" rows="6" maxlength="16384" />
          <small>{{ activeSeat.profileText.length }} / 16384</small>
        </label>

        <details v-if="activeSeat.profileVersions?.length" class="seat-persona-history">
          <summary>{{ t('projectRoom.seats.rollback') }}</summary>
          <select v-model="activeSeat.rollbackProfileId">
            <option value="">{{ t('projectRoom.seats.currentProfile') }}</option>
            <option v-for="profile in activeSeat.profileVersions" :key="profile.id" :value="profile.id">
              v{{ profile.version }} · {{ profileSourceLabel(profile.source) }}
            </option>
          </select>
        </details>

        <p v-if="sameAgentWarning" class="setup-warning">{{ t('projectRoom.seats.sameAgentWarning') }}</p>
        <p v-if="seatWarnings(activeSeat).length" class="setup-warning">
          <span v-for="warning in seatWarnings(activeSeat)" :key="warning">{{ warning }}</span>
        </p>

        <footer class="seat-persona-footer">
          <button
            v-if="activeSeat.rollbackProfileId"
            class="seat-persona-history-apply"
            type="button"
            :disabled="busy"
            @click="rollbackProfile(activeSeat)"
          >
            {{ t('projectRoom.seats.rollbackApply') }}
          </button>
          <span class="seat-persona-footer-spacer" />
          <button class="secondary-button" type="button" :disabled="busy" @click="saveProfile(activeSeat)">
            {{ t('projectRoom.seats.saveProfile') }}
          </button>
          <button class="primary-button" type="button" :disabled="busy" @click="saveSeat(activeSeat)">
            {{ t('projectRoom.seats.saveSeat') }}
          </button>
        </footer>
      </section>
    </template>
    <p v-else class="seat-persona-empty">{{ t('projectRoom.seats.empty') }}</p>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { AddOutline, TrashOutline } from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { errorCode, projectRoomErrorKey } from '../desktop.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  agentOptions,
  api,
  close,
  focusedSeatId,
  projectId,
  projectSnapshot,
  refreshProject,
  t,
} = props.controller

const busy = ref(false)
const seats = ref([])
const selectedSeatId = ref('')
const configRevision = ref(0)
const capabilityCache = reactive({})
const staleNotice = ref(false)
const errorLabel = ref('')
const capabilityOptions = [
  { value: 'read', labelKey: 'projectRoom.setup.capability.read' },
  { value: 'read-exec', labelKey: 'projectRoom.setup.capability.readExec' },
  { value: 'write-drafts', labelKey: 'projectRoom.setup.capability.writeDrafts' },
  { value: 'write-workdir', labelKey: 'projectRoom.setup.capability.writeWorkdir' },
]

const activeSeat = computed(() => (
  seats.value.find(seat => seat.id === selectedSeatId.value) || seats.value[0] || null
))

function loadSeats() {
  const config = projectSnapshot.value?.config
  if (!config) return
  configRevision.value = config.configRevision
  seats.value = config.seats.map(seat => ({
    ...seat,
    capabilities: [...seat.capabilities],
    profileText: seat.profile?.text || '',
    profileVersionId: seat.profile?.id || seat.profileVersionId,
    profileVersions: [...(seat.profileVersions || [])],
    rollbackProfileId: '',
  }))
  const preferred = String(focusedSeatId?.value || '')
  if (!seats.value.some(seat => seat.id === selectedSeatId.value)) {
    selectedSeatId.value = seats.value.some(seat => seat.id === preferred)
      ? preferred
      : (seats.value[0]?.id || '')
  }
  for (const seat of seats.value) ensureCapabilities(seat.agentKind)
}

onMounted(loadSeats)
watch(() => projectSnapshot.value?.config?.configRevision, (value, previous) => {
  if (value !== previous) loadSeats()
})
watch(() => focusedSeatId?.value, (seatId) => {
  const id = String(seatId || '')
  if (id && seats.value.some(seat => seat.id === id)) selectedSeatId.value = id
})

const sameAgentWarning = computed(() => {
  const defs = projectSnapshot.value?.config?.playbook?.checkpointDefs || []
  return defs.some((def) => {
    const lead = seats.value.find(seat => seat.id === def.leadSeatId)
    const reviewer = seats.value.find(seat => (def.reviewerSeatIds || []).includes(seat.id))
    return lead && reviewer && lead.agentKind === reviewer.agentKind
  })
})

function capabilityLabel(capability) {
  const option = capabilityOptions.find(item => item.value === capability)
  return option ? t(option.labelKey) : capability
}

function selectAgent(kind) {
  if (!activeSeat.value) return
  activeSeat.value.agentKind = kind
  ensureCapabilities(kind)
}

function seatReferenced(seatId) {
  const defs = projectSnapshot.value?.config?.playbook?.checkpointDefs || []
  return defs.some(def => (
    def.leadSeatId === seatId
    || (def.reviewerSeatIds || []).includes(seatId)
    || (def.draftSeatIds || []).includes(seatId)
  ))
}

async function ensureCapabilities(kind) {
  if (!kind || capabilityCache[kind]) return
  try {
    capabilityCache[kind] = (await api.capabilities({ agentKind: kind }))?.capabilities || {}
  } catch {
    capabilityCache[kind] = {}
  }
  for (const seat of seats.value) {
    if (seat.agentKind !== kind) continue
    seat.capabilities = seat.capabilities.filter(capability => (
      capabilitySupported(kind, capability)
    ))
  }
}

const PROFILE_SOURCE_KEYS = {
  default: 'projectRoom.seats.profileSource.default',
  'user-edit': 'projectRoom.seats.profileSource.user-edit',
  'retro-adopted': 'projectRoom.seats.profileSource.retro-adopted',
  rollback: 'projectRoom.seats.profileSource.rollback',
}

function profileSourceLabel(source) {
  const key = PROFILE_SOURCE_KEYS[source]
  return key ? t(key) : String(source || '')
}

function capabilitySupported(kind, capability) {
  const capabilities = capabilityCache[kind] || {}
  if (capability === 'read') return true
  if (capability === 'read-exec') return capabilities.readExec === true
  return capabilities.managedProcess === true
}

function seatWarnings(seat) {
  const warnings = []
  const capabilities = capabilityCache[seat.agentKind] || {}
  const agent = agentOptions.value.find(item => item.kind === seat.agentKind)
  if (agent && !agent.available) warnings.push(t('projectRoom.setup.warningUnavailable', { agent: agent.label }))
  if (seat.capabilities.some(item => item === 'read-exec') && capabilities.readExec !== true) {
    warnings.push(t('projectRoom.setup.warningReadExec'))
  }
  if (seat.capabilities.some(item => item.startsWith('write')) && capabilities.managedProcess !== true) {
    warnings.push(t('projectRoom.setup.warningManagedProcess'))
  }
  if (seat.capabilities.some(item => item.startsWith('write')) && capabilities.fullTrace !== true) {
    warnings.push(t('projectRoom.setup.warningFullTrace'))
  }
  if (seat.capabilities.some(item => item.startsWith('write'))
      && capabilities.writeSessionContinuity !== true) {
    warnings.push(t('projectRoom.setup.warningSession'))
  }
  return warnings
}

function handleError(error) {
  if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
    staleNotice.value = true
    errorLabel.value = ''
    return
  }
  errorLabel.value = t(projectRoomErrorKey(errorCode(error)))
}

async function saveSeat(seat) {
  busy.value = true
  errorLabel.value = ''
  try {
    await api.updateSeat({
      projectId: projectId.value,
      seat: {
        id: seat.id,
        roleName: seat.roleName,
        duty: seat.duty,
        agentKind: seat.agentKind,
        capabilities: [...seat.capabilities],
        checkpointRoles: seat.checkpointRoles || [],
        profileVersionId: seat.profileVersionId,
      },
      configRevision: configRevision.value,
    })
    await refreshProject()
    loadSeats()
  } catch (error) {
    handleError(error)
    if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
      await refreshProject()
      loadSeats()
    }
  } finally {
    busy.value = false
  }
}

async function saveProfile(seat) {
  busy.value = true
  errorLabel.value = ''
  try {
    await api.updateProfile({
      projectId: projectId.value,
      seatId: seat.id,
      text: seat.profileText,
      configRevision: configRevision.value,
    })
    await refreshProject()
    loadSeats()
  } catch (error) {
    handleError(error)
    if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
      await refreshProject()
      loadSeats()
    }
  } finally {
    busy.value = false
  }
}

async function rollbackProfile(seat) {
  if (!seat.rollbackProfileId) return
  busy.value = true
  errorLabel.value = ''
  try {
    await api.rollbackProfile({
      projectId: projectId.value,
      seatId: seat.id,
      profileId: seat.rollbackProfileId,
      configRevision: configRevision.value,
    })
    await refreshProject()
    loadSeats()
  } catch (error) {
    handleError(error)
    if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
      await refreshProject()
      loadSeats()
    }
  } finally {
    busy.value = false
  }
}

async function addSeat() {
  busy.value = true
  errorLabel.value = ''
  let index = 1
  while (seats.value.some(seat => seat.id === `seat-${index}`)) index += 1
  const id = `seat-${index}`
  try {
    await api.addSeat({
      projectId: projectId.value,
      seat: {
        id,
        roleName: t('projectRoom.setup.newSeat'),
        duty: '',
        agentKind: agentOptions.value[0]?.kind || '',
        capabilities: ['read'],
        checkpointRoles: [],
        profileVersionId: id,
        profileText: '',
      },
      configRevision: configRevision.value,
    })
    await refreshProject()
    selectedSeatId.value = id
    loadSeats()
  } catch (error) {
    handleError(error)
    if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
      await refreshProject()
      loadSeats()
    }
  } finally {
    busy.value = false
  }
}

async function removeSeat(seat) {
  busy.value = true
  errorLabel.value = ''
  try {
    await api.removeSeat({
      projectId: projectId.value,
      seatId: seat.id,
      configRevision: configRevision.value,
    })
    await refreshProject()
    selectedSeatId.value = ''
    loadSeats()
  } catch (error) {
    handleError(error)
    if (errorCode(error) === 'PROJECT_CONFIG_STALE') {
      await refreshProject()
      loadSeats()
    }
  } finally {
    busy.value = false
  }
}
</script>
