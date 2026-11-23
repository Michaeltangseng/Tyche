<template>
  <Teleport to="body">
    <div class="market-backdrop" @click.self="close" @wheel.self.prevent>
      <section class="market-dialog" role="dialog" aria-modal="true" :aria-label="t('settingsUi.marketTitle')" tabindex="-1" @keydown.esc.stop="close">
        <header class="market-head">
          <div>
            <h2>{{ t('settingsUi.marketTitle') }}</h2>
            <p>{{ t('settingsUi.marketLead') }}</p>
          </div>
          <button class="market-close" type="button" :aria-label="t('settingsUi.marketClose')" @click="close">×</button>
        </header>

        <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>

        <div class="market-layout">
          <aside class="market-sources">
            <div class="market-source-head">
              <strong>{{ t('settingsUi.marketSources') }}</strong>
              <button class="secondary-button" type="button" @click="showAdd = !showAdd">+ {{ t('settingsUi.marketAddSource') }}</button>
            </div>

            <form v-if="showAdd" class="market-source-form" @submit.prevent="addSource">
              <input v-model.trim="form.url" type="url" :placeholder="t('settingsUi.marketUrlPlaceholder')" />
              <div class="market-source-row">
                <input v-model.trim="form.ref" type="text" :placeholder="t('settingsUi.marketRefPlaceholder')" />
                <input v-model.trim="form.subpath" type="text" :placeholder="t('settingsUi.marketSubpathPlaceholder')" />
              </div>
              <button class="primary-button" type="submit" :disabled="busy || !form.url">{{ t('settingsUi.marketAdd') }}</button>
            </form>

            <p v-if="!sources.length" class="settings-note">{{ t('settingsUi.marketEmptySources') }}</p>
            <div
              v-for="source in sources"
              :key="source.id"
              class="market-source"
              :class="{ picked: selectedSourceId === source.id }"
              @click="selectSource(source)"
            >
              <div class="market-source-copy">
                <strong>{{ source.ref || 'HEAD' }}<template v-if="source.subpath"> · {{ source.subpath }}</template></strong>
                <small>{{ source.url }}</small>
                <small v-if="source.installedCount">{{ t('settingsUi.marketInstalledCount', { count: source.installedCount }) }}</small>
                <small v-if="source.lastCheckedAt">{{ t('settingsUi.marketCheckedAt', { time: relative(source.lastCheckedAt) }) }}</small>
              </div>
              <button
                class="market-source-remove"
                type="button"
                :title="t('settingsUi.marketRemoveSource')"
                @click.stop="removeSource(source)"
              >{{ armedRemoveId === source.id ? t('settingsUi.marketConfirmRemove') : '×' }}</button>
            </div>

            <button class="secondary-button market-check" type="button" :disabled="checking || busy || !sources.length" @click="checkUpdates">
              {{ checking ? t('settingsUi.marketChecking') : t('settingsUi.marketCheckUpdates') }}
            </button>

            <div v-if="checked" class="market-updates">
              <p v-if="!updates.length" class="settings-note">{{ t('settingsUi.marketNoUpdates') }}</p>
              <button
                v-for="update in updates"
                :key="update.skillId"
                class="market-update-row"
                type="button"
                @click="openUpdate({ id: update.skillId, name: update.name })"
              >
                <strong>{{ update.name }}</strong>
                <small>{{ t('settingsUi.marketUpdateAvailable') }}</small>
              </button>
            </div>
          </aside>

          <div class="market-main">
            <template v-if="view === 'update' && update">
              <button class="agent-config-link market-back" type="button" @click="backToBrowse">← {{ t('settingsUi.marketBack') }}</button>
              <div class="market-entry-head">
                <h3>{{ update.name }}</h3>
                <span v-if="update.current.repoSkill || update.entry.repoMode" class="market-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                <span v-if="update.upToDate" class="market-up-to-date">{{ t('settingsUi.marketUpToDate') }}</span>
              </div>
              <p v-if="!update.upToDate" class="settings-note">{{ t('settingsUi.marketUpdateLead') }}</p>
              <div class="market-meta">
                <span>{{ shortHash(update.current.contentHash) }} → {{ shortHash(update.entry.contentHash) }}</span>
                <span class="market-url">{{ update.source.url }}@{{ shortHash(update.source.commit) }}</span>
              </div>
              <div v-if="update.entry.risk?.labels?.length" class="market-risk">
                <strong>{{ t('settingsUi.risk') }}</strong>
                <span class="settings-pills">
                  <span v-for="label in update.entry.risk.labels" :key="label" class="settings-pill" :class="{ deny: update.entry.risk.level === 'high' }">{{ riskLabel(label) }}</span>
                </span>
                <small>{{ t('settingsUi.riskAdvisory') }}</small>
              </div>
              <div class="market-compare">
                <div>
                  <strong>{{ t('settingsUi.marketCurrent') }}</strong>
                  <pre class="market-preview">{{ update.current.preview || t('settingsUi.noPreview') }}</pre>
                </div>
                <div>
                  <strong>{{ t('settingsUi.marketLatest') }}</strong>
                  <pre class="market-preview">{{ update.entry.preview || t('settingsUi.noPreview') }}</pre>
                </div>
              </div>
              <label v-if="!update.upToDate && !update.current.repoSkill" class="market-trust">
                <input v-model="trustUpdate" type="checkbox" />
                {{ t('settingsUi.marketTrustUpdate') }}
              </label>
              <small v-if="!update.upToDate && update.current.repoSkill" class="market-repo-note">{{ t('settingsUi.repoInstallTrust') }}</small>
              <div class="market-actions">
                <button class="secondary-button" type="button" @click="backToBrowse">{{ t('settingsUi.marketBack') }}</button>
                <button v-if="!update.upToDate" class="primary-button" type="button" :disabled="busy" @click="applyUpdate">
                  {{ busy ? t('common.loading') : t('settingsUi.marketApplyUpdate') }}
                </button>
              </div>
            </template>

            <template v-else>
              <p v-if="loading" class="settings-note">{{ t('common.loading') }}</p>
              <p v-else-if="!selectedSourceId" class="settings-note">{{ t('settingsUi.marketSelectSource') }}</p>
              <p v-else-if="!entries.length" class="settings-note">{{ t('settingsUi.marketNoEntries') }}</p>
              <div v-else class="market-entries">
                <div class="market-entry-list">
                  <button
                    v-for="entry in entries"
                    :key="entry.token"
                    class="market-entry"
                    :class="{ picked: selectedEntry?.token === entry.token }"
                    type="button"
                    @click="selectedToken = entry.token"
                  >
                    <strong>{{ entry.name }}</strong>
                    <small>{{ entry.description || t('settingsUi.noDescription') }}</small>
                    <small class="market-entry-path">{{ entry.relativePath || '/' }}</small>
                    <span v-if="entry.repoMode" class="market-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                    <span v-if="!entry.validName" class="market-invalid">{{ t('settingsUi.marketInvalidName') }}</span>
                  </button>
                </div>
                <div v-if="selectedEntry" class="market-entry-detail">
                  <div class="market-entry-head">
                    <h3>{{ selectedEntry.name }}</h3>
                    <span v-if="selectedEntry.repoMode" class="market-repo-badge">{{ t('settingsUi.repoSkillBadge') }}</span>
                    <span v-if="selectedEntry.version">v{{ selectedEntry.version }}</span>
                  </div>
                  <p>{{ selectedEntry.description || t('settingsUi.noDescription') }}</p>
                  <div class="market-meta">
                    <span>{{ shortHash(selectedEntry.contentHash) }}</span>
                    <span>{{ t('settingsUi.fileCount', { count: selectedEntry.fileCount }) }}</span>
                    <span class="market-url">{{ selectedEntry.relativePath || '/' }}</span>
                  </div>
                  <div v-if="selectedEntry.risk?.labels?.length" class="market-risk">
                    <strong>{{ t('settingsUi.risk') }}</strong>
                    <span class="settings-pills">
                      <span v-for="label in selectedEntry.risk.labels" :key="label" class="settings-pill" :class="{ deny: selectedEntry.risk.level === 'high' }">{{ riskLabel(label) }}</span>
                    </span>
                    <small>{{ t('settingsUi.riskAdvisory') }}</small>
                  </div>
                  <pre class="market-preview">{{ selectedEntry.preview || t('settingsUi.noPreview') }}</pre>
                  <label v-if="selectedEntry.repoMode" class="market-trust">
                    <input v-model="installRepo" type="checkbox" />
                    {{ t('settingsUi.repoInstall') }}
                  </label>
                  <small v-if="selectedEntry.repoMode && installRepo" class="market-repo-note">{{ t('settingsUi.repoInstallHint') }}</small>
                  <label v-if="!selectedEntry.repoMode || !installRepo" class="market-trust">
                    <input v-model="trustInstall" type="checkbox" />
                    {{ t('settingsUi.marketTrustInstall') }}
                  </label>
                  <small v-if="selectedEntry.repoMode && installRepo" class="market-repo-note">{{ t('settingsUi.repoInstallTrust') }}</small>
                  <button class="primary-button" type="button" :disabled="busy || !selectedEntry.validName" @click="install">
                    {{ busy ? t('common.loading') : t('settingsUi.marketInstall') }}
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { locale, t, translateError } from '../../i18n.js'
import { relativeTime } from '../../skillLibrary.js'

