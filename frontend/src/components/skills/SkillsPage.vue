<template>
  <div class="skills-page">
    <header class="settings-page-title">
      <div>
        <h1>{{ t('systemSettings.skills') }}</h1>
        <p>{{ t('settingsUi.skillsLead') }}</p>
      </div>
      <div class="settings-actions">
        <button class="secondary-button" type="button" :disabled="busy || !api" :title="t('settingsUi.marketBrowseHint')" @click="openMarket()">{{ t('settingsUi.browseMarket') }}</button>
        <button class="secondary-button" type="button" :disabled="busy || !api" @click="importOpen = true">{{ t('settingsUi.importAgents') }}</button>
        <button class="primary-button" type="button" :disabled="busy || !api" @click="openCreate">+ {{ t('settingsUi.newSkill') }}</button>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="skill-banner-close" :aria-label="t('common.cancel')" @click="error = ''">×</button>
    </p>
    <p v-if="inventory.storeError" class="settings-note">{{ t('settingsUi.storeError') }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>

    <div v-if="api && pendingItems.length" class="skills-pending" role="status">
      <span class="skills-pending-title">{{ t('settingsUi.pendingTitle') }}</span>
      <button
        v-for="item in pendingItems"
        :key="item.id"
        type="button"
        class="skills-pending-item"
        :class="item.tone"
        @click="filter = item.filter"
      >{{ t(item.labelKey, { count: item.count }) }}</button>
    </div>

    <div v-if="api" class="settings-split">
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
                <th>{{ t('settingsUi.actions') }}</th>
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
                    <span v-if="skill.updateAvailable" class="skills-update-badge">{{ t('settingsUi.marketUpdateBadge') }}</span>
                    <span v-if="skill.repoSkill" class="skills-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                  </span>
                  <small class="skills-meta">
                    <span class="skills-source" :class="skill.source">{{ sourceText(skill) }}</span>
                    <template v-if="skill.version"> · v{{ skill.version }}</template>
                  </small>
                  <p v-if="skill.description" class="skills-desc">{{ skill.description }}</p>
                </td>
                <td v-for="agent in matrixAgents" :key="agent" class="skills-cell">
                  <button
                    v-if="skill.source === 'native' && agent === skill.originKind"
                    class="skills-native-toggle"
                    :class="{ on: cellOn(skill, agent) }"
                    type="button"
                    :disabled="cellDisabled(skill, agent) || busy"
                    :title="cellTitle(skill, agent)"
                    :aria-label="`${skill.name} · ${agentLabel(agent)}`"
                    @click.stop="toggleCell(skill, agent)"
                  >
                    <span class="skills-native-dot" />{{ cellOn(skill, agent) ? t('settingsUi.nativeEnabled') : t('settingsUi.nativeDisabled') }}
                  </button>
                  <button
                    v-else-if="cellVisible(skill, agent)"
                    class="skills-cell-state"
                    :class="cellTone(skill, agent)"
                    type="button"
                    :disabled="cellDisabled(skill, agent) || busy"
                    :title="cellTitle(skill, agent)"
                    :aria-label="`${skill.name} · ${agentLabel(agent)} · ${cellLabel(skill, agent)}`"
                    @click.stop="toggleCell(skill, agent)"
                  >{{ cellGlyph(skill, agent) }}</button>
                  <span v-else class="skills-unsupported" :title="cellTitle(skill, agent)">—</span>
                </td>
                <td class="skills-trust-cell">
                  <i class="settings-dot" :class="trustTone(skill.trust)" />{{ t(`settingsUi.trustState.${skill.trust}`) }}
                </td>
                <td class="skills-updated-cell" :title="t('settingsUi.updatedHint')"><small>{{ relative(skill.updatedAt) }}</small></td>
                <td class="skills-actions-cell">
                  <template v-if="skill.source === 'native'">
                    <span class="skills-unsupported" :title="t('settingsUi.nativeReadonly')">—</span>
                  </template>
                  <template v-else>
                    <button
                      class="skills-row-action"
                      type="button"
                      :disabled="busy"
                      :title="skill.sourceKind === 'shared' ? t('settingsUi.updateSkillHint') : t('settingsUi.marketUpdateHint')"
                      @click.stop="openEdit(skill)"
                    >{{ t('settingsUi.updateSkill') }}</button>
                    <button class="skills-row-action danger" type="button" :disabled="busy" @click.stop="openDelete(skill)">{{ t('settingsUi.deleteSkill') }}</button>
                  </template>
                </td>
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
      :policy="inventory.policy"
      @close="importOpen = false"
      @done="afterImport"
    />
    <SkillEditorDialog
      v-if="editorOpen && api"
      :api="api"
      :skill="editingSkill"
      :agents="editableAgents"
      :agent-labels="agentLabelsAll"
      :agent-capabilities="inventory.agentCapabilities"
      @close="editorOpen = false"
      @done="afterEditor"
    />
    <SkillDeleteDialog
      v-if="deleteOpen && api && deleteTarget"
      :api="api"
      :skill="deleteTarget"
      @close="deleteOpen = false"
      @done="afterDelete"
    />
    <SkillMarketDialog
      v-if="marketOpen && api"
      :api="api"
      :policy="inventory.policy"
      :initial-skill="marketUpdateSkill"
      @close="marketOpen = false; marketUpdateSkill = null"
      @done="afterMarket"
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
import SkillDeleteDialog from './SkillDeleteDialog.vue'
import SkillDetailPanel from './SkillDetailPanel.vue'
import SkillEditorDialog from './SkillEditorDialog.vue'
import SkillImportDialog from './SkillImportDialog.vue'
import SkillMarketDialog from './SkillMarketDialog.vue'

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
const editingSkill = ref(null)
const deleteOpen = ref(false)
const deleteTarget = ref(null)
const marketOpen = ref(false)
const marketUpdateSkill = ref(null)

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
  const withContent = new Set()
  for (const skill of skills.value) {
    if (!skill) continue
    if (skill.source === 'native' && skill.originKind) withContent.add(skill.originKind)
    for (const projection of skill.projections || []) withContent.add(projection.agent)
    if ((skill.source === 'shared' || skill.source === 'market') && skill.trust === 'trusted') {
      for (const agent of skill.available || []) withContent.add(agent)
    }
  }
  return Object.keys(inventory.value.agentCapabilities || {})
    .filter(agent => present.has(agent) && withContent.has(agent))
})
const counts = computed(() => skillFilterCounts(skills.value))
const pendingItems = computed(() => {
  const items = []
  if (counts.value.conflict) {
    items.push({ id: 'conflict', filter: 'conflict', labelKey: 'settingsUi.pendingConflict', count: counts.value.conflict, tone: 'danger' })
  }
  if (counts.value.reauth) {
    items.push({ id: 'reauth', filter: 'reauth', labelKey: 'settingsUi.pendingReauth', count: counts.value.reauth, tone: 'warn' })
  }
  const updates = skills.value.filter(skill => skill.updateAvailable).length
  if (updates) {
    items.push({ id: 'updates', filter: 'market', labelKey: 'settingsUi.pendingUpdate', count: updates, tone: 'ok' })
  }
  return items
})
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
  if (skill.source === 'native') {
    return t('settingsUi.sourceNativeOf', { agent: agentLabel(skill.originKind) })
  }
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
  SKILL_NETWORK_DENIED: 'networkDenied',
}

