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
              <button class="secondary-button" type="button" @click="connectorOpen = !connectorOpen">
                {{ t('systemSettings.extensions') }}
              </button>
              <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                <RefreshOutline :class="{ spinning: refreshing }" />
                {{ t('installer.refresh') }}
              </button>
            </div>
          </header>

          <ConnectorPackagesPanel v-if="connectorOpen" @close="connectorOpen = false" />

          <div class="settings-subtabs" role="tablist" :aria-label="t('systemSettings.agentPageTitle')">
            <button type="button" role="tab" :aria-selected="agentTab === 'local'" :class="{ active: agentTab === 'local' }" @click="agentTab = 'local'">
              {{ t('systemSettings.localAgents', { count: localAgents.length }) }}
            </button>
            <button type="button" role="tab" :aria-selected="agentTab === 'cloud'" :class="{ active: agentTab === 'cloud' }" @click="agentTab = 'cloud'">
              {{ t('systemSettings.cloudAgentsCount', { count: cloudAgents.length }) }}
            </button>
            <button type="button" role="tab" :aria-selected="agentTab === 'mcp'" :class="{ active: agentTab === 'mcp' }" @click="agentTab = 'mcp'">
              {{ t('systemSettings.mcpTab') }}
            </button>
          </div>

          <CloudAgentBridgePanel v-if="agentTab === 'cloud'" :controller="cloudAgentBridges" />
          <McpServersPanel v-else-if="agentTab === 'mcp'" />

          <div v-else class="agent-table">
            <div class="agent-table-head">
              <span>Agent</span>
              <span>{{ t('systemSettings.columnStatus') }}</span>
              <span>{{ t('systemSettings.columnVersion') }}</span>
              <span>{{ t('systemSettings.columnAuth') }}</span>
              <span>{{ t('systemSettings.columnActions') }}</span>
            </div>
            <article
              v-for="agent in localAgents"
              :key="agent.kind"
              class="agent-table-item settings-agent-card"
              :class="{ focused: focusedAgentKind === agent.kind }"
              @click="selectSettingsAgent(agent.kind)"
            >
              <div class="agent-table-row">
                <span class="agent-identity">
                  <img :src="agent.logo" :alt="agent.label" />
                  <strong>{{ agent.label }}</strong>
                </span>
                <span class="agent-state" :class="displayedState(agent).tone" :title="displayedState(agent).description || ''">
                  <i class="status-dot" aria-hidden="true" />
                  {{ displayedState(agent).label }}
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
                  <button
                    v-else-if="agent.installed"
                    class="settings-row-button"
                    type="button"
                    :disabled="testingKind === agent.kind"
                    @click="testAgent(agent)"
                  >
                    {{ testingKind === agent.kind ? t('systemSettings.testing') : t('systemSettings.quickTest') }}
                  </button>
                </span>
              </div>
              <p v-if="installConfirmKind === agent.kind" class="install-inline">{{ t('installer.confirmHint') }}</p>
              <p v-else-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-inline">{{ installerPhaseLabel }}</p>
              <p v-else-if="testResults[agent.kind]" class="install-inline" :class="{ 'test-ok': testResults[agent.kind].available, 'test-warn': !testResults[agent.kind].available }">{{ testResultText(testResults[agent.kind]) }}</p>
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
          :open-agent-detail="openAgentDetail"
        />
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  BarChartOutline,
  ChevronBackOutline,
  InformationCircleOutline,
  OptionsOutline,
  PersonOutline,
  RefreshOutline,
  SearchOutline,
  ShieldCheckmarkOutline,
  SparklesOutline,
  SwapHorizontalOutline,
  TerminalOutline,
} from '@vicons/ionicons5'
import SettingsPages from './SettingsPages.vue'
import { desktopApi } from '../desktop.js'
import CloudAgentBridgePanel from './CloudAgentBridgePanel.vue'
import ConnectorPackagesPanel from './ConnectorPackagesPanel.vue'
import McpServersPanel from './McpServersPanel.vue'

