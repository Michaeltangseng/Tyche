<template>
  <section class="agent-home home-dashboard" :data-home-mode="homeMode">
    <header class="home-dashboard-header">
      <div>
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

    <div v-if="!showSetupGuide" class="home-dashboard-grid">
      <section class="home-panel home-recent-panel">
        <header class="home-panel-header">
          <div>
            <h2>{{ t('home.recentTitle') }}</h2>
            <p>{{ t('home.recentSubtitle') }}</p>
          </div>
        </header>
        <div v-if="recentChats.length" class="home-recent-list">
          <button
            v-for="row in recentChats"
            :key="row.chat.id"
            class="home-recent-item"
            type="button"
            @click="$emit('select-chat', row.room.id, row.chat.id)"
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
            <ChevronForwardOutline />
          </button>
        </div>
        <div v-else class="home-panel-empty">
          <ChatbubblesOutline />
          <p>{{ t('home.recentEmpty') }}</p>
        </div>
      </section>
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
import { computed } from 'vue'
import {
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  RefreshOutline,
  SettingsOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { chatMemberFaces, recentRoomChats } from '../chat-faces.js'
import { t } from '../i18n.js'
import RoomMascot from './RoomMascot.vue'

const props = defineProps({
  awaitingDecisionGates: { type: Array, default: () => [] },
  discovering: { type: Boolean, default: false },
  groups: { type: Array, required: true },
  installedCount: { type: Number, required: true },
  onboardingCompleted: { type: Boolean, required: true },
  readyAgents: { type: Array, required: true },
  refreshing: { type: Boolean, required: true },
  teamRooms: { type: Array, default: () => [] },
  theme: { type: String, required: true },
})

defineEmits([
  'open-agent-manager',
  'refresh-agents',
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

function facesFor(chat) {
  return chatMemberFaces(chat)
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