function errorText(caught) {
  const code = String(caught?.message || caught?.code || '')
  const key = ERROR_KEYS[code]
  if (key) return t(`settingsUi.${key}`)
  return translateError(caught) || t('settingsUi.errorGeneric')
}

function cellVisible(skill, agent) {
  if (skill.source === 'native') return agent === skill.originKind
  if (inventory.value.agentCapabilities?.[agent]?.projectable === false) return false
  if (projectionFor(skill, agent)) return true
  if (skill.trust !== 'trusted') return true
  return (skill.available || []).includes(agent)
}

function cellDisabled(skill, agent) {
  if (skill.source === 'native') return agent !== skill.originKind || skill.trust !== 'trusted'
  return skill.trust !== 'trusted' || inventory.value.agentCapabilities?.[agent]?.projectable === false
}

function cellOn(skill, agent) {
  if (skill.source === 'native') return (skill.eligible || []).includes(agent)
  return projectionOn(skill, agent)
}

function cellWarn(skill, agent) {
  return skill.source !== 'native' && projectionWarn(skill, agent)
}

const CELL_GLYPHS = {
  deployed: '✓',
  outdated: '↑',
  drifted: '✎',
  missing: '–',
  conflict: '!',
  unavailable: '∅',
}

function cellState(skill, agent) {
  const projection = projectionFor(skill, agent)
  if (projection) return projection.status || 'deployed'
  return skill.trust === 'trusted' ? 'available' : 'untrusted'
}

function cellGlyph(skill, agent) {
  const state = cellState(skill, agent)
  if (state === 'available' || state === 'untrusted') return '○'
  return CELL_GLYPHS[state] || '○'
}

function cellTone(skill, agent) {
  const state = cellState(skill, agent)
  if (state === 'deployed') return 'ready'
  if (state === 'conflict' || state === 'unavailable') return 'danger'
  if (state === 'available') return 'available'
  return 'warn'
}