const props = defineProps({
  api: { type: Object, required: true },
  policy: { type: Object, default: () => ({}) },
  initialSkill: { type: Object, default: null },
})
const emit = defineEmits(['close', 'done'])

const sources = ref([])
const selectedSourceId = ref('')
const entries = ref([])
const selectedToken = ref('')
const showAdd = ref(false)
const form = reactive({ url: '', ref: '', subpath: '' })
const armedRemoveId = ref('')
const loading = ref(false)
const busy = ref(false)
const checking = ref(false)
const checked = ref(false)
const updates = ref([])
const error = ref('')
const view = ref('browse')
const update = ref(null)
const trustInstall = ref(props.policy?.untrustedByDefault === false)
const trustUpdate = ref(false)
const installRepo = ref(true)

const selectedEntry = computed(() => (
  entries.value.find(entry => entry.token === selectedToken.value) || entries.value[0] || null
))

watch(selectedEntry, (entry) => {
  installRepo.value = entry?.repoMode === true
}, { immediate: true })

function relative(iso) {
  return relativeTime(iso, locale.value)
}

function shortHash(value) {
  return String(value || '').slice(0, 12)
}

const MARKET_ERROR_KEYS = {
  SKILL_MARKET_SOURCE_IN_USE: 'marketSourceInUse',
  SKILL_MARKET_SOURCE_INVALID: 'marketSourceInvalid',
  SKILL_MARKET_FETCH_FAILED: 'marketFetchFailed',
  SKILL_MARKET_GIT_MISSING: 'marketGitMissing',
  SKILL_MARKET_NO_SKILLS: 'marketNoSkills',
  SKILL_MARKET_ENTRY_EXPIRED: 'marketEntryExpired',
  SKILL_MARKET_ENTRY_NOT_FOUND: 'marketEntryNotFound',
  SKILL_MARKET_ENTRY_INVALID: 'marketEntryInvalid',
  SKILL_NAME_CONFLICT: 'nameConflict',
  SKILL_NETWORK_DENIED: 'networkDenied',
}

