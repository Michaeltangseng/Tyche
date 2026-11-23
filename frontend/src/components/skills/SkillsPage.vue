<template>
  <div class="skills-page">
    <header class="skills-head">
      <div>
        <h1>Skills</h1>
        <p>{{ t('settingsUi.skillsLead') }}</p>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="skill-banner-close" :aria-label="t('common.cancel')" @click="error = ''">×</button>
    </p>
    <p v-if="inventory.storeError" class="settings-note">{{ t('settingsUi.storeError') }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>

    <template v-if="api">
      <div class="skills-stats">
        <article class="skill-stat">
          <div class="skill-stat-icon cyan"><span>◈</span></div>
          <div class="skill-stat-body">
            <strong>{{ t('settingsUi.statsPlatform') }}</strong>
            <span class="skill-stat-number">{{ platformSkills.length }}</span>
            <small>{{ platformSkills.length ? t('settingsUi.statsSharedCount', { count: platformSkills.length }) : t('settingsUi.statsNone') }}</small>
          </div>
        </article>
        <article class="skill-stat">
          <div class="skill-stat-icon blue"><span>&lt;/&gt;</span></div>
          <div class="skill-stat-body">
            <strong>{{ t('settingsUi.statsNative') }}</strong>
            <span class="skill-stat-number">{{ nativeSkills.length }}</span>
            <small>{{ nativeBreakdown || t('settingsUi.statsNone') }}</small>
          </div>
        </article>
        <article class="skill-stat">
          <div class="skill-stat-icon green"><span>◎</span></div>
          <div class="skill-stat-body">
            <strong>{{ t('settingsUi.statsAgents') }}</strong>
            <span class="skill-stat-number">{{ nativeAgents.length }}</span>
            <div class="skill-stat-agents">
              <img v-for="agent in nativeAgents.slice(0, 4)" :key="agent" :src="agentLogo(agent)" :alt="agentLabel(agent)" />
              <small v-if="!nativeAgents.length">{{ t('settingsUi.statsNone') }}</small>
            </div>
          </div>
        </article>
        <article class="skill-stat">
          <div class="skill-stat-icon violet"><span>{{ view === 'native' ? '↗' : '▣' }}</span></div>
          <div class="skill-stat-body">
            <strong>{{ view === 'native' ? t('settingsUi.statsWeekly') : t('settingsUi.statsSources') }}</strong>
            <span class="skill-stat-number">{{ view === 'native' ? weeklyNew : marketSources.length }}</span>
            <small>{{ view === 'native'
              ? t('settingsUi.statsWeeklyLead')
              : (marketSources.length ? t('settingsUi.statsSourcesCount', { count: marketSources.length }) : t('settingsUi.statsAddSource')) }}</small>
          </div>
        </article>
      </div>

      <nav class="skills-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="view === 'platform'" :class="{ active: view === 'platform' }" @click="view = 'platform'">
          {{ t('settingsUi.tabPlatform') }} <span>{{ platformSkills.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="view === 'native'" :class="{ active: view === 'native' }" @click="view = 'native'">
          {{ t('settingsUi.tabNative') }} <span>{{ nativeSkills.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="view === 'market'" :class="{ active: view === 'market' }" @click="switchToMarket">
          {{ t('settingsUi.tabMarket') }}
        </button>
      </nav>

      <section v-if="view === 'platform'">
        <p v-if="loading" class="settings-note">{{ t('common.loading') }}</p>
        <div v-else-if="!platformSkills.length" class="skills-empty">
          <svg class="skills-empty-art" viewBox="0 0 200 160" aria-hidden="true">
            <g fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round">
              <path d="M100 18 L140 40 L100 62 L60 40 Z" />
              <path d="M60 40 L60 84 L100 106 L100 62" />
              <path d="M140 40 L140 84 L100 106" />
              <path d="M78 72 L78 58 M78 58 L92 58" />
              <path d="M118 78 L118 64" />
            </g>
            <g fill="currentColor" opacity=".55">
              <circle cx="52" cy="70" r="2.5" />
              <circle cx="150" cy="66" r="2.5" />
            </g>
          </svg>
          <h2>{{ t('settingsUi.emptyPlatformTitle') }}</h2>
          <p>{{ t('settingsUi.emptyPlatformLead') }}</p>
          <div class="skills-empty-actions">
            <button type="button" class="skills-empty-card" @click="openCreate">
              <span class="skills-empty-icon">✎</span>
              <span><strong>{{ t('settingsUi.emptyCreateTitle') }}</strong><small>{{ t('settingsUi.emptyCreateLead') }}</small></span>
              <em>›</em>
            </button>
            <button type="button" class="skills-empty-card" :disabled="!nativeSkills.length" @click="view = 'native'">
              <span class="skills-empty-icon">↑</span>
              <span><strong>{{ t('settingsUi.emptyPromoteTitle') }}</strong><small>{{ t('settingsUi.emptyPromoteLead', { count: nativeSkills.length }) }}</small></span>
              <em>›</em>
            </button>
            <button type="button" class="skills-empty-card" @click="switchToMarket">
              <span class="skills-empty-icon">▣</span>
              <span><strong>{{ t('settingsUi.emptyMarketTitle') }}</strong><small>{{ t('settingsUi.emptyMarketLead') }}</small></span>
              <em>›</em>
            </button>
          </div>
        </div>
        <div v-else>
          <div class="skills-toolbar">
            <input v-model="query" type="search" :placeholder="t('settingsUi.searchNative')" :aria-label="t('settingsUi.searchNative')" />
            <button class="secondary-button" type="button" :disabled="busy" @click="openCreate">+ {{ t('settingsUi.newSkill') }}</button>
          </div>
          <p v-if="!platformVisible.length" class="settings-note">{{ t('settingsUi.skillsEmpty') }}</p>
          <div v-else class="skills-table-wrap">
          <table class="skills-table">
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
                <td>
                  <div class="skill-name-cell">
                    <span class="skill-avatar" :class="avatarTone(skill.name)">{{ skill.name.slice(0, 1).toUpperCase() }}</span>
                    <div>
                      <strong>{{ skill.name }}</strong>
                      <small>{{ skill.description || t('settingsUi.noDescription') }}</small>
                    </div>
                    <span class="skill-category" :class="skillCategoryKey(skill)">{{ categoryLabel(skillCategoryKey(skill)) }}</span>
                  </div>
                </td>
                <td class="skills-source-cell">
                  <span class="skills-source" :class="skill.source">{{ sourceText(skill) }}</span>
                  <small v-if="skill.version">v{{ skill.version }}</small>
                </td>
                <td class="skills-updated-cell"><small>{{ relative(skill.updatedAt) }}</small></td>
                <td class="skills-actions-cell">
                  <button v-if="skill.sourceKind === 'shared'" class="skills-row-action" type="button" :disabled="busy" @click="openEdit(skill)">{{ t('settingsUi.updateSkill') }}</button>
                  <button class="skills-row-action danger" type="button" :disabled="busy" @click="openDelete(skill)">{{ t('settingsUi.deleteSkill') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </section>

      <section v-else-if="view === 'native'">
        <div class="skills-subtabs" role="tablist">
          <button
            v-for="agent in nativeAgents"
            :key="agent"
            type="button"
            :class="{ active: nativeAgent === agent }"
            @click="setNativeAgent(agent)"
          >{{ agentLabel(agent) }} <span>{{ nativeSkillsFor(agent).length }}</span></button>
          <button type="button" :class="{ active: nativeAgent === 'all' }" @click="setNativeAgent('all')">{{ t('settingsUi.nativeAll') }} <span>{{ nativeSkills.length }}</span></button>
        </div>

        <div class="skills-toolbar">
          <input v-model="query" type="search" :placeholder="t('settingsUi.searchNative')" :aria-label="t('settingsUi.searchNative')" />
          <label class="skills-select">
            <span>{{ t('settingsUi.filterCategory') }}</span>
            <select v-model="categoryFilter">
              <option value="all">{{ t('settingsUi.nativeAll') }}</option>
              <option v-for="key in SKILL_CATEGORY_KEYS" :key="key" :value="key">{{ categoryLabel(key) }}</option>
            </select>
          </label>
          <label class="skills-select">
            <span>{{ t('settingsUi.updated') }}</span>
            <select v-model="sortMode">
              <option value="updated">{{ t('settingsUi.sortUpdated') }}</option>
              <option value="name">{{ t('settingsUi.sortName') }}</option>
            </select>
          </label>
          <button v-if="selectedNative.length" class="primary-button" type="button" :disabled="busy" @click="promoteSelected">{{ t('settingsUi.promoteSelected', { count: selectedNative.length }) }}</button>
          <div class="skills-view-toggle">
            <button type="button" :class="{ active: viewMode === 'list' }" :aria-label="t('settingsUi.viewList')" :title="t('settingsUi.viewList')" @click="viewMode = 'list'">☰</button>
            <button type="button" :class="{ active: viewMode === 'grid' }" :aria-label="t('settingsUi.viewGrid')" :title="t('settingsUi.viewGrid')" @click="viewMode = 'grid'">▦</button>
          </div>
        </div>

        <p v-if="!nativeFiltered.length" class="settings-note">{{ t('settingsUi.skillsEmpty') }}</p>

        <div v-else-if="viewMode === 'list'" class="skills-table-wrap">
          <table class="skills-table">
            <thead>
              <tr>
                <th class="skills-check"><input type="checkbox" :checked="allPageSelected" :aria-label="t('settingsUi.nativeAll')" @change="toggleSelectAll" /></th>
                <th>Skill</th>
                <th>{{ t('settingsUi.filterCategory') }}</th>
                <th>{{ t('settingsUi.source') }}</th>
                <th>{{ t('settingsUi.updated') }}</th>
                <th class="skills-actions-head">{{ t('settingsUi.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="skill in nativePaged" :key="skill.id">
                <td class="skills-check"><input v-model="selectedNative" type="checkbox" :value="skill.id" :aria-label="skill.name" /></td>
                <td>
                  <div class="skill-name-cell">
                    <span class="skill-avatar" :class="avatarTone(skill.name)">{{ skill.name.slice(0, 1).toUpperCase() }}</span>
                    <div>
                      <strong>{{ skill.name }}</strong>
                      <small>{{ skill.description || t('settingsUi.noDescription') }}</small>
                    </div>
                  </div>
                </td>
                <td><span class="skill-category" :class="skillCategoryKey(skill)">{{ categoryLabel(skillCategoryKey(skill)) }}</span></td>
                <td class="skills-source-cell"><i class="skill-source-dot" />{{ agentLabel(skill.originKind) }}</td>
                <td class="skills-updated-cell"><small>{{ relative(skill.updatedAt) }}</small></td>
                <td class="skills-actions-cell">
                  <button class="skill-promote" type="button" :disabled="busy" @click="promoteOne(skill)">↑ {{ t('settingsUi.promote') }}</button>
                  <button class="skill-more" type="button" :title="t('settingsUi.openSource')" @click="reveal(skill)">…</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="skills-grid">
          <article v-for="skill in nativePaged" :key="skill.id" class="skill-card">
            <header>
              <span class="skill-avatar" :class="avatarTone(skill.name)">{{ skill.name.slice(0, 1).toUpperCase() }}</span>
              <div><strong>{{ skill.name }}</strong><small>{{ agentLabel(skill.originKind) }}</small></div>
              <span class="skill-category" :class="skillCategoryKey(skill)">{{ categoryLabel(skillCategoryKey(skill)) }}</span>
            </header>
            <p>{{ skill.description || t('settingsUi.noDescription') }}</p>
            <footer>
              <small>{{ relative(skill.updatedAt) }}</small>
              <button class="skill-promote" type="button" :disabled="busy" @click="promoteOne(skill)">↑ {{ t('settingsUi.promote') }}</button>
            </footer>
          </article>
        </div>

        <footer v-if="nativeFiltered.length" class="skills-pager">
          <span>{{ t('settingsUi.marketTotal', { count: nativeFiltered.length }) }} · {{ t('settingsUi.marketSelected', { count: selectedNative.length }) }}</span>
          <div>
            <button type="button" :disabled="nativePage <= 1" @click="nativePage -= 1">‹</button>
            <button
              v-for="page in pageCount"
              :key="page"
              type="button"
              :class="{ active: page === nativePage }"
              @click="nativePage = page"
            >{{ page }}</button>
            <button type="button" :disabled="nativePage >= pageCount" @click="nativePage += 1">›</button>
          </div>
        </footer>
      </section>

      <section v-else>
        <div class="market-hero">
          <div class="market-hero-icon">⌘</div>
          <div class="market-hero-copy">
            <strong>{{ t('settingsUi.marketHeroTitle') }}</strong>
            <small>{{ t('settingsUi.marketHeroLead') }}</small>
          </div>
          <form class="market-hero-form" @submit.prevent="addMarketSource">
            <input v-model.trim="sourceForm.url" type="url" :placeholder="t('settingsUi.marketHeroUrl')" />
            <button class="primary-button" type="submit" :disabled="marketBusy || !sourceForm.url">+ {{ t('settingsUi.marketHeroAdd') }}</button>
          </form>
        </div>
        <div class="market-advanced">
          <button type="button" class="link-button" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '−' : '+' }} ref / subpath</button>
          <template v-if="showAdvanced">
            <input v-model.trim="sourceForm.ref" type="text" :placeholder="t('settingsUi.marketRefPlaceholder')" />
            <input v-model.trim="sourceForm.subpath" type="text" :placeholder="t('settingsUi.marketSubpathPlaceholder')" />
          </template>
        </div>

        <p v-if="marketError" class="settings-banner" role="alert">{{ marketError }}</p>

        <section class="market-catalog">
          <div class="market-section-head">
            <h3>{{ t('settingsUi.marketCatalogTitle') }}</h3>
            <span>{{ t('settingsUi.marketTotal', { count: catalog.length }) }}</span>
          </div>
          <div class="skills-chips">
            <button type="button" :class="{ active: catalogCategory === 'all' }" @click="catalogCategory = 'all'">{{ t('settingsUi.nativeAll') }}</button>
            <button
              v-for="key in SKILL_CATEGORY_KEYS"
              :key="key"
              type="button"
              :class="{ active: catalogCategory === key }"
              @click="catalogCategory = key"
            >{{ categoryLabel(key) }}</button>
          </div>
          <p v-if="catalogLoading" class="settings-note">{{ t('common.loading') }}</p>
          <p v-else-if="!catalogVisible.length" class="settings-note">{{ t('settingsUi.marketNoEntries') }}</p>
          <div v-else class="skills-grid">
            <article v-for="entry in catalogVisible" :key="entry.id" class="skill-card market-card">
              <header>
                <span class="skill-avatar" :class="avatarTone(entry.name)">{{ entry.name.slice(0, 1).toUpperCase() }}</span>
                <div><strong>{{ entry.name }}</strong><small>{{ entry.source }}</small></div>
                <span v-if="entry.installed" class="skill-installed">{{ t('settingsUi.marketInstalled') }}</span>
              </header>
              <p>{{ entry.description || t('settingsUi.noDescription') }}</p>
              <footer>
                <span class="skill-category" :class="skillCategoryKey(entry)">{{ categoryLabel(skillCategoryKey(entry)) }}</span>
                <button v-if="entry.installed" class="skills-row-action danger" type="button" :disabled="marketBusy" @click="removeCatalog(entry)">{{ t('settingsUi.marketRemove') }}</button>
                <button v-else class="skill-promote" type="button" :disabled="marketBusy" @click="installCatalog(entry)">{{ t('settingsUi.marketAdd') }}</button>
              </footer>
            </article>
          </div>
        </section>

        <div class="market-section-head">
          <h3>{{ t('settingsUi.marketMySources') }}</h3>
        </div>

        <div v-if="marketSources.length" class="skills-subtabs market-sources" role="tablist">
          <button
            v-for="source in marketSources"
            :key="source.id"
            type="button"
            :class="{ active: marketSourceId === source.id }"
            :title="source.url"
            @click="selectMarketSource(source)"
          >{{ source.ref || 'HEAD' }}<template v-if="source.subpath"> · {{ source.subpath }}</template></button>
          <button class="chip danger" type="button" @click="removeMarketSource">{{ t('settingsUi.marketRemoveSource') }}</button>
        </div>
        <p v-else class="settings-note">{{ t('settingsUi.marketNoSources') }}</p>

        <div v-if="marketSources.length" class="skills-chips">
          <button type="button" :class="{ active: marketCategory === 'all' }" @click="marketCategory = 'all'">{{ t('settingsUi.nativeAll') }}</button>
          <button
            v-for="key in SKILL_CATEGORY_KEYS"
            :key="key"
            type="button"
            :class="{ active: marketCategory === key }"
            @click="marketCategory = key"
          >{{ categoryLabel(key) }}</button>
        </div>

        <p v-if="marketLoading" class="settings-note">{{ t('common.loading') }}</p>
        <p v-else-if="marketSources.length && !marketVisible.length" class="settings-note">{{ t('settingsUi.marketNoEntries') }}</p>
        <div v-else-if="marketVisible.length" class="skills-grid">
          <article v-for="entry in marketVisible" :key="entry.token" class="skill-card market-card">
            <header>
              <span class="skill-avatar" :class="avatarTone(entry.name)">{{ entry.name.slice(0, 1).toUpperCase() }}</span>
              <div><strong>{{ entry.name }}</strong><small>{{ entry.relativePath || '/' }}</small></div>
              <span v-if="entry.installed" class="skill-installed">{{ t('settingsUi.marketInstalled') }}</span>
            </header>
            <p>{{ entry.description || t('settingsUi.noDescription') }}</p>
            <footer>
              <span class="skill-category" :class="skillCategoryKey(entry)">{{ categoryLabel(skillCategoryKey(entry)) }}</span>
              <span v-if="entry.repoMode" class="skill-category other">{{ t('settingsUi.repoSkillBadge') }}</span>
              <template v-if="entry.installed">
                <button v-if="!entry.upToDate" class="skill-promote" type="button" :disabled="marketBusy" @click="updateEntry(entry)">{{ t('settingsUi.marketUpdate') }}</button>
                <button class="skills-row-action danger" type="button" :disabled="marketBusy" @click="removeEntry(entry)">{{ t('settingsUi.marketRemove') }}</button>
              </template>
              <button v-else class="skill-promote" type="button" :disabled="marketBusy || !entry.validName" @click="installEntry(entry)">{{ t('settingsUi.marketAdd') }}</button>
            </footer>
          </article>
        </div>
      </section>
    </template>

    <SkillEditorDialog v-if="editorOpen && api" :api="api" :skill="editingSkill" @close="editorOpen = false" @done="afterEditor" />
    <SkillDeleteDialog v-if="deleteOpen && api && deleteTarget" :api="api" :skill="deleteTarget" @close="deleteOpen = false" @done="afterDelete" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { agentLogo } from '../../catalog.js'
import { locale, t, translateError } from '../../i18n.js'
import {
  avatarTone,
  relativeTime,
  SKILL_CATEGORY_KEYS,
  skillCategoryKey,
  sourceLabelKey,
} from '../../skillLibrary.js'
import SkillDeleteDialog from './SkillDeleteDialog.vue'
import SkillEditorDialog from './SkillEditorDialog.vue'

const props = defineProps({
  api: { type: Object, default: null },
})

const PAGE_SIZE = 8

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

const nativeAgent = ref('all')
const categoryFilter = ref('all')
const sortMode = ref('updated')
const viewMode = ref('list')
const nativePage = ref(1)
const selectedNative = ref([])

const catalog = ref([])
const catalogCategory = ref('all')
const catalogLoading = ref(false)
const marketSources = ref([])
const marketSourceId = ref('')
const marketEntries = ref([])
const marketCategory = ref('all')
const marketLoading = ref(false)
const marketBusy = ref(false)
const marketError = ref('')
const showAdvanced = ref(false)
const sourceForm = reactive({ url: '', ref: '', subpath: '' })

const skills = computed(() => inventory.value.skills || [])
const agentLabelsAll = computed(() => inventory.value.agentLabels || {})
const platformSkills = computed(() => skills.value.filter(skill => skill.source !== 'native'))
const platformVisible = computed(() => filterByQuery(platformSkills.value))
const nativeSkills = computed(() => skills.value.filter(skill => skill.source === 'native'))
const nativeAgents = computed(() => [...new Set(nativeSkills.value.map(skill => skill.originKind).filter(Boolean))])
const nativeBreakdown = computed(() => nativeAgents.value
  .map(agent => `${agentLabel(agent)} ${nativeSkillsFor(agent).length}`)
  .join(' · '))
const weeklyNew = computed(() => {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000
  return platformSkills.value.filter(skill => {
    const at = new Date(skill.updatedAt || 0).getTime()
    return Number.isFinite(at) && at >= since
  }).length
})

const nativeFiltered = computed(() => {
  const needle = String(query.value || '').trim().toLowerCase()
  const rows = nativeSkills.value.filter((skill) => {
    if (nativeAgent.value !== 'all' && skill.originKind !== nativeAgent.value) return false
    if (categoryFilter.value !== 'all' && skillCategoryKey(skill) !== categoryFilter.value) return false
    if (!needle) return true
    return `${skill.name || ''} ${skill.description || ''}`.toLowerCase().includes(needle)
  })
  return rows.sort((left, right) => {
    if (sortMode.value === 'name') return left.name.localeCompare(right.name)
    return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
  })
})
const pageCount = computed(() => Math.max(1, Math.ceil(nativeFiltered.value.length / PAGE_SIZE)))
const nativePaged = computed(() => nativeFiltered.value.slice((nativePage.value - 1) * PAGE_SIZE, nativePage.value * PAGE_SIZE))
const allPageSelected = computed(() => nativePaged.value.length > 0 && nativePaged.value.every(skill => selectedNative.value.includes(skill.id)))
const marketVisible = computed(() => marketEntries.value.filter(entry => (
  marketCategory.value === 'all' || skillCategoryKey(entry) === marketCategory.value
)))
const catalogVisible = computed(() => catalog.value.filter(entry => (
  catalogCategory.value === 'all' || skillCategoryKey(entry) === catalogCategory.value
)))

function filterByQuery(rows) {
  const needle = String(query.value || '').trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(row => `${row.name || ''} ${row.description || ''}`.toLowerCase().includes(needle))
}

watch([nativeAgent, categoryFilter, sortMode, query], () => { nativePage.value = 1 })
watch(pageCount, (count) => { if (nativePage.value > count) nativePage.value = count })

function agentLabel(agent) {
  return agentLabelsAll.value[agent] || agent
}

function categoryLabel(key) {
  return t(`settingsUi.category.${key}`)
}

function sourceText(skill) {
  if (skill.source === 'native') return t('settingsUi.sourceNativeOf', { agent: agentLabel(skill.originKind) })
  return t(sourceLabelKey(skill.source))
}

function relative(iso) {
  return relativeTime(iso, locale.value)
}

function nativeSkillsFor(agent) {
  return nativeSkills.value.filter(skill => skill.originKind === agent)
}

function setNativeAgent(agent) {
  nativeAgent.value = agent
  selectedNative.value = []
}

function toggleSelectAll() {
  const ids = nativePaged.value.map(skill => skill.id)
  selectedNative.value = allPageSelected.value
    ? selectedNative.value.filter(id => !ids.includes(id))
    : [...new Set([...selectedNative.value, ...ids])]
}

const ERROR_KEYS = {
  SKILL_LIBRARY_UNAVAILABLE: 'skillsUnavailable',
  SKILL_NAME_CONFLICT: 'nameConflict',
  SKILL_CONFIRM_MISMATCH: 'confirmMismatch',
  SKILL_TOO_LARGE: 'skillTooLarge',
  SKILL_UNREADABLE: 'skillUnreadable',
  SKILL_UNSAFE: 'skillUnsafe',
  SKILL_SELECTION_INVALID: 'skillSelectionInvalid',
  SKILL_IMPORT_INVALID: 'skillUnsafe',
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
    selectedNative.value = selectedNative.value.filter(id => skills.value.some(skill => skill.id === id))
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    loading.value = false
  }
}

function switchToMarket() {
  view.value = 'market'
  if (!catalog.value.length) loadCatalog()
  if (!marketSources.value.length) {
    loadMarketSources()
  } else if (marketSourceId.value && !marketEntries.value.length) {
    loadMarketEntries(marketSourceId.value)
  }
}

async function loadCatalog() {
  if (typeof props.api?.marketCatalog !== 'function') return
  catalogLoading.value = true
  try {
    catalog.value = await props.api.marketCatalog()
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    catalogLoading.value = false
  }
}

async function installCatalog(entry) {
  if (marketBusy.value) return
  marketBusy.value = true
  marketError.value = ''
  try {
    await props.api.marketInstallCatalog({ id: entry.id })
    await Promise.all([loadCatalog(), load()])
  } catch (caught) {
    marketError.value = errorText(caught)
  } finally {
    marketBusy.value = false
  }
}

function removeCatalog(entry) {
  if (!entry.installedId) return
  deleteTarget.value = { id: entry.installedId, name: entry.name }
  deleteOpen.value = true
}

async function loadMarketSourceList() {
  if (typeof props.api?.marketSources !== 'function') return
  try {
    marketSources.value = await props.api.marketSources()
    if (!marketSources.value.some(source => source.id === marketSourceId.value)) {
      marketSourceId.value = marketSources.value[0]?.id || ''
    }
  } catch {
    /* the stat card stays at zero when the list cannot be read */
  }
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
    sourceForm.url = ''
    sourceForm.ref = ''
    sourceForm.subpath = ''
    showAdvanced.value = false
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
  if (marketBusy.value || !entry.installedId) return
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

async function promoteOne(skill) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await props.api.promote({ id: skill.id })
    view.value = 'platform'
    await load()
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

async function promoteSelected() {
  if (busy.value || !selectedNative.value.length) return
  busy.value = true
  error.value = ''
  try {
    for (const id of [...selectedNative.value]) {
      await props.api.promote({ id })
    }
    selectedNative.value = []
    view.value = 'platform'
    await load()
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
}

async function reveal(skill) {
  if (busy.value) return
  busy.value = true
  try {
    await props.api.reveal({ id: skill.id })
  } catch (caught) {
    error.value = errorText(caught)
  } finally {
    busy.value = false
  }
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

async function afterEditor() {
  editorOpen.value = false
  editingSkill.value = null
  await load()
}

async function afterDelete(result) {
  deleteOpen.value = false
  deleteTarget.value = null
  if (!result?.removed) return
  await load()
  if (view.value === 'market') {
    await loadCatalog()
    if (marketSourceId.value && marketEntries.value.length) await loadMarketEntries(marketSourceId.value)
  }
}

let unsubscribe = null
onMounted(() => {
  load()
  loadMarketSourceList()
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
.skills-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.skills-head h1 { margin: 0; font-size: 34px; letter-spacing: -0.02em; }
.skills-head p { margin: 8px 0 0; color: var(--text-soft); font-size: 14px; }

.skills-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.skill-stat { display: flex; gap: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
.skill-stat-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; font-size: 15px; }
.skill-stat-icon.cyan { background: color-mix(in srgb, #2dd4bf 18%, transparent); color: #2dd4bf; }
.skill-stat-icon.blue { background: color-mix(in srgb, #60a5fa 18%, transparent); color: #60a5fa; }
.skill-stat-icon.green { background: color-mix(in srgb, #34d399 18%, transparent); color: #34d399; }
.skill-stat-icon.violet { background: color-mix(in srgb, #a78bfa 18%, transparent); color: #a78bfa; }
.skill-stat-body { display: grid; gap: 2px; min-width: 0; }
.skill-stat-body > strong { color: var(--text-soft); font-size: 12px; font-weight: 600; }
.skill-stat-number { font-size: 30px; font-weight: 650; line-height: 1.15; }
.skill-stat-body small { color: var(--muted); font-size: 11px; }
.skill-stat-agents { display: flex; align-items: center; gap: 4px; min-height: 20px; }
.skill-stat-agents img { width: 20px; height: 20px; border-radius: 50%; background: var(--bg); }

.skills-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--border); }
.skills-tabs button { position: relative; height: 40px; padding: 0 2px; border: 0; background: transparent; color: var(--text-soft); font: inherit; font-size: 14px; cursor: pointer; }
.skills-tabs button span { margin-left: 6px; padding: 0 7px; border-radius: 99px; background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--muted); font-size: 10px; }
.skills-tabs button.active { color: #2dd4bf; }
.skills-tabs button.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: #2dd4bf; }

.skills-subtabs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.skills-subtabs button { height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.skills-subtabs button.active { border-color: #2dd4bf; background: color-mix(in srgb, #2dd4bf 10%, transparent); color: #2dd4bf; }
.skills-subtabs button span { margin-left: 5px; color: var(--muted); font-size: 10px; }

.skills-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.skills-toolbar > input { flex: 1; min-width: 220px; height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
.skills-select { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
.skills-select select { height: 34px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.skills-view-toggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; }
.skills-view-toggle button { width: 30px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.skills-view-toggle button.active { background: color-mix(in srgb, #2dd4bf 12%, transparent); color: #2dd4bf; }

.skills-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
.skills-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.skills-table th { padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; font-weight: 600; text-align: left; }
.skills-table td { padding: 11px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); vertical-align: middle; }
.skills-table tbody tr:last-child td { border-bottom: 0; }
.skills-table tbody tr:hover { background: color-mix(in srgb, var(--text) 3%, transparent); }
.skills-check { width: 34px; text-align: center; }
.skills-check input { accent-color: #2dd4bf; }
.skills-actions-head, .skills-actions-cell { white-space: nowrap; text-align: right; }
.skills-row-action { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; padding: 0 4px; }
.skills-row-action:disabled { color: var(--faint); cursor: default; }
.skills-row-action.danger { color: #f2555a; }

.skill-name-cell { display: flex; align-items: center; gap: 12px; min-width: 0; }
.skill-name-cell > div { display: grid; gap: 2px; min-width: 0; }
.skill-name-cell strong { font-size: 13px; }
.skill-name-cell small { overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.skill-avatar { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border-radius: 9px; color: #0b1518; font-size: 14px; font-weight: 750; }
.skill-avatar.cyan { background: #67e8f9; }
.skill-avatar.blue { background: #93c5fd; }
.skill-avatar.violet { background: #c4b5fd; }
.skill-avatar.pink { background: #f9a8d4; }
.skill-avatar.orange { background: #fdba74; }
.skill-avatar.green { background: #86efac; }
.skill-avatar.amber { background: #fcd34d; }

.skill-category { flex: none; padding: 2px 9px; border-radius: 6px; font-size: 10px; font-weight: 600; }
.skill-category.data { background: color-mix(in srgb, #60a5fa 16%, transparent); color: #93c5fd; }
.skill-category.efficiency { background: color-mix(in srgb, #a78bfa 16%, transparent); color: #c4b5fd; }
.skill-category.design { background: color-mix(in srgb, #2dd4bf 16%, transparent); color: #5eead4; }
.skill-category.research { background: color-mix(in srgb, #f59e0b 16%, transparent); color: #fcd34d; }
.skill-category.creative { background: color-mix(in srgb, #ec4899 16%, transparent); color: #f9a8d4; }
.skill-category.development { background: color-mix(in srgb, #34d399 16%, transparent); color: #6ee7b7; }
.skill-category.other { background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--muted); }

.skills-source-cell { white-space: nowrap; }
.skills-source-cell small { margin-left: 6px; color: var(--muted); font-size: 10px; }
.skills-source { color: var(--muted); }
.skills-source.shared { color: var(--accent-text); }
.skills-source.market { color: #b07cff; }
.skill-source-dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #2dd4bf; }
.skills-updated-cell { white-space: nowrap; color: var(--muted); }

.skill-promote { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--text-soft); font: inherit; font-size: 11px; cursor: pointer; }
.skill-promote:hover { border-color: #2dd4bf; color: #2dd4bf; }
.skill-promote:disabled { opacity: .5; cursor: default; }
.skill-more { width: 28px; height: 28px; margin-left: 4px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
.skill-more:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }

.skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.skill-card { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
.skill-card header { display: flex; align-items: center; gap: 10px; }
.skill-card header > div { display: grid; gap: 2px; min-width: 0; }
.skill-card header strong { font-size: 13px; }
.skill-card header small { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.skill-card p { margin: 0; min-height: 34px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.skill-card footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.skill-card footer small { color: var(--faint); font-size: 10px; }
.skill-card footer button { margin-left: auto; }
.skill-installed { margin-left: auto; padding: 2px 8px; border-radius: 99px; background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; font-size: 10px; font-weight: 650; }

.skills-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 2px 0; color: var(--muted); font-size: 11px; }
.skills-pager > div { display: flex; gap: 4px; }
.skills-pager button { min-width: 28px; height: 28px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-soft); font: inherit; font-size: 11px; cursor: pointer; }
.skills-pager button.active { border-color: #2dd4bf; color: #2dd4bf; }
.skills-pager button:disabled { opacity: .4; cursor: default; }

.skills-empty { display: grid; justify-items: center; gap: 8px; padding: 46px 24px 30px; border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent); border-radius: 14px; text-align: center; }
.skills-empty-art { width: 150px; height: 120px; color: #2dd4bf; filter: drop-shadow(0 0 18px color-mix(in srgb, #2dd4bf 45%, transparent)); }
.skills-empty h2 { margin: 4px 0 0; font-size: 24px; }
.skills-empty > p { margin: 0; color: var(--muted); font-size: 13px; }
.skills-empty-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; width: min(900px, 100%); margin-top: 20px; }
.skills-empty-card { display: flex; align-items: center; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface) 60%, var(--bg)); color: var(--text); text-align: left; font: inherit; cursor: pointer; }
.skills-empty-card:disabled { opacity: .55; cursor: default; }
.skills-empty-card:hover:not(:disabled) { border-color: color-mix(in srgb, #2dd4bf 45%, var(--border)); }
.skills-empty-icon { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 50%; background: color-mix(in srgb, #2dd4bf 14%, transparent); color: #2dd4bf; font-size: 17px; }
.skills-empty-card > span:nth-child(2) { display: grid; gap: 3px; }
.skills-empty-card strong { font-size: 13px; }
.skills-empty-card small { color: var(--muted); font-size: 11px; }
.skills-empty-card em { margin-left: auto; color: var(--muted); font-style: normal; }

.market-hero { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 18px 20px; border: 1px solid color-mix(in srgb, #2dd4bf 35%, var(--border)); border-radius: 12px; background: linear-gradient(100deg, color-mix(in srgb, #0e2b2a 78%, var(--bg)), color-mix(in srgb, #123a3a 52%, var(--bg))); }
.market-hero-icon { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 10px; background: #2dd4bf; color: #06201e; font-size: 20px; font-weight: 800; }
.market-hero-copy { display: grid; gap: 4px; }
.market-hero-copy strong { font-size: 18px; }
.market-hero-copy small { color: color-mix(in srgb, var(--text-soft) 80%, #2dd4bf); font-size: 12px; }
.market-hero-form { display: flex; flex: 1; gap: 8px; min-width: 320px; justify-content: flex-end; }
.market-hero-form input { flex: 1; min-width: 200px; height: 38px; padding: 0 12px; border: 1px solid color-mix(in srgb, #2dd4bf 40%, var(--border)); border-radius: 8px; background: color-mix(in srgb, #06181a 45%, var(--surface)); color: var(--text); font: inherit; }
.market-advanced { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.market-advanced input { height: 30px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 11px; }
.link-button { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
.market-catalog { display: grid; gap: 8px; }
.market-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0 2px; }
.market-section-head h3 { margin: 0; font-size: 14px; }
.market-section-head span { color: var(--muted); font-size: 11px; }
.market-sources { margin-top: 4px; }
.market-recommended { display: grid; gap: 8px; }
.market-recommended h3 { margin: 0; font-size: 14px; }
.market-recommended-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.market-recommended-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 60%, var(--bg)); }
.market-recommended-card > div { display: grid; gap: 2px; }
.market-recommended-card strong { font-size: 12px; }
.market-recommended-card small { color: var(--muted); font-size: 11px; }
.skills-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
.skills-chips button { height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 99px; background: transparent; color: var(--text-soft); font: inherit; font-size: 11px; cursor: pointer; }
.skills-chips button.active { border-color: #2dd4bf; background: color-mix(in srgb, #2dd4bf 12%, transparent); color: #2dd4bf; }
.market-card footer .skill-category { margin-right: auto; }
.chip.danger { border-color: color-mix(in srgb, #f2555a 45%, var(--border)); color: #f2555a; }
.skill-banner-close { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; margin-left: auto; }
.settings-banner { align-items: center; }
@media (max-width: 1100px) {
  .skills-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
  .skills-empty-actions { grid-template-columns: 1fr; }
  .market-hero-form { min-width: 0; }
}
</style>
