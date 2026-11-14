<template>
  <div class="project-room-create-dialog" @keydown.esc.stop.prevent="close">
    <ol class="setup-steps" aria-label="steps">
      <li :class="{ active: step === 1, done: step > 1 }">{{ t('projectRoom.setup.workdirStep') }}</li>
      <li :class="{ active: step === 2, done: step > 2 }">{{ t('projectRoom.setup.playbookStep') }}</li>
      <li :class="{ active: step === 3 }">{{ t('projectRoom.setup.seatsStep') }}</li>
    </ol>

    <section v-if="step === 1" class="setup-section">
      <p class="overlay-description">{{ t('projectRoom.setup.workdirHint') }}</p>
      <button class="primary-button" type="button" :disabled="busy" @click="chooseWorkdir">
        {{ t('projectRoom.setup.chooseWorkdir') }}
      </button>
      <p v-if="workdirName" class="setup-selected">
        {{ t('projectRoom.setup.selected', { name: workdirName }) }}
      </p>
      <label v-if="workdirToken" class="overlay-field">
        <span>{{ t('projectRoom.setup.name') }}</span>
        <input v-model="projectName" type="text" maxlength="80" />
      </label>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="busy || !workdirToken"
          @click="step = 2"
        >
          {{ t('projectRoom.setup.next') }}
        </button>
      </footer>
    </section>

    <section v-else-if="step === 2" class="setup-section">
      <p class="overlay-description">{{ t('projectRoom.setup.playbookHint') }}</p>
      <div class="setup-template-list">
        <label
          v-for="template in templates"
          :key="`${template.id}:${template.version}`"
          class="setup-template-row"
          :class="{ active: templateId === template.id }"
        >
          <input
            v-model="templateId"
            type="radio"
            :value="template.id"
            @change="resetPlaybookOverrides(selectedTemplate)"
          />
          <span>
            <strong>{{ templateLabel(template) }}</strong>
            <small>
              {{ t('projectRoom.setup.checkpointCount', { count: template.checkpointDefs.length }) }}
              <template v-if="isBuiltinTemplate(template)"> · {{ t('projectRoom.setup.builtinHint') }}</template>
            </small>
          </span>
        </label>
      </div>
      <div v-if="selectedTemplate" class="setup-playbook">
        <div v-for="def in selectedTemplate.checkpointDefs" :key="def.key" class="setup-checkpoint">
          <strong>{{ checkpointLabel(def) }}</strong>
          <label>
            {{ t('projectRoom.setup.gate') }}
            <select v-model="gateOverrides[def.key]">
              <option value="hard">{{ t('projectRoom.setup.gateHard') }}</option>
              <option value="soft">{{ t('projectRoom.setup.gateSoft') }}</option>
            </select>
          </label>
          <label>
            {{ t('projectRoom.setup.roundLimit') }}
            <input v-model.number="roundOverrides[def.key]" type="number" min="1" max="100" />
          </label>
        </div>
      </div>
      <div class="setup-hints">
        <p>{{ t('projectRoom.setup.gateHint') }}</p>
        <p>{{ t('projectRoom.setup.roundLimitHint') }}</p>
      </div>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="step = 1">
          {{ t('projectRoom.setup.back') }}
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="busy || !selectedTemplate"
          @click="goToSeats"
        >
          {{ t('projectRoom.setup.next') }}
        </button>
      </footer>
    </section>

    <section v-else class="setup-section">
      <p class="overlay-description">{{ t('projectRoom.setup.seatsHint') }}</p>
      <div class="setup-agent-picker">
        <p class="setup-picker-label">{{ t('projectRoom.setup.agentsLabel') }}</p>
        <div class="setup-agent-row">
          <button
            v-for="agent in agentOptions"
            :key="agent.kind"
            class="setup-agent-tile"
            :class="{ unavailable: !agent.available }"
            type="button"
            :disabled="busy || !agent.available"
            :title="agent.available
              ? t('projectRoom.setup.addAgentSeat', { agent: agent.label })
              : t('projectRoom.setup.warningUnavailable', { agent: agent.label })"
            @click="addSeatFor(agent.kind)"
          >
            <span class="setup-agent-avatar">
              <img :src="agentLogo(agent.kind)" :alt="agent.label" />
              <AddOutline class="setup-agent-add" aria-hidden="true" />
            </span>
            <small>{{ agent.label }}</small>
          </button>
        </div>
      </div>

      <div v-if="seats.length" class="setup-seat-picker">
        <p class="setup-picker-label">{{ t('projectRoom.setup.seatChipsLabel') }}</p>
        <div class="setup-seat-row">
          <button
            v-for="seat in seats"
            :key="seat.id"
            class="setup-seat-chip"
            :class="{ active: selectedSeat?.id === seat.id }"
            type="button"
            :title="t('projectRoom.setup.selectSeat', { seat: seat.roleName || seat.id })"
            @click="selectedSeatId = seat.id"
          >
            <span class="setup-seat-chip-avatar">{{ (seat.roleName || seat.id).slice(0, 1) }}</span>
            <span class="setup-seat-chip-copy">
              <strong>{{ seat.roleName || seat.id }}</strong>
              <small>{{ agentLabel(seat.agentKind) }}</small>
            </span>
          </button>
        </div>
      </div>

      <article v-if="selectedSeat" class="setup-seat setup-seat-detail">
        <header>
          <strong>{{ selectedSeat.roleName || selectedSeat.id }}</strong>
          <button
            class="gate-link"
            type="button"
            :disabled="seatReferenced(selectedSeat.id) || seats.length <= 1"
            :title="seatReferenced(selectedSeat.id) ? t('projectRoom.setup.seatReferenced') : ''"
            @click="removeSeat(seats.indexOf(selectedSeat))"
          >
            {{ t('projectRoom.setup.removeSeat') }}
          </button>
        </header>
        <label class="overlay-field">
          <span>{{ t('projectRoom.setup.seatRole') }}</span>
          <input v-model="selectedSeat.roleName" type="text" maxlength="40" />
        </label>
        <label class="overlay-field">
          <span>{{ t('projectRoom.setup.seatDuty') }}</span>
          <input v-model="selectedSeat.duty" type="text" maxlength="200" />
        </label>
        <label class="overlay-field">
          <span>{{ t('projectRoom.setup.seatAgent') }}</span>
          <select v-model="selectedSeat.agentKind" @change="ensureCapabilities(selectedSeat.agentKind)">
            <option v-for="agent in agentOptions" :key="agent.kind" :value="agent.kind">
              {{ agent.label }}{{ agent.available ? '' : ` (${t('projectRoom.setup.unavailable')})` }}
            </option>
          </select>
        </label>
        <div class="setup-capabilities">
          <label v-for="capability in capabilityOptions" :key="capability.value">
            <input
              v-model="selectedSeat.capabilities"
              type="checkbox"
              :value="capability.value"
              :disabled="!capabilitySupported(selectedSeat.agentKind, capability.value)"
            />
            <span>{{ t(capability.labelKey) }}</span>
          </label>
        </div>
        <label class="overlay-field">
          <span>{{ t('projectRoom.setup.profile') }}</span>
          <textarea v-model="selectedSeat.profileText" rows="3" maxlength="16384" />
        </label>
        <p v-if="seatWarnings(selectedSeat).length" class="setup-warning">
          <span v-for="warning in seatWarnings(selectedSeat)" :key="warning">{{ warning }}</span>
        </p>
      </article>
      <p v-if="sameAgentWarning" class="setup-warning">
        {{ t('projectRoom.setup.warningSameAgent') }}
      </p>
      <p v-if="validationError" class="overlay-error" role="alert">{{ validationError }}</p>
      <p v-if="localError" class="overlay-error" role="alert">{{ localError }}</p>
      <footer class="overlay-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="step = 2">
          {{ t('projectRoom.setup.back') }}
        </button>
        <button class="primary-button" type="button" :disabled="busy || Boolean(validationError)" @click="createProject">
          {{ t('projectRoom.setup.create') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { AddOutline } from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { errorCode, projectRoomErrorKey } from '../desktop.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  agentOptions,
  api,
  close,
  onCreated,
  onOpenExisting,
  t,
} = props.controller

const step = ref(1)
const busy = ref(false)
const localError = ref('')
const workdirToken = ref('')
const workdirName = ref('')
const projectName = ref('')
const templates = ref([])
const templateId = ref('builtin-default')
const gateOverrides = reactive({})
const roundOverrides = reactive({})
const seats = reactive([])
const selectedSeatId = ref('')
const capabilityCache = reactive({})
const capabilityOptions = [
  { value: 'read', labelKey: 'projectRoom.setup.capability.read' },
  { value: 'read-exec', labelKey: 'projectRoom.setup.capability.readExec' },
  { value: 'write-drafts', labelKey: 'projectRoom.setup.capability.writeDrafts' },
  { value: 'write-workdir', labelKey: 'projectRoom.setup.capability.writeWorkdir' },
]

const selectedTemplate = computed(() => (
  templates.value.find(template => template.id === templateId.value) || null
))
const selectedSeat = computed(() => (
  seats.find(seat => seat.id === selectedSeatId.value) || seats[0] || null
))

function isBuiltinTemplate(template) {
  return template?.id === 'builtin-default'
}

function templateLabel(template) {
  return isBuiltinTemplate(template) ? t('projectRoom.setup.builtinName') : template?.name || ''
}

function checkpointLabel(def) {
  const key = `projectRoom.setup.builtinCheckpoint.${def?.key || ''}`
  if (isBuiltinTemplate(selectedTemplate.value)) {
    const translated = t(key)
    if (translated !== key) return translated
  }
  return def?.name || def?.key || ''
}

function agentLabel(kind) {
  return agentOptions.value.find(agent => agent.kind === kind)?.label || kind || ''
}

onMounted(async () => {
  try {
    const result = await api.templates()
    templates.value = result?.templates || []
    const first = templates.value[0]
    if (first) templateId.value = first.id
    resetPlaybookOverrides(first)
  } catch (error) {
    localError.value = t(projectRoomErrorKey(errorCode(error)))
  }
})

function resetPlaybookOverrides(template) {
  for (const key of Object.keys(gateOverrides)) delete gateOverrides[key]
  for (const key of Object.keys(roundOverrides)) delete roundOverrides[key]
  for (const def of template?.checkpointDefs || []) {
    gateOverrides[def.key] = def.gate
    roundOverrides[def.key] = def.roundLimit || 3
  }
}

async function chooseWorkdir() {
  busy.value = true
  localError.value = ''
  try {
    const result = await api.chooseWorkdir()
    if (result?.cancelled) return
    if (result?.existingProjectId) {
      onOpenExisting(result.existingProjectId)
      close()
      return
    }
    workdirToken.value = String(result?.token || '')
    workdirName.value = String(result?.displayName || '')
    projectName.value = workdirName.value
  } catch (error) {
    localError.value = t(projectRoomErrorKey(errorCode(error)))
  } finally {
    busy.value = false
  }
}

function goToSeats() {
  resetPlaybookOverrides(selectedTemplate.value)
  seats.splice(0, seats.length)
  for (const seat of selectedTemplate.value?.seatTemplates || []) {
    seats.push({
      id: seat.key,
      roleName: seat.roleName,
      duty: seat.duty,
      agentKind: seat.agentKind || agentOptions.value[0]?.kind || '',
      capabilities: [...(seat.capabilities || [])],
      profileText: seat.profileText || '',
    })
  }
  for (const seat of seats) ensureCapabilities(seat.agentKind)
  selectedSeatId.value = seats[0]?.id || ''
  step.value = 3
}

function addSeatFor(kind) {
  const agentKind = kind || agentOptions.value[0]?.kind || ''
  if (!agentKind) return
  let index = 1
  while (seats.some(seat => seat.id === `seat-${index}`)) index += 1
  const id = `seat-${index}`
  seats.push({
    id,
    roleName: t('projectRoom.setup.newSeat'),
    duty: '',
    agentKind,
    capabilities: ['read'],
    profileText: '',
  })
  selectedSeatId.value = id
  ensureCapabilities(agentKind)
}

function removeSeat(index) {
  if (index < 0 || seats.length <= 1 || seatReferenced(seats[index].id)) return
  seats.splice(index, 1)
  if (!seats.some(seat => seat.id === selectedSeatId.value)) {
    selectedSeatId.value = seats[0]?.id || ''
  }
}

function seatReferenced(seatId) {
  return (selectedTemplate.value?.checkpointDefs || []).some(def => (
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
  for (const seat of seats) {
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
  if (seat.capabilities.some(item => item.startsWith('write'))) {
    warnings.push(t('projectRoom.setup.warningProcessCleanup'))
  }
  return warnings
}

const sameAgentWarning = computed(() => {
  const defs = selectedTemplate.value?.checkpointDefs || []
  for (const def of defs) {
    const lead = seats.find(seat => seat.id === def.leadSeatId)
    const reviewer = seats.find(seat => (def.reviewerSeatIds || []).includes(seat.id))
    if (lead && reviewer && lead.agentKind === reviewer.agentKind) return true
  }
  return false
})

const validationError = computed(() => {
  if (!seats.length) return t('projectRoom.setup.errorNoSeats')
  for (const def of selectedTemplate.value?.checkpointDefs || []) {
    const referenced = [
      def.leadSeatId, ...(def.reviewerSeatIds || []), ...(def.draftSeatIds || []),
    ].filter(Boolean)
    for (const seatId of referenced) {
      if (!seats.some(seat => seat.id === seatId)) {
        return t('projectRoom.setup.errorSeatMissing', { seat: seatId })
      }
    }
  }
  return ''
})

async function createProject() {
  busy.value = true
  localError.value = ''
  try {
    const playbookOverrides = {
      gates: { ...gateOverrides },
      checkpointDefs: (selectedTemplate.value?.checkpointDefs || []).map(def => ({
        key: def.key,
        gate: gateOverrides[def.key],
        roundLimit: Number(roundOverrides[def.key]) || def.roundLimit || 3,
      })),
    }
    const created = await api.create({
      token: workdirToken.value,
      name: projectName.value,
      templateId: selectedTemplate.value?.id,
      templateVersion: selectedTemplate.value?.version,
      seats: seats.map(seat => ({
        id: seat.id,
        roleName: seat.roleName,
        duty: seat.duty,
        agentKind: seat.agentKind,
        capabilities: [...seat.capabilities],
        checkpointRoles: [],
        profileVersionId: seat.id,
        profileText: seat.profileText,
      })),
      playbookOverrides,
    })
    await onCreated(created?.projectId)
    close()
  } catch (error) {
    localError.value = t(projectRoomErrorKey(errorCode(error)))
  } finally {
    busy.value = false
  }
}
</script>