function errorText(caught) {
  const code = String(caught?.message || caught?.code || '')
  const key = MARKET_ERROR_KEYS[code]
  if (key) return t(`settingsUi.${key}`)
  return translateError(caught) || t('settingsUi.errorGeneric')
}

const RISK_LABELS = {
  'dynamic-command': 'riskDynamicCommand',
  'shell-tools': 'riskShellTools',
  hooks: 'riskHooks',
  scripts: 'riskScripts',
  network: 'riskNetwork',
  'file-write': 'riskFileWrite',
  'external-paths': 'riskExternalPaths',
  'large-assets': 'riskLargeAssets',
  'nonstandard-fields': 'riskNonstandardFields',
  unreadable: 'riskUnreadable',
}

function riskLabel(label) {
  const key = RISK_LABELS[label]
  return key ? t(`settingsUi.${key}`) : label
}

async function loadSources() {
  try {
    sources.value = await props.api.marketSources()
    if (selectedSourceId.value && !sources.value.some(source => source.id === selectedSourceId.value)) {
      selectedSourceId.value = ''
      entries.value = []
      selectedToken.value = ''
    }
  } catch (caught) {
    error.value = errorText(caught)
  }
}

async function addSource() {
  if (busy.value || !form.url) return
  busy.value = true
  error.value = ''
  try {
    const source = await props.api.marketAddSource({
      url: form.url,
      ref: form.ref,
      subpath: form.subpath,
    })
    showAdd.value = false
    form.url = ''
    form.ref = ''
    form.subpath = ''
    selectedSourceId.value = source.id
    await loadSources()
    await loadEntries(source.id)
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

async function selectSource(source) {
  if (busy.value || loading.value) return
  selectedSourceId.value = source.id
  view.value = 'browse'
  update.value = null
  entries.value = []
  selectedToken.value = ''
  await loadEntries(source.id)
}

async function loadEntries(sourceId) {
  loading.value = true
  error.value = ''
  try {
    const result = await props.api.marketPreview({ sourceId })
    entries.value = result.entries || []
    selectedToken.value = entries.value[0]?.token || ''
    const source = sources.value.find(item => item.id === sourceId)
    if (source && result.source) Object.assign(source, result.source)
  } catch (caught) {
    entries.value = []
    error.value = errorText(caught)
  } finally {
    loading.value = false
  }
}

async function removeSource(source) {
  if (busy.value) return
  if (armedRemoveId.value !== source.id) {
    armedRemoveId.value = source.id
    return
  }
  armedRemoveId.value = ''
  busy.value = true
  error.value = ''
  try {
    await props.api.marketRemoveSource({ sourceId: source.id })
    if (selectedSourceId.value === source.id) {
      selectedSourceId.value = ''
      entries.value = []
      selectedToken.value = ''
    }
    await loadSources()
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

async function checkUpdates() {
  if (checking.value) return
  checking.value = true
  checked.value = true
  error.value = ''
  try {
    const result = await props.api.marketCheckUpdates()
    updates.value = result.updates || []
    await loadSources()
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    checking.value = false
  }
}

async function install() {
  if (busy.value || !selectedEntry.value?.validName) return
  busy.value = true
  error.value = ''
  try {
    const detail = await props.api.marketInstall({
      token: selectedEntry.value.token,
      trust: trustInstall.value,
      repo: selectedEntry.value.repoMode === true && installRepo.value,
    })
    emit('done', detail)
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

async function openUpdate(skill) {
  view.value = 'update'
  update.value = null
  error.value = ''
  loading.value = true
  try {
    update.value = await props.api.marketPreviewUpdate({ skillId: skill.id })
    trustUpdate.value = false
  } catch (caught) {
    error.value = errorText(caught)
    view.value = 'browse'
  } finally {
    loading.value = false
  }
}

function backToBrowse() {
  view.value = 'browse'
  update.value = null
  error.value = ''
}

async function applyUpdate() {
  if (busy.value || !update.value || update.value.upToDate) return
  busy.value = true
  error.value = ''
  try {
    const detail = await props.api.marketApplyUpdate({
      skillId: update.value.skillId,
      token: update.value.entry.token,
      trust: trustUpdate.value,
    })
    emit('done', detail)
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) emit('close')
}

function handleKey(event) {
  if (event.key === 'Escape') close()
}

onMounted(async () => {
  window.addEventListener('keydown', handleKey)
  document.body.style.overflow = 'hidden'
  await loadSources()
  if (props.initialSkill?.id) await openUpdate(props.initialSkill)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.market-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 0.42); }
.market-dialog { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 12px; width: min(1040px, 100%); max-height: min(820px, calc(100vh - 48px)); padding: 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg); box-shadow: 0 24px 70px rgb(0 0 0 / 0.45); }
.market-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.market-head h2 { margin: 0; font-size: 18px; }
.market-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.market-close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.market-close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.market-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; min-height: 0; }
.market-sources { display: grid; gap: 8px; align-content: start; overflow: auto; padding-right: 4px; }
.market-source-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.market-source-head strong { font-size: 12px; color: var(--text-soft); }
.market-source-form { display: grid; gap: 6px; padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--surface) 55%, var(--bg)); }
.market-source-form input, .market-source-row input { height: 30px; min-width: 0; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.market-source-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.market-source { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; padding: 9px; border: 1px solid transparent; border-radius: 9px; cursor: pointer; }
.market-source:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.market-source.picked { border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.market-source-copy { display: grid; gap: 2px; min-width: 0; }
.market-source-copy strong { font-size: 12px; }
.market-source-copy small { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.market-source-remove { align-self: start; border: 0; background: transparent; color: var(--faint); font: inherit; font-size: 11px; cursor: pointer; }
.market-source-remove:hover { color: #f2555a; }
.market-check { width: 100%; }
.market-updates { display: grid; gap: 4px; }
.market-update-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.market-update-row strong { font-size: 12px; }
.market-update-row small { color: #f5a524; font-size: 10px; font-weight: 650; }
.market-main { display: grid; gap: 10px; align-content: start; min-width: 0; overflow: auto; padding-right: 4px; }
.market-entries { display: grid; grid-template-columns: minmax(180px, 0.72fr) minmax(0, 1.28fr); gap: 12px; min-height: 0; }
.market-entry-list { display: grid; gap: 4px; align-content: start; overflow: auto; }
.market-entry { display: grid; gap: 2px; padding: 8px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer; }
.market-entry:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.market-entry.picked { border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.market-entry strong { font-size: 12px; }
.market-entry small { color: var(--muted); font-size: 11px; }
.market-entry-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px !important; }
.market-invalid { color: #f5a524; font-size: 10px; }
.market-repo-badge { justify-self: start; padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-text); font-size: 10px; font-weight: 650; }
.market-repo-note { color: var(--muted); font-size: 11px; line-height: 1.45; }
.market-entry-detail { display: grid; gap: 8px; align-content: start; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 55%, var(--bg)); }
.market-entry-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.market-entry-head h3 { margin: 0; font-size: 14px; }
.market-entry-detail p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.market-meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted); font-size: 10px; }
.market-meta span { padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--text) 7%, transparent); }
.market-url { overflow-wrap: anywhere; }
.market-risk { display: grid; gap: 5px; padding: 8px; border-radius: 8px; background: color-mix(in srgb, #f5a524 10%, transparent); }
.market-risk strong { font-size: 11px; }
.market-risk small { color: var(--muted); font-size: 10px; }
.market-preview { margin: 0; max-height: 220px; overflow: auto; padding: 9px 10px; border-radius: 8px; background: #101416; color: var(--text-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.market-trust { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.market-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.market-compare > div { display: grid; gap: 5px; min-width: 0; }
.market-compare strong { font-size: 11px; color: var(--text-soft); }
.market-actions { display: flex; justify-content: flex-end; gap: 8px; }
.market-back { justify-self: start; border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
.market-up-to-date { padding: 1px 8px; border-radius: 99px; background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; font-size: 10px; font-weight: 650; }
@media (max-width: 860px) {
  .market-layout { grid-template-columns: 1fr; }
  .market-entries { grid-template-columns: 1fr; }
  .market-compare { grid-template-columns: 1fr; }
}
</style>
