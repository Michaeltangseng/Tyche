<template>
  <div class="project-room-seat-settings" @keydown.esc.stop.prevent="close">
    <p class="overlay-description">{{ t('projectRoom.seats.hint') }}</p>
    <p v-if="staleNotice" class="overlay-warning">{{ t('projectRoom.seats.staleReloaded') }}</p>
    <p v-if="errorLabel" class="overlay-error" role="alert">{{ errorLabel }}</p>
    <p v-if="sameAgentWarning" class="overlay-warning">{{ t('projectRoom.seats.sameAgentWarning') }}</p>

    <article v-for="seat in seats" :key="seat.id" class="setup-seat">
      <header>
        <strong>{{ seat.roleName || seat.id }}</strong>
        <button
          class="gate-link"
          type="button"
          :disabled="busy || seats.length <= 1"
          @click="removeSeat(seat)"
        >
          {{ t('projectRoom.seats.remove') }}
        </button>
      </header>
      <label class="overlay-field">
        <span>{{ t('projectRoom.setup.seatRole') }}</span>
        <input v-model="seat.roleName" type="text" maxlength="40" />
      </label>
      <label class="overlay-field">
        <span>{{ t('projectRoom.setup.seatDuty') }}</span>
        <input v-model="seat.duty" type="text" maxlength="200" />
      </label>
      <label class="overlay-field">
        <span>{{ t('projectRoom.setup.seatAgent') }}</span>
        <select v-model="seat.agentKind" @change="ensureCapabilities(seat.agentKind)">
          <option v-for="agent in agentOptions" :key="agent.kind" :value="agent.kind">
            {{ agent.label }}{{ agent.available ? '' : ` (${t('projectRoom.setup.unavailable')})` }}
          </option>
        </select>
      </label>
      <div class="setup-capabilities">
        <label v-for="capability in capabilityOptions" :key="capability.value">
          <input
            v-model="seat.capabilities"
            type="checkbox"
            :value="capability.value"
            :disabled="!capabilitySupported(seat.agentKind, capability.value)"
          />
          <span>{{ t(capability.labelKey) }}</span>
        </label>
      </div>
      <label class="overlay-field">
        <span>{{ t('projectRoom.setup.profile') }}</span>
        <textarea v-model="seat.profileText" rows="3" maxlength="16384" />
      </label>
      <label v-if="seat.profileVersions?.length" class="overlay-field">
        <span>{{ t('projectRoom.seats.rollback') }}</span>
        <select v-model="seat.rollbackProfileId">
          <option value="">{{ t('projectRoom.seats.currentProfile') }}</option>
          <option v-for="profile in seat.profileVersions" :key="profile.id" :value="profile.id">
            v{{ profile.version }} · {{ profile.source }}
          </option>
        </select>
      </label>
      <p v-if="seatWarnings(seat).length" class="setup-warning">
        <span v-for="warning in seatWarnings(seat)" :key="warning">{{ warning }}</span>
      </p>
      <footer class="overlay-actions">
        <button
          v-if="seat.rollbackProfileId"
          class="secondary-button"
          type="button"
          :disabled="busy"
          @click="rollbackProfile(seat)"
        >
          {{ t('projectRoom.seats.rollbackApply') }}
        </button>
        <button class="secondary-button" type="button" :disabled="busy" @click="saveProfile(seat)">
          {{ t('projectRoom.seats.saveProfile') }}
        </button>
        <button class="primary-button" type="button" :disabled="busy" @click="saveSeat(seat)">
          {{ t('projectRoom.seats.saveSeat') }}
        </button>
      </footer>
    </article>

    <button class="secondary-button" type="button" :disabled="busy" @click="addSeat">
      {{ t('projectRoom.setup.addSeat') }}
    </button>
    <footer class="overlay-actions">
      <button class="secondary-button" type="button" :disabled="busy" @click="close">
        {{ t('common.close') }}
      </button>
    </footer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { errorCode, projectRoomErrorKey } from '../desktop.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  agentOptions,
  api,
  close,
  projectId,
  projectSnapshot,
  refreshProject,
  t,
} = props.controller

const busy = ref(false)
const seats = ref([])
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
  for (const seat of seats.value) ensureCapabilities(seat.agentKind)
}

onMounted(loadSeats)
watch(() => projectSnapshot.value?.config?.configRevision, (value, previous) => {
  if (value !== previous) loadSeats()
})

const sameAgentWarning = computed(() => {
  const defs = projectSnapshot.value?.config?.playbook?.checkpointDefs || []
  return defs.some((def) => {
    const lead = seats.value.find(seat => seat.id === def.leadSeatId)
    const reviewer = seats.value.find(seat => (def.reviewerSeatIds || []).includes(seat.id))
    return lead && reviewer && lead.agentKind === reviewer.agentKind
  })
})

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
