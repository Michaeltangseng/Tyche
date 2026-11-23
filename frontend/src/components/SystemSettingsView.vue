<template>
  <section class="system-settings-page" :aria-label="t('systemSettings.title')">
    <div class="system-settings-body">
      <aside class="settings-nav-column">
        <button class="settings-back" type="button" @click="closeSettings">
          <ChevronBackOutline />
          {{ t('systemSettings.title') }}
        </button>
        <label class="settings-search">
          <SearchOutline />
          <input type="search" :placeholder="t('systemSettings.search')" :aria-label="t('systemSettings.search')" />
          <kbd>{{ searchShortcut }}</kbd>
        </label>
        <nav class="settings-tabs" role="tablist" :aria-label="t('systemSettings.title')">
          <div v-for="group in groups" :key="group.id" class="settings-nav-group">
            <p class="settings-nav-label">{{ t(group.labelKey) }}</p>
            <button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              role="tab"
              class="settings-nav-item"
              :aria-selected="systemSettingsSection === item.id"
              :class="{ active: systemSettingsSection === item.id }"
              @click="selectSystemSettingsSection(item.id)"
            >
              <component :is="item.icon" />
              {{ t(item.labelKey) }}
            </button>
          </div>
        </nav>
      </aside>

      <div class="settings-main">
        <section v-if="systemSettingsSection === 'agents'" class="settings-agent-page" :aria-label="t('systemSettings.agentPageTitle')">
          <header class="settings-page-head">
            <div>
              <h1>{{ t('systemSettings.agentPageTitle') }}</h1>
              <p>{{ t('systemSettings.agentPageHint') }}</p>
            </div>
            <div class="settings-page-actions">
              <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                <RefreshOutline :class="{ spinning: refreshing }" />
                {{ t('installer.refresh') }}
              </button>
            </div>
          </header>

          <div class="settings-subtabs" role="tablist" :aria-label="t('systemSettings.agentPageTitle')">
            <button type="button" role="tab" :aria-selected="agentTab === 'local'" :class="{ active: agentTab === 'local' }" @click="agentTab = 'local'">
              {{ t('systemSettings.localAgents', { count: localAgents.length }) }}
            </button>
            <button v-if="cloudAgents.length" type="button" role="tab" :aria-selected="agentTab === 'cloud'" :class="{ active: agentTab === 'cloud' }" @click="agentTab = 'cloud'">
              {{ t('systemSettings.cloudAgentsCount', { count: cloudAgents.length }) }}
            </button>
          </div>

          <div class="agent-table">
            <div class="agent-table-head">
              <span>Agent</span>
              <span>{{ t('systemSettings.columnStatus') }}</span>
              <span>{{ t('systemSettings.columnVersion') }}</span>
              <span>{{ t('systemSettings.columnAuth') }}</span>
              <span>{{ t('systemSettings.columnActions') }}</span>
            </div>
            <article
              v-for="agent in visibleAgents"
              :key="agent.kind"
              class="agent-table-item settings-agent-card"
              :class="{ focused: focusedAgentKind === agent.kind }"
            >
              <div class="agent-table-row">
                <span class="agent-identity">
                  <img :src="agent.logo" :alt="agent.label" />
                  <strong>{{ agent.label }}</strong>
                </span>
                <span class="agent-state" :class="agentState(agent).tone">
                  <i class="status-dot" aria-hidden="true" />
                  {{ agentState(agent).label }}
                </span>
                <span class="agent-mono">{{ versionOf(agent) }}</span>
                <span class="agent-mono">{{ authOf(agent) }}</span>
                <span class="settings-agent-actions">
                  <button
                    v-if="!agent.installed && agent.installSupported"
                    class="settings-row-button"
                    type="button"
                    :disabled="installerBusy"
                    @click="requestInstall(agent)"
                  >
                    {{ installConfirmKind === agent.kind ? t('installer.confirmAction') : t('installer.install') }}
                  </button>
                </span>
              </div>
              <p v-if="installConfirmKind === agent.kind" class="install-inline">{{ t('installer.confirmHint') }}</p>
              <p v-else-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-inline">{{ installerPhaseLabel }}</p>
            </article>
          </div>
        </section>
        <SettingsPages
          v-else
          :section="systemSettingsSection"
          :set-theme-preference="setThemePreference"
          :theme-preference="themePreference"
          :skill-api="skillApi"
          :installed-agent-kinds="installedAgentKinds"
        />
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  BarChartOutline,
  ChevronBackOutline,
  InformationCircleOutline,
  OptionsOutline,
  PersonOutline,
  PulseOutline,
  RefreshOutline,
  SearchOutline,
  ShieldCheckmarkOutline,
  SparklesOutline,
  SwapHorizontalOutline,
  TerminalOutline,
} from '@vicons/ionicons5'
import SettingsPages from './SettingsPages.vue'

