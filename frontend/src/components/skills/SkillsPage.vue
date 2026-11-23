<template>
  <div class="skills-page">
    <header class="settings-page-title">
      <div>
        <h1>{{ t('systemSettings.skills') }}</h1>
        <p>{{ t('settingsUi.skillsLead') }}</p>
      </div>
      <div class="settings-actions">
        <button class="primary-button" type="button" :disabled="busy || !api" @click="openCreate">+ {{ t('settingsUi.newSkill') }}</button>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="skill-banner-close" :aria-label="t('common.cancel')" @click="error = ''">×</button>
    </p>
    <p v-if="inventory.storeError" class="settings-note">{{ t('settingsUi.storeError') }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>

    <template v-if="api">
      <div class="skills-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="view === 'platform'" :class="{ active: view === 'platform' }" @click="view = 'platform'">
          {{ t('settingsUi.tabPlatform') }} <span>{{ platformSkills.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="view === 'native'" :class="{ active: view === 'native' }" @click="view = 'native'">
          {{ t('settingsUi.tabNative') }} <span>{{ nativeSkills.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="view === 'market'" :class="{ active: view === 'market' }" @click="switchToMarket">
          {{ t('settingsUi.tabMarket') }}
        </button>
      </div>

      <section v-if="view === 'platform'" class="settings-card">
        <div class="settings-actions mock-filters">
          <input v-model="query" type="search" :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
        </div>
        <p v-if="loading" class="settings-note">{{ t('common.loading') }}</p>
        <p v-else-if="!platformVisible.length" class="settings-note">{{ t('settingsUi.platformEmpty') }}</p>
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
              <tr v-for="skill in platformVisible" :key="skill.id">
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
                  <button
                    v-if="skill.sourceKind === 'shared'"
                    class="skills-row-action"
                    type="button"
                    :disabled="busy"
                    :title="t('settingsUi.updateSkillHint')"
                    @click="openEdit(skill)"
                  >{{ t('settingsUi.updateSkill') }}</button>
                  <button class="skills-row-action danger" type="button" :disabled="busy" @click="openDelete(skill)">{{ t('settingsUi.deleteSkill') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else-if="view === 'native'" class="settings-card">
        <div class="skills-subtabs" role="tablist">
          <button
            v-for="agent in nativeAgents"
            :key="agent"
            type="button"
            role="tab"
            :aria-selected="nativeAgent === agent"
            :class="{ active: nativeAgent === agent }"
            @click="nativeAgent = agent"
          >{{ agentLabel(agent) }} <span>{{ nativeSkillsFor(agent).length }}</span></button>
        </div>
        <p v-if="!nativeAgents.length" class="settings-note">{{ t('settingsUi.nativeEmpty') }}</p>
        <template v-else>
          <div class="settings-actions mock-filters">
            <input v-model="query" type="search" :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
          </div>
          <p v-if="!nativeVisible.length" class="settings-note">{{ t('settingsUi.skillsEmpty') }}</p>
          <div v-else class="skills-table-wrap">
            <table class="settings-mini-table skills-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>{{ t('settingsUi.updated') }}</th>
                  <th class="skills-actions-head">{{ t('settingsUi.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="skill in nativeVisible" :key="skill.id">
                  <td class="skills-name-cell">
                    <span class="skills-name-line"><strong>{{ skill.name }}</strong></span>
                    <small class="skills-meta">{{ skill.description || t('settingsUi.noDescription') }}</small>
                  </td>
                  <td class="skills-updated-cell"><small>{{ relative(skill.updatedAt) }}</small></td>
                  <td class="skills-actions-cell"><span class="skills-unsupported" :title="t('settingsUi.nativeReadonly')">—</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section v-else class="settings-card">
        <div class="skills-subtabs market-sources" role="tablist">
          <button
            v-for="source in marketSources"
            :key="source.id"
            type="button"
            role="tab"
            :aria-selected="marketSourceId === source.id"
            :class="{ active: marketSourceId === source.id }"
            :title="source.url"
            @click="selectMarketSource(source)"
          >{{ source.ref || 'HEAD' }}<template v-if="source.subpath"> · {{ source.subpath }}</template></button>
          <button class="chip" type="button" @click="showAddSource = !showAddSource">+ {{ t('settingsUi.marketAddSource') }}</button>
          <button v-if="marketSourceId" class="chip danger" type="button" @click="removeMarketSource">{{ t('settingsUi.marketRemoveSource') }}</button>
        </div>

        <form v-if="showAddSource" class="market-source-form" @submit.prevent="addMarketSource">
          <input v-model.trim="sourceForm.url" type="url" :placeholder="t('settingsUi.marketUrlPlaceholder')" />
          <input v-model.trim="sourceForm.ref" type="text" :placeholder="t('settingsUi.marketRefPlaceholder')" />
          <input v-model.trim="sourceForm.subpath" type="text" :placeholder="t('settingsUi.marketSubpathPlaceholder')" />
          <button class="primary-button" type="submit" :disabled="marketBusy || !sourceForm.url">{{ t('settingsUi.marketAdd') }}</button>
        </form>

        <p v-if="marketError" class="settings-banner" role="alert">{{ marketError }}</p>
        <p v-if="!marketSources.length" class="settings-note">{{ t('settingsUi.marketEmptySources') }}</p>
        <p v-else-if="marketLoading" class="settings-note">{{ t('common.loading') }}</p>
        <p v-else-if="!marketVisible.length" class="settings-note">{{ t('settingsUi.marketNoEntries') }}</p>
        <div v-else class="skills-table-wrap">
          <table class="settings-mini-table skills-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>{{ t('settingsUi.marketPath') }}</th>
                <th class="skills-actions-head">{{ t('settingsUi.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in marketVisible" :key="entry.token">
                <td class="skills-name-cell">
                  <span class="skills-name-line">
                    <strong>{{ entry.name }}</strong>
                    <span v-if="entry.repoMode" class="skills-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                    <span v-if="!entry.validName" class="skills-update-badge warn">{{ t('settingsUi.marketInvalidName') }}</span>
                  </span>
                  <small class="skills-meta">{{ entry.description || t('settingsUi.noDescription') }}</small>
                </td>
                <td class="skills-source-cell"><small class="market-path">{{ entry.relativePath || '/' }}</small></td>
                <td class="skills-actions-cell">
                  <template v-if="entry.installed">
                    <button
                      v-if="!entry.upToDate"
                      class="skills-row-action"
                      type="button"
                      :disabled="marketBusy"
                      @click="updateEntry(entry)"
                    >{{ t('settingsUi.marketUpdate') }}</button>
                    <button class="skills-row-action danger" type="button" :disabled="marketBusy" @click="removeEntry(entry)">{{ t('settingsUi.marketRemove') }}</button>
                  </template>
                  <button
                    v-else
                    class="skills-row-action"
                    type="button"
                    :disabled="marketBusy || !entry.validName"
                    @click="installEntry(entry)"
                  >{{ t('settingsUi.marketAdd') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

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
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { locale, t, translateError } from '../../i18n.js'
import { relativeTime, sourceLabelKey } from '../../skillLibrary.js'
import SkillDeleteDialog from './SkillDeleteDialog.vue'
import SkillEditorDialog from './SkillEditorDialog.vue'

const props = defineProps({
  api: { type: Object, default: null },
})

const inventory = ref({ agents: [], agentLabels: {}, skills: [], defaults: {}, counts: {}, storeError: null })
const view = ref('platform')
const query = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editingSkill = ref(null)
const deleteOpen = ref(false)
const deleteTarget = ref(null)

const marketSources = ref([])
const marketSourceId = ref('')
const marketEntries = ref([])
const marketLoading = ref(false)
const marketBusy = ref(false)
const marketError = ref('')
const showAddSource = ref(false)
const sourceForm = reactive({ url: '', ref: '', subpath: '' })

const skills = computed(() => inventory.value.skills || [])
const agentLabelsAll = computed(() => inventory.value.agentLabels || {})
const platformSkills = computed(() => skills.value.filter(skill => skill.source !== 'native'))
const nativeSkills = computed(() => skills.value.filter(skill => skill.source === 'native'))
const nativeAgents = computed(() => [...new Set(nativeSkills.value.map(skill => skill.originKind).filter(Boolean))])
const nativeAgent = ref('')

const platformVisible = computed(() => filterByQuery(platformSkills.value))
const nativeVisible = computed(() => filterByQuery(nativeSkills.value.filter(skill => skill.originKind === nativeAgent.value)))
const marketVisible = computed(() => filterByQuery(marketEntries.value))

function filterByQuery(rows) {
  const needle = String(query.value || '').trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(row => `${row.name || ''} ${row.description || ''}`.toLowerCase().includes(needle))
}

function nativeSkillsFor(agent) {
  return nativeSkills.value.filter(skill => skill.originKind === agent)
}

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
  SKILL_NAME_CONFLICT: 'nameConflict',
  SKILL_CONFIRM_MISMATCH: 'confirmMismatch',
  SKILL_MARKET_READONLY: 'marketReadonly',
  SKILL_TOO_LARGE: 'skillTooLarge',
  SKILL_UNREADABLE: 'skillUnreadable',
  SKILL_UNSAFE: 'skillUnsafe',
  SKILL_UNSUPPORTED_AGENT: 'skillUnsupportedAgent',
  SKILL_SELECTION_INVALID: 'skillSelectionInvalid',
  SKILL_MARKET_SOURCE_IN_USE: 'marketSourceInUse',
  SKILL_MARKET_SOURCE_INVALID: 'marketSourceInvalid',
  SKILL_MARKET_FETCH_FAILED: 'marketFetchFailed',
  SKILL_MARKET_GIT_MISSING: 'marketGitMissing',
  SKILL_MARKET_NO_SKILLS: 'marketNoSkills',
  SKILL_MARKET_ENTRY_EXPIRED: 'marketEntryExpired',
  SKILL_MARKET_ENTRY_NOT_FOUND: 'marketEntryNotFound',
  SKILL_MARKET_ENTRY_INVALID: 'marketEntryInvalid',
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
    if (!nativeAgents.value.includes(nativeAgent.value)) {
      nativeAgent.value = nativeAgents.value[0] || ''
    }
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    loading.value = false
  }
}

function switchToMarket() {
  view.value = 'market'
  if (!marketSources.value.length) loadMarketSources()
}

async function loadMarketSources() {
  if (typeof props.api?.marketSources !== 'function') return
  try {
    marketSources.value = await props.api.marketSources()
    if (!marketSources.value.some(source => source.id === marketSourceId.value)) {
      marketSourceId.value = marketSources.value[0]?.id || ''
      marketEntries.value = []
    }
    if (marketSourceId.value) await loadMarketEntries(marketSourceId.value)
  } catch (caught) {
    marketError.value = errorText(caught)
  }
}

async function selectMarketSource(source) {
  marketSourceId.value = source.id
  await loadMarketEntries(source.id)
}

async function loadMarketEntries(sourceId) {
  marketLoading.value = true
  marketError.value = ''
  try {
    const result = await props.api.marketPreview({ sourceId })
    if (marketSourceId.value !== sourceId) return
    marketEntries.value = result.entries || []
  } catch (caught) {
    marketEntries.value = []
    marketError.value = errorText(caught)
  } finally {
    marketLoading.value = false
  }
}

async function addMarketSource() {
  if (marketBusy.value || !sourceForm.url) return
  marketBusy.value = true
  marketError.value = ''
  try {
    const source = await props.api.marketAddSource({
      url: sourceForm.url,
      ref: sourceForm.ref,
      subpath: sourceForm.subpath,
    })
    showAddSource.value = false
    sourceForm.url = ''
    sourceForm.ref = ''
    sourceForm.subpath = ''
    marketSourceId.value = source.id
    await loadMarketSources()
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    marketBusy.value = false
  }
}

async function removeMarketSource() {
  if (!marketSourceId.value || marketBusy.value) return
  marketBusy.value = true
  marketError.value = ''
  try {
    await props.api.marketRemoveSource({ sourceId: marketSourceId.value })
    marketSourceId.value = ''
    marketEntries.value = []
    await loadMarketSources()
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    marketBusy.value = false
  }
}

async function installEntry(entry) {
  if (marketBusy.value || !entry.validName) return
  marketBusy.value = true
  marketError.value = ''
  try {
    await props.api.marketInstall({ token: entry.token, repo: entry.repoMode === true })
    await Promise.all([loadMarketEntries(marketSourceId.value), load()])
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    marketBusy.value = false
  }
}

async function updateEntry(entry) {
  if (marketBusy.value || !entry.installed) return
  marketBusy.value = true
  marketError.value = ''
  try {
    const preview = await props.api.marketPreviewUpdate({ skillId: entry.installedId })
    await props.api.marketApplyUpdate({ skillId: entry.installedId, token: preview.entry.token })
    await Promise.all([loadMarketEntries(marketSourceId.value), load()])
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    marketBusy.value = false
  }
}

function removeEntry(entry) {
  if (!entry.installedId) return
  deleteTarget.value = { id: entry.installedId, name: entry.name }
  deleteOpen.value = true
}

function openCreate() {
  editingSkill.value = null
  editorOpen.value = true
}

async function openEdit(skill) {
  if (busy.value || skill.sourceKind !== 'shared') return
  error.value = ''
  try {
    const value = await props.api.detail({ id: skill.id })
    if (!value?.canEdit) {
      error.value = t('settingsUi.editUnavailable')
      return
    }
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

async function afterEditor(result) {
  editorOpen.value = false
  editingSkill.value = null
  await load()
  void result
}

async function afterDelete(result) {
  deleteOpen.value = false
  deleteTarget.value = null
  if (!result?.removed) return
  await load()
  if (view.value === 'market' && marketSourceId.value) await loadMarketEntries(marketSourceId.value)
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
.skills-page { display: grid; gap: 14px; align-content: start; }
.skills-tabs, .skills-subtabs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.skills-tabs { border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.skills-tabs button, .skills-subtabs button {
  height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer;
}
.skills-tabs button.active, .skills-subtabs button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
.skills-tabs button span, .skills-subtabs button span { margin-left: 5px; color: var(--muted); font-size: 10px; }
.skills-subtabs { margin-bottom: 10px; }
.mock-filters { flex-wrap: wrap; margin-bottom: 8px; }
.mock-filters input { height: 32px; min-width: 160px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
.skills-table-wrap { overflow-x: auto; }
.skills-table { min-width: 560px; }
.skills-actions-head, .skills-actions-cell { width: 140px; white-space: nowrap; text-align: right; }
.skills-row-action { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; padding: 0 4px; }
.skills-row-action:disabled { color: var(--faint); cursor: default; }
.skills-row-action.danger { color: #f2555a; }
.skills-name-cell { max-width: 460px; }
.skills-name-line { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.skills-name-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-update-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; font-size: 10px; font-weight: 650; }
.skills-update-badge.warn { background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; }
.skills-repo-badge { flex: none; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-text); font-size: 10px; font-weight: 650; }
.skills-meta { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-source-cell { white-space: nowrap; }
.skills-source-cell small { margin-left: 6px; color: var(--muted); font-size: 10px; }
.skills-source { color: var(--muted); }
.skills-source.shared { color: var(--accent-text); }
.skills-source.market { color: #b07cff; }
.skills-updated-cell { white-space: nowrap; color: var(--muted); }
.skills-unsupported { color: var(--faint); }
.market-source-form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; margin-bottom: 10px; }
.market-source-form input { height: 30px; min-width: 0; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.market-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chip.danger { border-color: color-mix(in srgb, #f2555a 45%, var(--border)); color: #f2555a; }
.skill-banner-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; margin-left: auto; }
.settings-banner { align-items: center; }
@media (max-width: 980px) {
  .skills-table { min-width: 0; }
  .market-source-form { grid-template-columns: 1fr; }
}
</style>