const props = defineProps({
  controller: { type: Object, required: true },
  skillApi: { type: Object, default: null },
})

const {
  agentCatalogGroups,
  agentState,
  closeSettings,
  cloudAgentBridges,
  focusedAgentKind,
  installConfirmKind,
  installerBusy,
  installerPhaseLabel,
  installerState,
  openAgentDetail,
  refreshAgents,
  refreshing,
  requestInstall,
  selectSystemSettingsSection,
  setThemePreference,
  systemSettingsSection,
  t,
  themePreference,
} = props.controller

function selectSettingsAgent(kind) {
  focusedAgentKind.value = kind
}

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
      { id: 'about', labelKey: 'systemSettings.about', icon: InformationCircleOutline },
    ],
  },
]

const agentTab = ref('local')
const connectorOpen = ref(false)
const testingKind = ref('')
const testResults = ref({})
const searchShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl F'

function agentRank(agent) {
  if (agent?.ready) return 0
  if (agent?.installed) return 1
  return 2
}

function sortAgents(agents) {
  return [...agents].sort((left, right) => (
    agentRank(left) - agentRank(right)
    || String(left.label || left.kind).localeCompare(String(right.label || right.kind))
  ))
}

const localAgents = computed(() => sortAgents((agentCatalogGroups.value || [])
  .filter(group => group.id !== 'cloud')
  .flatMap(group => group.agents || [])))
const cloudAgents = computed(() => sortAgents((agentCatalogGroups.value || [])
  .filter(group => group.id === 'cloud')
  .flatMap(group => group.agents || [])))
const installedAgentKinds = computed(() => localAgents.value
  .filter(agent => agent.installed && agent.ready && !agent.custom)
  .map(agent => agent.kind))

function versionOf(agent) {
  const value = String(agent?.resolvedVersion || agent?.version || '').trim()
  return value || '—'
}

function authOf(agent) {
  if (!agent?.installed) return '—'
  const test = testResults.value[agent.kind]
  const source = test?.availabilitySource || agent.availabilitySource
  if (source === 'hermes-provider-unconfigured') return t('systemSettings.authNeedsProvider')
  const state = test?.credentialState || agent.credentialState
  if (state === 'ready') return t('systemSettings.authReady')
  if (state === 'missing') return t('systemSettings.authMissing')
  return t('systemSettings.authUnknown')
}

function displayedState(agent) {
  const test = testResults.value[agent.kind]
  if (!test) return agentState(agent)
  if (test.available) return { label: t('agent.ready'), tone: 'ready' }
  if (test.availabilitySource === 'hermes-provider-unconfigured') {
    return { label: t('agent.needsProvider'), tone: 'warning' }
  }
  if (test.credentialState === 'missing') return { label: t('agent.needsLogin'), tone: 'warning' }
  return { label: t('agent.unavailable'), tone: 'warning' }
}

async function testAgent(agent) {
  if (testingKind.value) return
  const api = desktopApi()?.agentInstaller
  if (!api?.test) return
  testingKind.value = agent.kind
  const cleared = { ...testResults.value }
  delete cleared[agent.kind]
  testResults.value = cleared
  try {
    const result = await api.test(agent.kind)
    testResults.value = { ...testResults.value, [agent.kind]: result }
    await refreshAgents()
  } catch {
    testResults.value = { ...testResults.value, [agent.kind]: { available: false, error: true } }
  } finally {
    testingKind.value = ''
  }
}

function testResultText(result) {
  if (result?.error) return t('systemSettings.testError')
  if (result?.available) return t('systemSettings.testPassed')
  if (result?.availabilitySource === 'hermes-provider-unconfigured') {
    return t('systemSettings.testNeedsProvider')
  }
  if (result?.credentialState === 'missing') return t('systemSettings.testNeedsLogin')
  return t('systemSettings.testFailed')
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
.install-inline.test-ok { color: #3ecf8e; }
.install-inline.test-warn { color: #f5a524; }
</style>
