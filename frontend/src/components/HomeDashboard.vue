<template>
  <section class="agent-home home-dashboard" :data-home-mode="homeMode">
    <header class="home-dashboard-header home-hero">
      <div class="home-hero-copy">
        <h1>{{ t('home.dashboardTitle') }}</h1>
        <!-- <p>{{ t('home.dashboardSubtitle') }}</p> -->
      </div>
      <div
        class="home-workspace-state"
        :class="{ attention: homeNeedsAttention, discovering }"
        role="status"
      >
        <RefreshOutline v-if="discovering" class="spinning" />
        <WarningOutline v-else-if="homeNeedsAttention" />
        <CheckmarkCircleOutline v-else />
        <span>{{ homeWorkspaceSummary }}</span>
      </div>
    </header>

    <section
      v-if="awaitingDecisionGates.length"
      class="home-attention"
      aria-labelledby="home-attention-title"
    >
      <header class="home-attention-header">
        <span class="attention-dot" aria-hidden="true" />
        <h2 id="home-attention-title">{{ t('home.attentionTitle') }}</h2>
        <small>{{ awaitingDecisionGates.length }}</small>
      </header>
      <div class="home-attention-list">
        <button
          v-for="gate in awaitingDecisionGates"
          :key="gate.gateId"
          class="home-attention-item"
          type="button"
          @click="$emit('select-group', gate.groupId)"
        >
          <img :src="agentLogo(gate.agentKind, theme)" alt="" />
          <span class="home-attention-copy">
            <strong>{{ t('home.attentionItem', { agent: agentLabel(gate.agentKind), type: t(`humanGate.type.${gate.type}`) }) }}</strong>
            <small>{{ gate.groupName }}</small>
          </span>
          <span class="home-attention-action">
            {{ t('home.attentionOpen') }}
            <ChevronForwardOutline aria-hidden="true" />
          </span>
        </button>
      </div>
    </section>

    <section v-if="showRecoveryGuide" class="home-recovery-notice" aria-live="polite">
      <WarningOutline />
      <div>
        <h2>{{ t('home.recoveryTitle') }}</h2>
        <p>{{ t('home.recoveryBody') }}</p>
      </div>
      <button class="secondary-button compact" type="button" @click="$emit('open-agent-manager')">
        <SettingsOutline />
        {{ t('home.openSettings') }}
      </button>
    </section>

    <div v-if="!showSetupGuide" class="home-actions">
      <button class="home-action" type="button" data-tone="chat" @click="$emit('create-chat')">
        <span class="home-action-icon"><ChatbubblesOutline /></span>
        <span>
          <strong>{{ t('home.newChat') }}</strong>
          <small>{{ t('home.newChatHint') }}</small>
        </span>
        <ChevronForwardOutline />
      </button>
      <button class="home-action" type="button" data-tone="agents" @click="$emit('open-agent-manager')">
        <span class="home-action-icon"><GridOutline /></span>
        <span>
          <strong>{{ t('home.manageAgents') }}</strong>
          <small>{{ t('home.manageAgentsHint') }}</small>
        </span>
        <ChevronForwardOutline />
      </button>
      <button
        class="home-action"
        type="button"
        data-tone="folder"
        :disabled="!workspacePath"
        :title="workspacePath ? t('home.openWorkspaceHint') : t('home.openWorkspaceMissing')"
        @click="revealSelected"
      >
        <span class="home-action-icon"><FolderOpenOutline /></span>
        <span>
          <strong>{{ t('home.openWorkspace') }}</strong>
          <small>{{ workspacePath ? (selectedRow?.room?.workspace_label || t('home.openWorkspaceHint')) : t('home.openWorkspaceMissing') }}</small>
        </span>
        <ChevronForwardOutline />
      </button>
    </div>

    <div v-if="!showSetupGuide" class="home-dashboard-grid">
      <div class="home-main-column">
        <section class="home-panel home-recent-panel">
          <header class="home-panel-header">
            <h2><TimeOutline />{{ t('home.recentTitle') }}</h2>
            <button v-if="recentChats.length > 8" class="home-text-button" type="button" @click="recentExpanded = !recentExpanded">
              {{ t(recentExpanded ? 'home.showLess' : 'home.viewAll') }}
              <ChevronForwardOutline />
            </button>
          </header>
          <div v-if="recentChats.length" class="home-recent-list">
            <div
              v-for="row in visibleChats"
              :key="row.chat.id"
              class="home-recent-item"
              :data-selected="row.chat.id === selectedKey ? 'true' : undefined"
              role="button"
              tabindex="0"
              @click="selectedKey = row.chat.id"
              @keydown.enter.prevent="selectedKey = row.chat.id"
            >
              <span class="home-recent-copy">
                <strong>{{ chatTitle(row) }}</strong>
                <small>{{ chatMeta(row) }}</small>
              </span>
              <time v-if="chatWhen(row)">{{ chatWhen(row) }}</time>
              <button class="home-recent-open" type="button" :aria-label="t('home.openThisChat')" @click.stop="openChat(row)">
                <ChevronForwardOutline />
              </button>
            </div>
          </div>
          <div v-else class="home-panel-empty">
            <ChatbubblesOutline />
            <p>{{ t('home.recentEmpty') }}</p>
          </div>
          <footer class="home-continue">
            <SparklesOutline />
            <span>{{ t('home.continueBanner') }}</span>
            <button class="home-continue-button" type="button" :disabled="!selectedRow" @click="selectedRow && openChat(selectedRow)">
              {{ t('home.startWork') }}
              <ChevronForwardOutline />
            </button>
          </footer>
        </section>
      </div>

      <aside class="home-side-column">
        <section class="home-panel home-side-panel">
          <header class="home-panel-header">
            <h2>{{ t('home.agentStatus') }}</h2>
            <small :data-tone="agentsNeedCare ? 'warn' : 'ready'">{{ agentsNeedCare ? t('home.agentsNeedCare', { count: agentsNeedCare }) : t('home.agentsReady') }}</small>
          </header>
          <ul v-if="localAgents.length" class="home-agent-status">
            <li
              v-for="agent in localAgents"
              :key="agent.kind"
              :role="agent.tone === 'ready' ? undefined : 'button'"
              :tabindex="agent.tone === 'ready' ? undefined : 0"
              @click="agent.tone === 'ready' ? undefined : emit('open-agent-manager', agent.kind)"
              @keydown.enter.prevent="emit('open-agent-manager', agent.kind)"
            >
              <i :data-tone="agent.tone" />
              <span>{{ agent.label }}</span>
              <em v-if="agent.tone === 'ready'" data-tone="ready">{{ agent.status }}</em>
              <button v-else class="home-configure" type="button" @click.stop="emit('open-agent-manager', agent.kind)">
                {{ t('home.configureAgent') }}
              </button>
            </li>
          </ul>
          <button class="home-text-button" type="button" @click="$emit('open-agent-manager')">
            {{ t('home.viewAgents') }}
            <ChevronForwardOutline />
          </button>
        </section>

        <section class="home-panel home-side-panel">
          <header class="home-panel-header">
            <h2>{{ t('home.activityTitle') }}</h2>
            <p v-if="activity.delta !== null" class="home-activity-delta" :data-up="activity.delta >= 0 ? 'true' : 'false'">
              {{ t('home.activityVersus', { percent: `${activity.delta > 0 ? '+' : ''}${activity.delta}%` }) }}
            </p>
          </header>
          <svg class="home-activity-chart" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" :aria-label="t('home.activityTitle')">
            <defs>
              <linearGradient id="home-activity-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#7eb0ff" stop-opacity="0.42" />
                <stop offset="1" stop-color="#7eb0ff" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path :d="areaPath" fill="url(#home-activity-fill)" />
            <path :d="linePath" fill="none" stroke="#9ec4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="home-axis" aria-hidden="true">
            <small v-for="day in activity.days" :key="day.key">{{ t(`home.weekday.${day.weekday}`) }}</small>
          </div>
        </section>

        <section class="home-panel home-side-panel home-token-panel">
          <header class="home-panel-header">
            <h2>{{ t('home.tokenTitle') }}</h2>
            <span class="home-panel-tools">
              <strong v-if="tokenFigure">{{ tokenFigure }}</strong>
              <button class="home-icon-button" type="button" :title="t('home.viewUsage')" :aria-label="t('home.viewUsage')" @click="$emit('open-usage')">
                <OpenOutline />
              </button>
            </span>
          </header>
          <svg v-if="tokenLine" class="home-activity-chart" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" :aria-label="t('home.tokenTitle')">
            <path :d="tokenArea" fill="rgb(126 176 255 / 0.18)" />
            <path :d="tokenLine" fill="none" stroke="#9ec4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </svg>
          <div v-if="tokenDays.length" class="home-axis" aria-hidden="true">
            <small v-for="day in tokenDays" :key="`${day.date}-label`">{{ t(`home.weekday.${day.weekday}`) }}</small>
          </div>
        </section>
      </aside>
    </div>

    <section v-if="showSetupGuide" class="setup-guide" :aria-label="t('setupGuide.title')">
      <header>
        <div>
          <h2>{{ t('setupGuide.title') }}</h2>
          <p>{{ setupGuideMessage }}</p>
        </div>
      </header>
      <ol>
        <li :class="{ complete: installedCount > 0 }">
          <CheckmarkCircleOutline v-if="installedCount > 0" />
          <RefreshOutline v-else />
          <span>
            <strong>{{ t('setupGuide.detectTitle') }}</strong>
            <small>{{ t('setupGuide.detectBody') }}</small>
          </span>
        </li>
        <li :class="{ complete: readyCount > 0 }">
          <CheckmarkCircleOutline v-if="readyCount > 0" />
          <ChatbubblesOutline v-else />
          <span>
            <strong>{{ t('setupGuide.chatTitle') }}</strong>
            <small>{{ t('setupGuide.chatBody') }}</small>
          </span>
        </li>
      </ol>
      <footer>
        <button class="secondary-button" type="button" :disabled="refreshing" @click="$emit('refresh-agents')">
          <RefreshOutline :class="{ spinning: refreshing }" />
          {{ refreshing ? t('home.refreshing') : t('home.refresh') }}
        </button>
        <button class="primary-button" type="button" @click="$emit('open-agent-manager')">
          <SettingsOutline />
          {{ t('home.openSettings') }}
        </button>
      </footer>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  FolderOpenOutline,
  OpenOutline,
  GridOutline,
  RefreshOutline,
  SettingsOutline,
  SparklesOutline,
  TimeOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { recentRoomChats } from '../chat-faces.js'
