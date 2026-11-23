<template>
  <div class="skills-page">
    <header class="settings-page-title">
      <div>
        <h1>{{ t('systemSettings.skills') }}</h1>
        <p>{{ t('settingsUi.skillsLead') }}</p>
      </div>
      <div class="settings-actions">
        <button class="secondary-button" type="button" :disabled="busy || !api" :title="t('settingsUi.marketBrowseHint')" @click="openMarket()">{{ t('settingsUi.browseMarket') }}</button>
        <button class="primary-button" type="button" :disabled="busy || !api" @click="openCreate">+ {{ t('settingsUi.newSkill') }}</button>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="skill-banner-close" :aria-label="t('common.cancel')" @click="error = ''">×</button>
    </p>
    <p v-if="inventory.storeError" class="settings-note">{{ t('settingsUi.storeError') }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>

    <div v-if="api" class="settings-split">
      <div class="settings-card skills-matrix-card">
        <div class="settings-actions mock-filters">
          <input v-model="query" type="search" :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
          <button
            v-for="item in filters"
            :key="item.id"
            class="chip"
            :class="{ active: filter === item.id }"
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
                <th>{{ t('settingsUi.source') }}</th>
                <th>{{ t('settingsUi.updated') }}</th>
                <th class="skills-actions-head">{{ t('settingsUi.actions') }}</th>
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
                    <span v-if="skill.updateAvailable" class="skills-update-badge">{{ t('settingsUi.marketUpdateBadge') }}</span>
                    <span v-if="skill.repoSkill" class="skills-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                  </span>
                  <small class="skills-meta">{{ skill.description || t('settingsUi.noDescription') }}</small>
                </td>
                <td class="skills-source-cell">
                  <span class="skills-source" :class="skill.source">{{ sourceText(skill) }}</span>
                  <small v-if="skill.version">v{{ skill.version }}</small>
                </td>
                <td class="skills-updated-cell"><small>{{ relative(skill.updatedAt) }}</small></td>
                <td class="skills-actions-cell">
                  <template v-if="skill.source !== 'native'">
                    <button
                      class="skills-row-action"
                      type="button"
                      :disabled="busy"
                      :title="skill.sourceKind === 'shared' ? t('settingsUi.updateSkillHint') : t('settingsUi.marketUpdateHint')"
                      @click.stop="openEdit(skill)"
                    >{{ t('settingsUi.updateSkill') }}</button>
                    <button class="skills-row-action danger" type="button" :disabled="busy" @click.stop="openDelete(skill)">{{ t('settingsUi.deleteSkill') }}</button>
                  </template>
                  <span v-else class="skills-unsupported" :title="t('settingsUi.nativeReadonly')">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <SkillDetailPanel
        :skill="detail"
        :agent-labels="agentLabelsAll"
        :busy="busy"
        @reveal="revealCurrent"
        @remove="removeCurrent"
      />
    </div>

    <SkillEditorDialog
      v-if="editorOpen && api"
      :api="api"
      :skill="editingSkill"
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
  relativeTime,
  skillFilterCounts,
  sourceLabelKey,
  visibleSkills,
} from '../../skillLibrary.js'
import SkillDeleteDialog from './SkillDeleteDialog.vue'
import SkillDetailPanel from './SkillDetailPanel.vue'
import SkillEditorDialog from './SkillEditorDialog.vue'
import SkillMarketDialog from './SkillMarketDialog.vue'

const props = defineProps({
  api: { type: Object, default: null },
})

const inventory = ref({ agents: [], agentLabels: {}, skills: [], defaults: {}, counts: {}, storeError: null })
const filter = ref('all')
const query = ref('')
const selectedId = ref('')
const detail = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editingSkill = ref(null)
const deleteOpen = ref(false)
const deleteTarget = ref(null)
const marketOpen = ref(false)
const marketUpdateSkill = ref(null)

const skills = computed(() => inventory.value.skills || [])
const agentLabelsAll = computed(() => inventory.value.agentLabels || {})
const counts = computed(() => skillFilterCounts(skills.value))
const filters = computed(() => [
  { id: 'all', labelKey: 'settingsUi.filterCount.all', count: counts.value.all },
  { id: 'shared', labelKey: 'settingsUi.filterCount.shared', count: counts.value.shared },
  { id: 'market', labelKey: 'settingsUi.filterCount.market', count: counts.value.market },
  { id: 'native', labelKey: 'settingsUi.filterCount.native', count: counts.value.native },
])
const visible = computed(() => visibleSkills(skills.value, { filter: filter.value, query: query.value }))
const currentRow = computed(() => skills.value.find(skill => skill.id === selectedId.value) || null)

function sourceText(skill) {
  if (skill.source === 'native') {
    return t('settingsUi.sourceNativeOf', { agent: agentLabelsAll.value[skill.originKind] || skill.originKind })
  }
  return t(sourceLabelKey(skill.source))
}

function relative(iso) {
  return relativeTime(iso, locale.value)
}

const ERROR_KEYS = {
  SKILL_LIBRARY_UNAVAILABLE: 'skillsUnavailable',
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
      skills: [],
      defaults: {},
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
  load()
}

function afterDelete(result) {
  deleteOpen.value = false
  deleteTarget.value = null
  if (result?.removed) load()
}

function afterMarket(detailValue) {
  marketOpen.value = false
  marketUpdateSkill.value = null
  if (detailValue?.id) selectedId.value = detailValue.id
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
.skills-matrix-card { min-width: 0; }
.skills-table-wrap { overflow-x: auto; }
.skills-table { min-width: 560px; }
.skills-actions-head, .skills-actions-cell { width: 132px; white-space: nowrap; text-align: right; }
.skills-actions-cell { opacity: 0; transition: opacity .12s ease; }
tbody tr:hover .skills-actions-cell, tbody tr.picked .skills-actions-cell, tbody tr:focus-within .skills-actions-cell { opacity: 1; }
.skills-row-action { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; padding: 0 4px; }
.skills-row-action:disabled { color: var(--faint); cursor: default; }
.skills-row-action.danger { color: #f2555a; }
.skills-name-cell { max-width: 420px; }
.skills-name-line { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.skills-name-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-update-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; font-size: 10px; font-weight: 650; }
.skills-repo-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-text); font-size: 10px; font-weight: 650; }
.skills-meta { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-source-cell { white-space: nowrap; }
.skills-source-cell small { margin-left: 6px; color: var(--muted); font-size: 10px; }
.skills-source { color: var(--muted); }
.skills-source.shared { color: var(--accent-text); }
.skills-source.market { color: #b07cff; }
.skills-updated-cell { white-space: nowrap; color: var(--muted); }
.skills-unsupported { color: var(--faint); }
.skill-banner-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; margin-left: auto; }
.settings-banner { align-items: center; }
@media (max-width: 980px) {
  .skills-table { min-width: 0; }
}
</style>
