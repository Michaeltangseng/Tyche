<template>
  <div class="skills-page">
    <header class="settings-page-title">
      <div>
        <h1>{{ t('systemSettings.skills') }}</h1>
        <p>{{ t('settingsUi.skillsLead') }}</p>
      </div>
      <div class="settings-actions">
        <button class="secondary-button" type="button" disabled :title="t('settingsUi.marketLater')">{{ t('settingsUi.browseMarket') }}</button>
        <button class="secondary-button" type="button" :disabled="busy || !api" @click="importOpen = true">{{ t('settingsUi.importAgents') }}</button>
        <button class="primary-button" type="button" :disabled="busy || !api" @click="editorOpen = true">+ {{ t('settingsUi.newSkill') }}</button>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="skill-banner-close" :aria-label="t('common.cancel')" @click="error = ''">×</button>
    </p>
    <p v-if="inventory.storeError" class="settings-note">{{ t('settingsUi.storeError') }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>

    <div v-else class="settings-split">
      <div class="settings-card skills-matrix-card">
        <div class="settings-actions mock-filters">
          <input v-model="query" type="search" :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
          <button
            v-for="item in filters"
            :key="item.id"
            class="chip"
            :class="{ active: filter === item.id, warn: item.id === 'reauth' && item.count > 0 }"
            type="button"
            @click="filter = item.id"
          >{{ t(item.labelKey, { count: item.count }) }}</button>
        </div>

        <p v-if="loading" class="settings-note">{{ t('common.loading') }}</p>
        <p v-else-if="!visible.length" class="settings-note">{{ t('settingsUi.skillsEmpty') }}</p>
        <div v-else class="skills-table-wrap">
          <table class="settings-mini-table skills-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th v-for="agent in matrixAgents" :key="agent" class="skills-agent-head">{{ agentLabel(agent) }}</th>
                <th>{{ t('settingsUi.trust') }}</th>
                <th>{{ t('settingsUi.updated') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="skill in visible"
                :key="skill.id"
                :class="{ picked: selectedId === skill.id }"
                @click="select(skill.id)"
              >
                <td class="skills-name-cell">
                  <span class="skills-name-line">
                    <strong>{{ skill.name }}</strong>
                    <span v-if="skill.conflict" class="skills-conflict-badge" :title="t('settingsUi.conflictHint')">{{ t('settingsUi.trustState.conflict') }}</span>
                  </span>
                  <small>
                    <span class="skills-source" :class="skill.source">{{ sourceText(skill) }}</span>
                    <template v-if="skill.version"> · v{{ skill.version }}</template>
                  </small>
                </td>
                <td v-for="agent in matrixAgents" :key="agent" class="skills-cell">
                  <button
                    v-if="cellVisible(skill, agent)"
                    class="settings-switch"
                    :class="{ on: cellOn(skill, agent), warn: cellWarn(skill, agent) }"
                    type="button"
                    :disabled="cellDisabled(skill, agent) || busy"
                    :title="cellTitle(skill, agent)"
                    :aria-label="`${skill.name} · ${agentLabel(agent)}`"
                    @click.stop="toggleCell(skill, agent)"
                  ><i /></button>
                  <span v-else class="skills-unsupported">—</span>
                </td>
                <td class="skills-trust-cell">
                  <i class="settings-dot" :class="trustTone(skill.trust)" />{{ t(`settingsUi.trustState.${skill.trust}`) }}
                </td>
                <td class="skills-updated-cell"><small>{{ relative(skill.updatedAt) }}</small></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <SkillDetailPanel
        :skill="detail"
        :agent-labels="agentLabelsAll"
        :installed-agents="installedAgents"
        :busy="busy"
        @trust="trustCurrent"
        @revoke="revokeCurrent"
        @project="projectAgent"
        @unproject="unprojectAgent"
        @resolve="resolveProjection"
        @reveal="revealCurrent"
        @remove="removeCurrent"
      />
    </div>

    <SkillImportDialog
      v-if="importOpen && api"
      :api="api"
      :skills="skills"
      :agent-labels="agentLabelsAll"
      @close="importOpen = false"
      @done="afterImport"
    />
    <SkillEditorDialog
      v-if="editorOpen && api"
      :api="api"
      :agents="editableAgents"
      :agent-labels="agentLabelsAll"
      :agent-capabilities="inventory.agentCapabilities"
      @close="editorOpen = false"
      @done="afterCreate"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { locale, t, translateError } from '../../i18n.js'
import {
  projectionFor,
  projectionOn,
  projectionWarn,
  relativeTime,
  skillFilterCounts,
  sourceLabelKey,
  trustTone,
  visibleSkills,
} from '../../skillLibrary.js'
import SkillDetailPanel from './SkillDetailPanel.vue'
import SkillEditorDialog from './SkillEditorDialog.vue'
import SkillImportDialog from './SkillImportDialog.vue'

const props = defineProps({
  api: { type: Object, default: null },
  installedAgents: { type: Array, default: () => [] },
})

const inventory = ref({
  agents: [],
  agentLabels: {},
  agentCapabilities: {},
  skills: [],
  defaults: {},
  policy: {},
  counts: {},
  storeError: null,
})
const filter = ref('all')
const query = ref('')
const selectedId = ref('')
const detail = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const importOpen = ref(false)
const editorOpen = ref(false)

const skills = computed(() => inventory.value.skills || [])
const agents = computed(() => inventory.value.agents || [])
const agentLabelsAll = computed(() => {
  const capabilities = inventory.value.agentCapabilities || {}
  return {
    ...Object.fromEntries(Object.entries(capabilities).map(([agent, value]) => [agent, value?.label || agent])),
    ...(inventory.value.agentLabels || {}),
  }
})
const editableAgents = computed(() => {
  const base = props.installedAgents.length ? props.installedAgents : agents.value
  return base.filter(agent => inventory.value.agentCapabilities?.[agent]?.projectable === true)
})
const matrixAgents = computed(() => {
  const present = new Set([...agents.value, ...props.installedAgents])
  return Object.keys(inventory.value.agentCapabilities || {}).filter(agent => present.has(agent))
})
const counts = computed(() => skillFilterCounts(skills.value))
const filters = computed(() => {
  const items = [
    { id: 'all', labelKey: 'settingsUi.filterCount.all', count: counts.value.all },
    { id: 'shared', labelKey: 'settingsUi.filterCount.shared', count: counts.value.shared },
    { id: 'native', labelKey: 'settingsUi.filterCount.native', count: counts.value.native },
    { id: 'market', labelKey: 'settingsUi.filterCount.market', count: counts.value.market },
    { id: 'reauth', labelKey: 'settingsUi.filterCount.reauth', count: counts.value.reauth },
  ]
  if (counts.value.conflict) {
    items.push({ id: 'conflict', labelKey: 'settingsUi.filterCount.conflict', count: counts.value.conflict })
  }
  return items
})
const visible = computed(() => visibleSkills(skills.value, { filter: filter.value, query: query.value }))
const currentRow = computed(() => skills.value.find(skill => skill.id === selectedId.value) || null)

function agentLabel(agent) {
  return agentLabelsAll.value[agent] || agent
}

function sourceText(skill) {
  return t(sourceLabelKey(skill.source))
}

function relative(iso) {
  return relativeTime(iso, locale.value)
}

const ERROR_KEYS = {
  SKILL_LIBRARY_UNAVAILABLE: 'skillsUnavailable',
  SKILL_TRUST_REQUIRED: 'trustFirst',
  SKILL_PROJECTION_CONFLICT: 'projectionConflict',
  SKILL_PROJECTION_DRIFTED: 'projectionDrifted',
  SKILL_PROJECTION_OUTDATED: 'projectionOutdated',
  SKILL_PROJECTION_MISSING: 'projectionMissing',
  SKILL_NAME_CONFLICT: 'nameConflict',
  SKILL_CONFIRM_MISMATCH: 'confirmMismatch',
  SKILL_MARKET_READONLY: 'marketReadonly',
  SKILL_TOO_LARGE: 'skillTooLarge',
  SKILL_UNREADABLE: 'skillUnreadable',
  SKILL_UNSAFE: 'skillUnsafe',
  SKILL_UNSUPPORTED_AGENT: 'skillUnsupportedAgent',
  SKILL_SELECTION_INVALID: 'skillSelectionInvalid',
}

function errorText(caught) {
  const code = String(caught?.message || caught?.code || '')
  const key = ERROR_KEYS[code]
  if (key) return t(`settingsUi.${key}`)
  return translateError(caught) || t('settingsUi.errorGeneric')
}

function cellVisible(skill, agent) {
  if (skill.source === 'native') return agent === skill.originKind
  if (projectionFor(skill, agent)) return true
  return inventory.value.agentCapabilities?.[agent]?.projectable !== false
}

function cellDisabled(skill, agent) {
  if (skill.trust !== 'trusted') return true
  if (skill.source === 'native') return agent !== skill.originKind
  return inventory.value.agentCapabilities?.[agent]?.projectable === false
}

function cellOn(skill, agent) {
  if (skill.source === 'native') return (skill.eligible || []).includes(agent)
  return projectionOn(skill, agent)
}

function cellWarn(skill, agent) {
  return skill.source !== 'native' && projectionWarn(skill, agent)
}

function cellTitle(skill, agent) {
  if (skill.trust !== 'trusted') return t('settingsUi.trustFirst')
  const projection = projectionFor(skill, agent)
  if (projection?.status) return t(`settingsUi.projectionState.${projection.status}`)
  return agentLabel(agent)
}

async function load() {
  if (!props.api?.list) {
    error.value = t('settingsUi.skillsUnavailable')
    return
  }
  loading.value = true
  error.value = ''
  try {
    const next = await props.api.list()
    inventory.value = {
      agents: [],
      agentLabels: {},
      agentCapabilities: {},
      skills: [],
      defaults: {},
      policy: {},
      counts: {},
      storeError: null,
      ...(next || {}),
    }
    if (!skills.value.some(skill => skill.id === selectedId.value)) {
      selectedId.value = visible.value[0]?.id || skills.value[0]?.id || ''
    }
    if (selectedId.value) await loadDetail(selectedId.value)
    else detail.value = null
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    loading.value = false
  }
}

async function loadDetail(id) {
  if (!props.api?.detail) return
  try {
    const value = await props.api.detail({ id })
    if (selectedId.value === id) detail.value = value
  } catch {
    detail.value = currentRow.value
  }
}

async function select(id) {
  selectedId.value = id
  await loadDetail(id)
}

async function run(action) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    await load()
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

function trustCurrent() {
  if (!currentRow.value) return
  return run(() => props.api.trust({ id: currentRow.value.id }))
}

function revokeCurrent() {
  if (!currentRow.value) return
  return run(() => props.api.revokeTrust({ id: currentRow.value.id }))
}

function projectAgent(agent) {
  if (!currentRow.value) return
  return run(() => props.api.project({ id: currentRow.value.id, agent }))
}

function unprojectAgent(agent) {
  if (!currentRow.value) return
  return run(() => props.api.unproject({ id: currentRow.value.id, agent }))
}

function resolveProjection({ projectionId, action }) {
  return run(() => props.api.resolveProjection({ projectionId, action }))
}

function revealCurrent() {
  if (!currentRow.value) return
  return run(() => props.api.reveal({ id: currentRow.value.id }))
}

function removeCurrent(confirmName) {
  if (!currentRow.value) return
  return run(async () => {
    await props.api.remove({ id: currentRow.value.id, confirmName })
    selectedId.value = ''
    detail.value = null
  })
}

function toggleCell(skill, agent) {
  if (busy.value || cellDisabled(skill, agent)) return
  if (skill.source === 'native') {
    const enabled = !(skill.eligible || []).includes(agent)
    return run(() => props.api.setEligible({ id: skill.id, agent, enabled }))
  }
  if (cellOn(skill, agent)) {
    if (cellWarn(skill, agent)) {
      error.value = t('settingsUi.projectionNeedsAttention')
      select(skill.id)
      return
    }
    return run(() => props.api.unproject({ id: skill.id, agent }))
  }
  return run(() => props.api.project({ id: skill.id, agent }))
}

function afterImport(result) {
  importOpen.value = false
  const first = result?.imported?.[0]?.id || ''
  if (first) selectedId.value = first
  if (Array.isArray(result?.failed) && result.failed.length) {
    error.value = t('settingsUi.importFailed', { count: result.failed.length })
  }
  load()
}

function afterCreate(created) {
  editorOpen.value = false
  if (created?.id) selectedId.value = created.id
  if (Array.isArray(created?.targetErrors) && created.targetErrors.length) {
    error.value = t('settingsUi.projectFailed', { count: created.targetErrors.length })
  }
  load()
}

let unsubscribe = null
onMounted(() => {
  load()
  if (typeof props.api?.onChanged === 'function') {
    unsubscribe = props.api.onChanged(() => { load() })
  }
})
onBeforeUnmount(() => {
  if (typeof unsubscribe === 'function') unsubscribe()
})
</script>

<style scoped>
.skills-page { display: grid; gap: 16px; align-content: start; }
.mock-filters { flex-wrap: wrap; margin-bottom: 8px; }
.mock-filters input { height: 32px; min-width: 160px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
.chip { height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 99px; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.chip.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
.chip.warn { border-color: #f5a524; color: #f5a524; }
.skills-matrix-card { min-width: 0; }
.skills-table-wrap { overflow-x: auto; }
.skills-table { min-width: 560px; }
.skills-agent-head, .skills-cell { width: 64px; text-align: center; }
.skills-name-cell { max-width: 320px; }
.skills-name-line { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.skills-name-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-conflict-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; font-size: 10px; font-weight: 650; }
.skills-source { color: var(--muted); }
.skills-source.shared { color: var(--accent-text); }
.skills-source.market { color: #b07cff; }
.skills-trust-cell { white-space: nowrap; }
.skills-updated-cell { white-space: nowrap; color: var(--muted); }
.skills-unsupported { color: var(--faint); }
.settings-switch.warn.on { background: #f5a524; }
.skill-banner-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; margin-left: auto; }
.settings-banner { align-items: center; }
@media (max-width: 980px) {
  .skills-table { min-width: 0; }
  .skills-agent-head, .skills-cell { width: auto; }
}
</style>