import { desktopApi } from '../desktop.js'
import { localDayKey, relativeTime, weekdayOf, weeklyActivity } from '../home-activity.js'
import { t } from '../i18n.js'
import { formatTokenCount } from '../room-usage.js'

const props = defineProps({
  awaitingDecisionGates: { type: Array, default: () => [] },
  discovering: { type: Boolean, default: false },
  groups: { type: Array, required: true },
  installedCount: { type: Number, required: true },
  onboardingCompleted: { type: Boolean, required: true },
  localAgents: { type: Array, default: () => [] },
  readyAgents: { type: Array, required: true },
  refreshing: { type: Boolean, required: true },
  teamRooms: { type: Array, default: () => [] },
  theme: { type: String, required: true },
})

const emit = defineEmits([
  'create-chat',
  'open-agent-manager',
  'open-usage',
  'refresh-agents',
  'reveal-workspace',
  'select-chat',
  'select-group',
])

const readyCount = computed(() => props.readyAgents.length)
// Generic group chats are no longer a product surface; only direct chats and
// project-room conversations remain.
const visibleGroups = computed(() => props.groups.filter(group => (
  group.conversationType === 'direct' || Boolean(group.projectId)
)))
const recentChats = computed(() => recentRoomChats(props.teamRooms))
const selectedKey = ref('')
const recentExpanded = ref(false)
watch(recentChats, (rows) => {
  if (!rows.some(row => row.chat.id === selectedKey.value)) selectedKey.value = rows[0]?.chat.id || ''
}, { immediate: true })
const selectedRow = computed(() => recentChats.value.find(row => row.chat.id === selectedKey.value) || null)
const visibleChats = computed(() => (recentExpanded.value ? recentChats.value : recentChats.value.slice(0, 8)))
const workspacePath = computed(() => selectedRow.value?.room?.workspace_path || '')
const agentsNeedCare = computed(() => props.localAgents.filter(agent => agent.tone !== 'ready').length)
const activity = computed(() => weeklyActivity(recentChats.value.map(row => ({
  id: row.chat.id,
  at: row.chat.activity?.created_at || row.chat.updated_at || row.chat.created_at,
}))))