function cellLabel(skill, agent) {
  const state = cellState(skill, agent)
  if (state === 'available') return t('settingsUi.cellAvailable')
  if (state === 'untrusted') return t('settingsUi.trustFirst')
  return t(`settingsUi.projectionState.${state}`)
}

function cellTitle(skill, agent) {
  if (skill.source === 'native') {
    if (agent !== skill.originKind) return t('settingsUi.nativeOtherAgent')
    if (skill.trust !== 'trusted') return t('settingsUi.trustFirst')
    return t('settingsUi.nativeToggleHint')
  }
  if (inventory.value.agentCapabilities?.[agent]?.projectable === false) return t('settingsUi.notProjectable')
  if (skill.trust !== 'trusted') return t('settingsUi.trustFirst')
  const projection = projectionFor(skill, agent)
  if (projection?.status) {
    return `${t(`settingsUi.projectionState.${projection.status}`)}${projection.displayPath ? ` · ${projection.displayPath}` : ''}`
  }
  return t('settingsUi.cellAvailable')
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

function openCreate() {
  editingSkill.value = null
  editorOpen.value = true
}

function openMarket(skill = null) {
  marketUpdateSkill.value = skill
  marketOpen.value = true
}

async function openEdit(skill) {
  if (busy.value) return
  if (skill.sourceKind === 'market') {
    openMarket(skill)
    return
  }
  if (skill.sourceKind !== 'shared') return
  error.value = ''
  try {
    const value = skill.id === detail.value?.id ? detail.value : await props.api.detail({ id: skill.id })
    if (!value?.canEdit) {
      error.value = t('settingsUi.editUnavailable')
      return
    }
    selectedId.value = skill.id
    detail.value = value
    editingSkill.value = value
    editorOpen.value = true
  } catch (caught) {
    error.value = errorText(caught)
  }
}

function openDelete(skill) {
  if (busy.value) return
  deleteTarget.value = skill
  deleteOpen.value = true
}

function afterEditor(result) {
  editorOpen.value = false
  editingSkill.value = null
  if (result?.id) selectedId.value = result.id
  if (Array.isArray(result?.targetErrors) && result.targetErrors.length) {
    error.value = t('settingsUi.projectFailed', { count: result.targetErrors.length })
  }
  load()
}

function afterDelete(result) {
  deleteOpen.value = false
  deleteTarget.value = null
  if (result?.removed) load()
}

function afterMarket(detail) {
  marketOpen.value = false
  marketUpdateSkill.value = null
  if (detail?.id) selectedId.value = detail.id
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
.skills-pending { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.skills-pending-title { font-size: 12px; font-weight: 650; color: var(--text-soft); }
.skills-pending-item { border: 1px solid var(--border); background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; border-radius: 99px; padding: 3px 10px; cursor: pointer; }
.skills-pending-item.danger { border-color: #f2555a; color: #f2555a; }
.skills-pending-item.warn { border-color: #f5a524; color: #f5a524; }
.skills-pending-item.ok { border-color: #3ecf8e; color: #3ecf8e; }
.skills-meta { color: var(--muted); font-size: 11px; }
.skills-desc { margin: 2px 0 0; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-native-toggle { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 99px; background: transparent; color: var(--muted); font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer; }
.skills-native-toggle.on { border-color: #3ecf8e; color: #3ecf8e; }
.skills-native-toggle:disabled { cursor: default; opacity: .55; }
.skills-native-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.skills-cell-state { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; }
.skills-cell-state.ready { border-color: color-mix(in srgb, #3ecf8e 45%, transparent); color: #3ecf8e; }
.skills-cell-state.warn { border-color: color-mix(in srgb, #f5a524 45%, transparent); color: #f5a524; }
.skills-cell-state.danger { border-color: color-mix(in srgb, #f2555a 45%, transparent); color: #f2555a; }
.skills-cell-state.available { color: var(--text-soft); }
.skills-cell-state:disabled { cursor: default; opacity: .55; }
.skills-table-wrap { overflow-x: auto; }
.skills-table { min-width: 680px; }
.skills-agent-head, .skills-cell { width: 64px; text-align: center; }
.skills-actions-cell { white-space: nowrap; text-align: right; opacity: 0; transition: opacity .12s ease; }
tbody tr:hover .skills-actions-cell, tbody tr.picked .skills-actions-cell, tbody tr:focus-within .skills-actions-cell { opacity: 1; }
.skills-row-action { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; padding: 0 4px; }
.skills-row-action:disabled { color: var(--faint); cursor: default; }
.skills-row-action.danger { color: #f2555a; }
.skills-name-cell { max-width: 320px; }
.skills-name-line { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.skills-name-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-conflict-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; font-size: 10px; font-weight: 650; }
.skills-update-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; font-size: 10px; font-weight: 650; }
.skills-repo-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-text); font-size: 10px; font-weight: 650; }
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