const props = defineProps({
  controller: { type: Object, required: true },
  skillApi: { type: Object, default: null },
})

const {
  agentCatalogGroups,
  agentState,
  closeSettings,
  focusedAgentKind,
  installConfirmKind,
  installerBusy,
  installerPhaseLabel,
  installerState,
  refreshAgents,
  refreshing,
  requestInstall,
  selectSystemSettingsSection,
  setThemePreference,
  systemSettingsSection,
  t,
  themePreference,
} = props.controller

const groups = [
  {
    id: 'core',
    labelKey: 'systemSettings.groupCore',
    items: [
      { id: 'agents', labelKey: 'systemSettings.agentPageTitle', icon: TerminalOutline },
      { id: 'skills', labelKey: 'systemSettings.skills', icon: SparklesOutline },
      { id: 'orchestration', labelKey: 'systemSettings.orchestration', icon: SwapHorizontalOutline },
      { id: 'permissions', labelKey: 'systemSettings.permissions', icon: ShieldCheckmarkOutline },
    ],
  },
  {
    id: 'app',
    labelKey: 'systemSettings.groupApp',
    items: [
      { id: 'general', labelKey: 'systemSettings.general', icon: OptionsOutline },
      { id: 'usage', labelKey: 'systemSettings.usage', icon: BarChartOutline },
    ],
  },
  {
    id: 'other',
    labelKey: 'systemSettings.groupOther',
    items: [
      { id: 'preferences', labelKey: 'systemSettings.preferences', icon: PersonOutline },
      { id: 'diagnostics', labelKey: 'systemSettings.diagnostics', icon: PulseOutline },
      { id: 'about', labelKey: 'systemSettings.about', icon: InformationCircleOutline },
    ],
  },
]

const agentTab = ref('local')
const searchShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl F'

const localAgents = computed(() => (agentCatalogGroups.value || [])
  .filter(group => group.id !== 'cloud')
  .flatMap(group => group.agents || []))
const cloudAgents = computed(() => (agentCatalogGroups.value || [])
  .filter(group => group.id === 'cloud')
  .flatMap(group => group.agents || []))
const installedAgentKinds = computed(() => localAgents.value
  .filter(agent => agent.installed && !agent.custom)
  .map(agent => agent.kind))
const visibleAgents = computed(() => agentTab.value === 'cloud' ? cloudAgents.value : localAgents.value)

watch(cloudAgents, (agents) => {
  if (!agents.length && agentTab.value === 'cloud') agentTab.value = 'local'
})

function versionOf(agent) {
  const value = String(agent?.resolvedVersion || agent?.version || '').trim()
  return value || '—'
}

function authOf(agent) {
  if (!agent?.installed) return '—'
  if (agent.credentialState === 'ready') return t('systemSettings.authReady')
  if (agent.credentialState === 'missing') return t('systemSettings.authMissing')
  return '—'
}
</script>

<style scoped>
.settings-nav-item {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-soft);
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  text-align: left;
  cursor: pointer;
}
.settings-nav-item svg { width: 16px; height: 16px; flex: none; }
.settings-page-actions :deep(svg) { width: 15px; height: 15px; }
.settings-page-actions .secondary-button,
.settings-page-actions .primary-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
}
</style>
