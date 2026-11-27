<template>
  <section class="agent-home home-dashboard" :data-home-mode="homeMode">
    <header class="home-dashboard-header home-hero">
      <div class="home-hero-copy">
        <h1>{{ t('home.dashboardTitle') }}</h1>
        <p>{{ t('home.dashboardSubtitle') }}</p>
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
            <button v-if="recentChats.length > 5" class="home-text-button" type="button" @click="recentExpanded = !recentExpanded">
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
              <span class="home-chat-stack" :data-count="String(facesFor(row.chat).length)" aria-hidden="true">
                <span v-for="member in facesFor(row.chat)" :key="member.key" class="home-chat-face">
                  <RoomMascot :mascot="member.mascot" />
                </span>
              </span>
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
            <li v-for="agent in localAgents" :key="agent.kind">
              <i :data-tone="agent.tone" />
              <span>{{ agent.label }}</span>
              <em :data-tone="agent.tone">{{ agent.status }}</em>
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
          </header>
          <div class="home-activity-head">
            <p class="home-activity-count">{{ activityHeadline }}</p>
            <p v-if="activity.delta !== null" class="home-activity-delta" :data-up="activity.delta >= 0 ? 'true' : 'false'">
              {{ activity.delta > 0 ? `+${activity.delta}%` : `${activity.delta}%` }}
            </p>
          </div>
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
import { computed, ref, watch } from 'vue'
import {
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  FolderOpenOutline,
  GridOutline,
  RefreshOutline,
  SettingsOutline,
  SparklesOutline,
  TimeOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { chatMemberFaces, recentRoomChats } from '../chat-faces.js'
import { relativeTime, weeklyActivity } from '../home-activity.js'
import { t } from '../i18n.js'
import RoomMascot from './RoomMascot.vue'

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
const visibleChats = computed(() => (recentExpanded.value ? recentChats.value : recentChats.value.slice(0, 5)))
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
const activityHeadline = computed(() => {
  if (activity.value.today) return t('home.activityToday', { count: activity.value.today })
  if (activity.value.current) return t('home.activityWeek', { count: activity.value.current })
  return t('home.activityEmpty')
})

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

function facesFor(chat) {
  return chatMemberFaces(chat)
}

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
    : t('home.workspaceSummary', {
        agents: readyCount.value,
        conversations: visibleGroups.value.length,
      })
))
const setupGuideMessage = computed(() => t('setupGuide.detectBody'))
</script>