function chartPoints() {
  const days = activity.value.days
  const max = Math.max(1, ...days.map(day => day.count))
  return days.map((day, index) => {
    const x = days.length === 1 ? 0 : (index / (days.length - 1)) * 100
    const y = 30 - (day.count / max) * 24
    return [x, y]
  })
}
function curve(points) {
  if (!points.length) return ''
  const [x, y] = points[0]
  let path = `M ${x.toFixed(2)} ${y.toFixed(2)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index]
    const [x1, y1] = points[index + 1]
    const mid = (x0 + x1) / 2
    path += ` C ${mid.toFixed(2)} ${y0.toFixed(2)}, ${mid.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`
  }
  return path
}

const linePath = computed(() => curve(chartPoints()))
const areaPath = computed(() => (linePath.value ? `${linePath.value} L 100 36 L 0 36 Z` : ''))
const tokenDays = ref([])
const tokenPeak = computed(() => Math.max(1, ...tokenDays.value.map(day => day.tokens)))
const tokenToday = computed(() => tokenDays.value.find(day => day.today)?.tokens || 0)
const tokenWeek = computed(() => tokenDays.value.reduce((sum, day) => sum + day.tokens, 0))
const tokenFigure = computed(() => {
  if (tokenToday.value) return formatTokenCount(tokenToday.value)
  if (tokenWeek.value) return formatTokenCount(tokenWeek.value)
  return ''
})
const tokenLine = computed(() => {
  const days = tokenDays.value
  if (days.length < 2) return ''
  const points = days.map((day, index) => {
    const x = (index / (days.length - 1)) * 100
    const y = 30 - (day.tokens / tokenPeak.value) * 24
    return [x, y]
  })
  return curve(points)
})
const tokenArea = computed(() => (tokenLine.value ? `${tokenLine.value} L 100 36 L 0 36 Z` : ''))

onMounted(async () => {
  const report = desktopApi()?.teamRoom?.usageReport
  if (typeof report !== 'function') return
  try {
    const next = await report({ range: 'week' })
    const today = localDayKey()
    tokenDays.value = (Array.isArray(next?.series) ? next.series : []).slice(-7).map(point => {
      const parts = Object.entries(point.providerTokens || {})
        .map(([provider, tokens]) => ({ provider, tokens: Number(tokens) || 0 }))
        .filter(part => part.tokens > 0)
      return {
        date: point.date,
        weekday: weekdayOf(point.date) ?? 0,
        today: point.date === today,
        tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
        parts,
      }
    })
  } catch {
    tokenDays.value = []
  }
})

function openChat(row) {
  emit('select-chat', row.room.id, row.chat.id)
}

function revealSelected() {
  if (!workspacePath.value || !selectedRow.value) return
  emit('reveal-workspace', selectedRow.value.room.id)
}

function chatWhen(row) {
  const when = relativeTime(row.chat?.activity?.created_at || row.chat?.updated_at || row.chat?.created_at)
  return when ? t(when.key, { count: when.count }) : ''
}

function chatTitle(row) {
  return row.chat?.title || row.room?.name || ''
}

function chatMeta(row) {
  const activity = row.chat?.activity
  if (activity?.text) {
    const name = activity.author === 'user' ? t('room.you') : activity.name
    return name ? t('room.activityLine', { name, text: activity.text }) : activity.text
  }
  if (activity?.name) return activity.name
  return row.room?.workspace_label || row.room?.name || ''
}
const homeMode = computed(() => {
  if (visibleGroups.value.length) return 'workspace'
  return readyCount.value > 0 ? 'first-task' : 'setup'
})
// While the first detection runs there is no Agent data yet; that is not a
// setup problem, so no warning or setup guide until it finishes.
const homeNeedsAttention = computed(() => !props.discovering && readyCount.value === 0)
const showSetupGuide = computed(() => (
  props.onboardingCompleted && homeMode.value === 'setup' && !props.discovering
))
const showRecoveryGuide = computed(() => (
  props.onboardingCompleted && homeMode.value === 'workspace' && homeNeedsAttention.value
))
const homeWorkspaceSummary = computed(() => (
  props.discovering
    ? t('onboarding.detecting')
    : homeNeedsAttention.value
    ? t('home.setupNeeded')
    : agentsNeedCare.value
    ? t('home.workspaceSummaryCare', {
        ready: readyCount.value,
        care: agentsNeedCare.value,
      })
    : t('home.workspaceSummary', {
        agents: readyCount.value,
        conversations: visibleGroups.value.length,
      })
))
const setupGuideMessage = computed(() => t('setupGuide.detectBody'))
</script>
