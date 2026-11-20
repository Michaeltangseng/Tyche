<template>
  <aside
    class="sidebar"
    :class="{ collapsed: sidebarCollapsed }"
    :inert="contentInteractionBlocked ? '' : undefined"
    :aria-hidden="contentInteractionBlocked ? 'true' : undefined"
  >
    <header class="brand-row">
      <button
        class="brand-button"
        :class="{ active: activeView === 'home' }"
        type="button"
        :title="t('nav.home')"
        :aria-label="t('nav.home')"
        :aria-current="activeView === 'home' ? 'page' : undefined"
        @click="goHome"
      >
        <img :src="productMark" alt="" />
        <span>
          <strong>Tyche</strong>
          <small>{{ t('app.localWorkspace') }}</small>
        </span>
      </button>
      <button
        class="icon-button sidebar-toggle"
        type="button"
        :title="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
        :aria-label="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
        :aria-expanded="sidebarCollapsed ? 'false' : 'true'"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >
        <ChevronForwardOutline v-if="sidebarCollapsed" />
        <ChevronBackOutline v-else />
      </button>
    </header>

    <form v-if="!sidebarCollapsed" class="sidebar-search" role="search" @submit.prevent="focusSidebarSearch">
      <SearchOutline aria-hidden="true" />
      <input
        ref="sidebarSearchInput"
        v-model="sidebarQuery"
        type="search"
        :placeholder="t('nav.searchSidebar')"
        :aria-label="t('nav.searchSidebar')"
      />
      <kbd>{{ searchShortcut }}</kbd>
    </form>

    <div v-if="sidebarCollapsed" class="sidebar-rail">
      <div class="sidebar-rail-scroll">
        <section
          v-if="railAgents.length"
          class="sidebar-rail-section"
          :aria-label="t('nav.sidebarAgents')"
        >
          <button
            v-for="agent in railAgents"
            :key="agent.kind"
            class="sidebar-rail-item"
            :class="{ active: isRailAgentActive(agent), unavailable: !agent.ready }"
            type="button"
            :title="`${agent.label} · ${agentState(agent).label}`"
            :aria-label="agent.label"
            :disabled="isDirectCreationPending(agent.kind)"
            @click="handleSidebarAgentMain(agent)"
          >
            <span class="agent-logo-cloud" :class="{ cloud: agent.cloud }">
              <img :src="agent.logo" :alt="agent.label" />
              <CloudOutline v-if="agent.cloud" aria-hidden="true" />
              <span
                v-if="agentAwaitingDecision(agent.kind)"
                class="attention-dot agent-attention-dot"
                :title="t('humanGate.waiting')"
              />
            </span>
          </button>
        </section>

        <button v-if="roomWorkspaceAvailable" class="sidebar-rail-item" type="button" :title="t('room.title')" :aria-label="t('room.title')" :aria-current="activeView === 'rooms' ? 'page' : undefined" @click="openRoomWorkspace"><PeopleOutline /></button>
        <button v-if="roomWorkspaceAvailable" class="sidebar-rail-item sidebar-rail-add" type="button" :title="t('room.createTeamRoom')" :aria-label="t('room.createTeamRoom')" @click="openTeamRoomCreate"><AddOutline /></button>
      </div>
    </div>

    <nav v-else class="conversation-nav" :aria-label="t('nav.conversations')">
      <section class="nav-section agent-nav-section">
        <button
          class="nav-heading"
          type="button"
          :title="sidebarAgentsCollapsed ? t('nav.expandAgents') : t('nav.collapseAgents')"
          :aria-expanded="String(!sidebarAgentsCollapsed)"
          aria-controls="sidebar-agent-list"
          @click="sidebarAgentsCollapsed = !sidebarAgentsCollapsed"
        >
          <span>{{ t('nav.sidebarAgents') }}</span>
          <small v-if="sidebarAgentsCollapsed" class="nav-heading-count">{{ sidebarAgentCount }}</small>
        </button>
        <div v-if="!sidebarAgentsCollapsed" id="sidebar-agent-list">
          <div v-if="discoveringAgents && !sidebarAgentGroups.length" class="sidebar-discovery" role="status">
            <span v-for="index in 3" :key="index" class="sidebar-discovery-row" aria-hidden="true"><i /><b /></span>
            <p>{{ t('onboarding.detecting') }}</p>
          </div>
          <div v-for="agentGroup in filteredAgentGroups" :key="agentGroup.id" class="sidebar-agent-location-group">
            <p v-if="filteredAgentGroups.length > 1" class="sidebar-agent-location-heading">{{ t(agentGroup.titleKey) }}</p>
            <article
              v-for="agent in agentGroup.agents"
              :key="agent.kind"
              class="sidebar-agent"
              :class="{ unavailable: !agent.ready }"
            >
            <header class="sidebar-agent-header">
              <button
                class="sidebar-agent-main"
                type="button"
                :title="agent.ready ? `${agent.label} · ${memberStatus(agent)}` : `${agent.label}: ${agentState(agent).label}`"
                :disabled="isDirectCreationPending(agent.kind)"
                :aria-expanded="directGroupsFor(agent.kind).length ? String(isSidebarAgentExpanded(agent.kind)) : undefined"
                :aria-controls="directGroupsFor(agent.kind).length ? sidebarAgentSessionListId(agent.kind) : undefined"
                @click="handleSidebarAgentMain(agent)"
              >
                <span class="agent-logo-cloud" :class="{ cloud: agent.cloud }">
                  <img :src="agent.logo" :alt="agent.label" />
                  <CloudOutline v-if="agent.cloud" aria-hidden="true" />
                  <span
                    v-if="agentAwaitingDecision(agent.kind)"
                    class="attention-dot agent-attention-dot"
                    :title="t('humanGate.waiting')"
                  />
                  <span class="member-presence" :data-tone="memberPresence(agent)" />
                </span>
                <span>
                  <strong>{{ agent.label }}</strong>
                </span>
              </button>
              <button
                class="sidebar-agent-new"
                type="button"
                :title="t('nav.newDirect', { agent: agent.label })"
                :aria-label="t('nav.newDirect', { agent: agent.label })"
                :disabled="!agent.ready || isDirectCreationPending(agent.kind)"
                @click="createDirectSession(agent)"
              >
                <AddOutline />
              </button>
            </header>
            <div
              v-if="matchingSessions(agent).length && sessionsOpen(agent)"
              :id="sidebarAgentSessionListId(agent.kind)"
              class="direct-session-list"
            >
              <div
                v-for="group in matchingSessions(agent)"
                :key="group.id"
                class="direct-session-row"
                :class="{ active: isSelectedConversation(group) }"
              >
                <button
                  class="direct-session-open"
                  type="button"
                  :title="t('nav.openDirect', { name: groupName(group) })"
                  :aria-current="isSelectedConversation(group) ? 'page' : undefined"
                  @click="selectGroup(group.id)"
                >
                  <span>{{ groupName(group) }}</span>
                </button>
                <span
                  v-if="isGroupAwaitingDecision(group.id) && !isSelectedConversation(group)"
                  class="attention-mark"
                  role="img"
                  :title="t('humanGate.waiting')"
                  :aria-label="t('humanGate.waiting')"
                >
                  <span class="attention-dot" />
                </span>
                <span
                  v-else-if="isGroupRunning(group.id) && !isSelectedConversation(group)"
                  class="run-mark"
                  :title="t('conversation.runningGeneric')"
                >
                  <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <span
                  v-else-if="hasFinishedDirectRun(group.id) && !isSelectedConversation(group)"
                  class="run-finished-mark"
                  :title="t('nav.runFinished')"
                >
                  <CheckmarkCircleOutline />
                </span>
                <span v-else class="direct-session-spacer" />
                <button
                  class="direct-session-action"
                  type="button"
                  :title="t('nav.renameDirect', { name: groupName(group) })"
                  :aria-label="t('nav.renameDirect', { name: groupName(group) })"
                  @click="openConversationRename(group)"
                >
                  <PencilOutline />
                </button>
                <span v-if="!isGroupRunning(group.id) || isSelectedConversation(group)" class="sidebar-delete-control">
                  <button
                    class="direct-session-action danger"
                    type="button"
                    :title="t('nav.deleteDirect', { name: groupName(group) })"
                    :aria-label="t('nav.deleteDirect', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openSidebarConversationDelete(group, $event)"
                  >
                    <TrashOutline />
                  </button>
                </span>
              </div>
              <button
                v-if="hasMoreDirectGroups(agent.kind)"
                class="sidebar-more-button"
                type="button"
                :title="t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessDirectSessions' : 'nav.moreDirectSessions', {
                  agent: agent.label,
                  count: remainingDirectGroupsCount(agent.kind),
                })"
                :aria-label="t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessDirectSessions' : 'nav.moreDirectSessions', {
                  agent: agent.label,
                  count: remainingDirectGroupsCount(agent.kind),
                })"
                :aria-expanded="String(isDirectSessionListExpanded(agent.kind))"
                @click="toggleDirectSessionListExpanded(agent.kind)"
              >
                <span>{{ t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessItems' : 'nav.moreItems') }}</span>
              </button>
            </div>
            </article>
          </div>
        </div>
        <p v-if="!filteredAgentGroups.length && !sidebarAgentsCollapsed && !discoveringAgents && !searching" class="nav-empty">{{ t('nav.noSidebarAgents') }}</p>
      </section>

      <section v-if="roomWorkspaceAvailable" class="nav-section team-room-nav-section">
        <div class="nav-heading project-room-heading team-room-heading" role="heading" aria-level="2">
          <span>{{ t('room.title') }}</span>
          <button class="project-room-add team-room-add" type="button" :title="t('room.createTeamRoom')" :aria-label="t('room.createTeamRoom')" @click="openTeamRoomCreate">
            <AddOutline />
          </button>
        </div>
        <div v-if="filteredTeamRooms.length" class="project-room-list team-room-list">
          <div v-for="room in filteredTeamRooms" :key="room.id" class="project-room-entry team-room-entry">
            <div class="project-room-row team-room-row" :class="{ active: isTeamRoomSelected(room.id) }">
              <button
                class="project-room-open"
                type="button"
                :title="t(isTeamRoomExpanded(room.id) ? 'room.collapseChats' : 'room.expandChats', { name: room.name })"
                :aria-current="isTeamRoomSelected(room.id) ? 'page' : undefined"
                :aria-expanded="String(searching || isTeamRoomExpanded(room.id))"
                :aria-controls="`team-room-chats-${room.id}`"
                @click="handleTeamRoomClick(room)"
              >
                <span v-if="roomFaces(room).faces.length" class="team-face-stack team-face-stack-room" aria-hidden="true">
                  <img v-for="(member, index) in roomFaces(room).faces" :key="`${member.provider}-${member.name}-${index}`" :src="rolePortrait(member.portrait || member.provider)" alt="" />
                  <span v-if="roomFaces(room).extra" class="team-face-more">+{{ roomFaces(room).extra }}</span>
                </span>
                <span v-else class="project-room-avatar" aria-hidden="true">{{ projectInitial(room.name) }}</span>
                <span class="project-room-copy">
                  <strong>{{ room.name }}</strong>
                  <small>{{ roomSummary(room) }}</small>
                </span>
                <ChevronForwardOutline class="team-room-chevron" :class="{ open: searching || isTeamRoomExpanded(room.id) }" />
              </button>
              <button
                class="project-room-add team-room-add-chat"
                type="button"
                :title="t('room.addChat', { name: room.name })"
                :aria-label="t('room.addChat', { name: room.name })"
                @click.stop="addTeamChat(room.id)"
              >
                <AddOutline />
              </button>
              <button
                class="project-room-delete team-room-delete"
                type="button"
                :title="t('room.deleteRoom', { name: room.name })"
                :aria-label="t('room.deleteRoom', { name: room.name })"
                @click.stop="openTeamDelete({ type: 'room', roomId: room.id, name: room.name }, $event)"
              >
                <TrashOutline />
              </button>
            </div>
            <div
              v-if="room.chats?.length && (searching || isTeamRoomExpanded(room.id))"
              :id="`team-room-chats-${room.id}`"
              class="project-room-groups team-room-chats"
            >
              <div v-for="chat in room.chats" :key="chat.id" class="project-room-group-row">
                <button
                  class="project-room-group"
                  :class="{ active: isTeamChatSelected(room.id, chat.id) }"
                  type="button"
                  :title="t('room.openChat', { name: chat.title })"
                  :aria-current="isTeamChatSelected(room.id, chat.id) ? 'page' : undefined"
                  @click="selectTeamChat(room.id, chat.id)"
                >
                  <span v-if="stackedMembers(chat.members).faces.length" class="team-face-stack team-face-stack-chat" aria-hidden="true">
                    <img v-for="(member, index) in stackedMembers(chat.members).faces" :key="`${member.provider}-${member.name}-${index}`" :src="rolePortrait(member.portrait || member.provider)" alt="" />
                    <span v-if="stackedMembers(chat.members).extra" class="team-face-more">+{{ stackedMembers(chat.members).extra }}</span>
                  </span>
                  <span class="team-chat-copy">
                    <span class="team-chat-title">
                      <span class="project-room-group-name">{{ teamChatLabel(room, chat) }}</span>
                      <time v-if="chatTime(chat)">{{ chatTime(chat) }}</time>
                    </span>
                    <small>{{ chatActivityLabel(chat) }}</small>
                  </span>
                </button>
                <button
                  v-if="!chat.is_primary || room.chats.length > 1"
                  class="project-room-group-delete team-room-delete-chat"
                  type="button"
                  :title="t('room.deleteChat', { name: teamChatLabel(room, chat) })"
                  :aria-label="t('room.deleteChat', { name: teamChatLabel(room, chat) })"
                  @click.stop="openTeamDelete({ type: 'chat', roomId: room.id, chatId: chat.id, name: teamChatLabel(room, chat) }, $event)"
                >
                  <TrashOutline />
                </button>
              </div>
            </div>
            <p v-else-if="isTeamRoomExpanded(room.id) && !room.chats?.length" class="team-room-chat-empty">
              {{ t('room.noChats') }}
            </p>
          </div>
        </div>
      </section>

      <p v-if="searching && !filteredAgentGroups.length && !filteredTeamRooms.length" class="nav-empty">{{ t('nav.searchEmpty') }}</p>
    </nav>

    <footer v-if="!sidebarCollapsed" class="sidebar-footer">
      <button class="sidebar-user" type="button" :title="t('nav.you')" :aria-label="t('nav.you')" @click="openSidebarSettings">
        <span class="sidebar-user-mark" aria-hidden="true">{{ youMark }}</span>
        <span>{{ t('nav.you') }}</span>
      </button>
      <div class="sidebar-footer-actions">
        <button class="icon-button" type="button" :title="t('nav.settings')" :aria-label="t('nav.settings')" :aria-current="activeView === 'settings' ? 'page' : undefined" @click="openSidebarSettings">
          <SettingsOutline />
        </button>
      </div>
    </footer>

  </aside>

  <Teleport to="body">
    <span
      v-if="sidebarDeleteGroup"
      class="settings-delete-popover sidebar-delete-popover"
      role="dialog"
      aria-modal="false"
      :style="sidebarDeletePopoverStyle"
      :aria-labelledby="`sidebar-delete-title-${sidebarDeleteGroup.id}`"
    >
      <strong :id="`sidebar-delete-title-${sidebarDeleteGroup.id}`">{{ t('settings.deletePrompt') }}</strong>
      <p>{{ t('settings.deleteHint') }}</p>
      <span class="settings-delete-actions">
        <button class="secondary-button compact" type="button" :disabled="saving" @click="dismissSidebarDeleteConfirmation">
          {{ t('common.cancel') }}
        </button>
        <button class="danger-button" type="button" :disabled="saving" @click="deleteSidebarConversation(sidebarDeleteGroup)">
          {{ t('settings.deleteConfirm') }}
        </button>
      </span>
    </span>
    <span v-if="teamDeleteTarget" class="team-delete-backdrop" aria-hidden="true" @click="dismissTeamDelete" />
    <span
      v-if="teamDeleteTarget"
      class="settings-delete-popover sidebar-delete-popover"
      role="dialog"
      aria-modal="false"
      :style="teamDeletePopoverStyle"
      :aria-labelledby="`team-delete-title-${teamDeleteTarget.type}-${teamDeleteTarget.roomId}`"
    >
      <strong :id="`team-delete-title-${teamDeleteTarget.type}-${teamDeleteTarget.roomId}`">
        {{ t('room.deleteTitle', { name: teamDeleteTarget.name }) }}
      </strong>
      <p>{{ t(teamDeleteTarget.type === 'room' ? 'room.deleteRoomHint' : 'room.deleteChatHint') }}</p>
      <span class="settings-delete-actions">
        <button class="secondary-button compact" type="button" @click="dismissTeamDelete">
          {{ t('common.cancel') }}
        </button>
        <button class="danger-button" type="button" @click="confirmTeamDelete">
          {{ t('room.deleteConfirm') }}
        </button>
      </span>
    </span>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue'
import {
  AddOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  CloudOutline,
  PencilOutline,
  PeopleOutline,
  SearchOutline,
  SettingsOutline,
  TrashOutline,
} from '@vicons/ionicons5'

import { rolePortrait } from '../role-portraits.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  addTeamChat,
  activeView,
  agentState,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  collapsedGroupMenuStyle,
  contentInteractionBlocked,
  createDirectSession,
  deleteSidebarConversation,
  deleteTeamChat,
  deleteTeamRoom,
  directGroupsFor,
  discoveringAgents,
  dismissSidebarDeleteConfirmation,
  formatNavTime,
  goHome,
  groupAgentSummary,
  groupGroups,
  groupName,
  groupSessionListExpanded,
  handleSidebarAgentMain,
  handleTeamRoomClick,
  hasFinishedDirectRun,
  hasMoreDirectGroups,
  hasMoreGroupGroups,
  isDirectCreationPending,
  isDirectSessionListExpanded,
  isGroupAwaitingDecision,
  isGroupRunning,
  isSidebarAgentExpanded,
  isTeamChatSelected,
  isTeamRoomExpanded,
  isTeamRoomSelected,
  openConversationRename,
  openNewGroup,
  roomWorkspaceAvailable,
  openRoomWorkspace,
  openSystemSettings,
  openTeamRoomCreate,
  openSidebarConversationDelete,
  productMark,
  remainingDirectGroupsCount,
  remainingGroupGroupsCount,
  saving,
  selectGroup,
  selectTeamChat,
  selectedGroupId,
  sidebarAgentSessionListId,
  sidebarAgentGroups,
  sidebarAgentsCollapsed,
  sidebarGroupsCollapsed,
  sidebarCollapsed,
  sidebarDeleteGroup,
  sidebarDeletePopoverStyle,
  t,
  teamRooms,
  theme,
  toggleCollapsedGroupMenu,
  toggleDirectSessionListExpanded,
  toggleGroupSessionListExpanded,
  visibleDirectGroupsFor,
  visibleGroupGroups,
} = props.controller

function isSelectedConversation(group) {
  return unref(activeView) === 'conversation' && unref(selectedGroupId) === group.id
}

function projectInitial(name) {
  return String(name || '').trim().slice(0, 1).toUpperCase() || '•'
}

function memberList(chat) {
  return Array.isArray(chat?.members) ? chat.members : []
}

function orderedMembers(members) {
  return [...(Array.isArray(members) ? members : [])]
    .sort((a, b) => (Number(b?.last_seq) || 0) - (Number(a?.last_seq) || 0))
}

function stackedMembers(members, limit = 3) {
  const list = orderedMembers(members)
  return { faces: list.slice(0, limit), extra: Math.max(0, list.length - limit) }
}

function roomFaces(room) {
  const best = new Map()
  for (const chat of room.chats || []) {
    for (const member of orderedMembers(memberList(chat))) {
      const key = member.provider || member.name
      if (!key) continue
      const rank = Number(member.last_seq) || 0
      const existing = best.get(key)
      if (!existing || rank > existing.rank) best.set(key, { member, rank })
    }
  }
  const faces = [...best.values()].sort((a, b) => b.rank - a.rank).map(item => item.member)
  return stackedMembers(faces, 3)
}

function roomSummary(room) {
  const faces = roomFaces(room)
  const members = faces.faces.length + faces.extra
  const chats = room.chatTotal ?? room.chats?.length ?? 0
  if (!members) return t('room.chatCount', { count: chats })
  return t('room.roomFaces', { members, chats })
}

function chatActivityLabel(chat) {
  const activity = chat?.activity
  if (!activity?.text) return t('room.noMessages')
  if (['working', 'queued', 'starting', 'running'].includes(activity.status) && activity.name) {
    return t('room.memberWorking', { name: activity.name })
  }
  const name = activity.author === 'user' ? t('room.you') : activity.name
  return name ? t('room.activityLine', { name, text: activity.text }) : activity.text
}

function chatTime(chat) {
  const value = chat?.activity?.created_at || chat?.updated_at
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function teamChatLabel(room, chat) {
  return chat?.is_primary && chat.title === room?.name ? t('room.primaryChat') : chat?.title
}

const teamDeleteTarget = ref(null)
const teamDeletePopoverStyle = ref({})

function openTeamDelete(target, event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.()
  teamDeleteTarget.value = target
  if (!rect || typeof window === 'undefined') return
  const width = 278
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
  const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 190))
  teamDeletePopoverStyle.value = { top: `${top}px`, left: `${left}px` }
}

function dismissTeamDelete() {
  teamDeleteTarget.value = null
}

function handleTeamDeleteKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    dismissTeamDelete()
  }
}

function confirmTeamDelete() {
  const target = teamDeleteTarget.value
  teamDeleteTarget.value = null
  if (!target) return
  if (target.type === 'room') void deleteTeamRoom(target.roomId)
  else void deleteTeamChat(target.roomId, target.chatId)
}

watch(teamDeleteTarget, (target) => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', handleTeamDeleteKey)
  if (target) document.addEventListener('keydown', handleTeamDeleteKey)
})

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('keydown', handleTeamDeleteKey)
})

const sidebarAgentCount = computed(() => (
  unref(sidebarAgentGroups).reduce((total, group) => total + group.agents.length, 0)
))

const sidebarQuery = ref('')
const sidebarSearchInput = ref(null)
const sidebarQueryNormalized = computed(() => sidebarQuery.value.trim().toLowerCase())
const searching = computed(() => sidebarQueryNormalized.value.length > 0)
const searchShortcut = computed(() => (
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
))
const youMark = computed(() => String(t('nav.you') || '').trim().slice(0, 1) || '•')

function queryMatches(...values) {
  const query = sidebarQueryNormalized.value
  if (!query) return true
  return values.some(value => String(value || '').toLowerCase().includes(query))
}

function agentSessions(agent) {
  const sessions = directGroupsFor(agent.kind)
  return Array.isArray(sessions) ? sessions : []
}

function memberPresence(agent) {
  if (!agent.ready) return agentState(agent).tone === 'warning' ? 'warning' : 'off'
  const sessions = agentSessions(agent)
  if (sessions.some(group => isGroupAwaitingDecision(group.id))) return 'waiting'
  if (sessions.some(group => isGroupRunning(group.id))) return 'running'
  return 'ready'
}

function memberStatus(agent) {
  const presence = memberPresence(agent)
  if (presence === 'running') return t('nav.agentRunning')
  if (presence === 'waiting') return t('nav.agentWaiting')
  if (presence === 'ready') return t('nav.agentIdle')
  return agentState(agent).label
}

function matchingSessions(agent) {
  const sessions = agentSessions(agent)
  if (!searching.value) return visibleDirectGroupsFor(agent.kind) || []
  const named = sessions.filter(group => queryMatches(groupName(group)))
  if (named.length) return named
  return queryMatches(agent.label) ? (visibleDirectGroupsFor(agent.kind) || []) : []
}

function sessionsOpen(agent) {
  if (!searching.value) return isSidebarAgentExpanded(agent.kind)
  return agentSessions(agent).some(group => queryMatches(groupName(group))) || isSidebarAgentExpanded(agent.kind)
}

const filteredAgentGroups = computed(() => (
  unref(sidebarAgentGroups).map(group => ({
    ...group,
    agents: group.agents.filter(agent => queryMatches(agent.label) || agentSessions(agent).some(session => queryMatches(groupName(session)))),
  })).filter(group => group.agents.length)
))

const teamRoomList = computed(() => {
  const value = unref(teamRooms)
  return Array.isArray(value) ? value : []
})

const filteredTeamRooms = computed(() => teamRoomList.value.flatMap(room => {
  const chats = Array.isArray(room.chats) ? room.chats : []
  if (!searching.value) return [{ ...room, chatTotal: chats.length }]
  const roomHit = queryMatches(room.name)
  const matchedChats = chats.filter(chat => queryMatches(teamChatLabel(room, chat), chat.title))
  if (!roomHit && !matchedChats.length) return []
  return [{ ...room, chats: matchedChats.length ? matchedChats : chats, chatTotal: chats.length }]
}))

function focusSidebarSearch() {
  if (unref(sidebarCollapsed)) sidebarCollapsed.value = false
  nextTick(() => sidebarSearchInput.value?.focus())
}

function openSidebarSettings() {
  openSystemSettings?.('agents')
}

function handleSidebarSearchKey(event) {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
  if (event.altKey) return
  event.preventDefault()
  focusSidebarSearch()
}

onMounted(() => {
  document.addEventListener('keydown', handleSidebarSearchKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleSidebarSearchKey)
})

const railAgents = computed(() => (
  unref(sidebarAgentGroups).flatMap(group => group.agents)
))

function isRailAgentActive(agent) {
  return directGroupsFor(agent.kind).some(group => isSelectedConversation(group))
}

function agentAwaitingDecision(kind) {
  return directGroupsFor(kind).some(group => isGroupAwaitingDecision(group.id))
}
</script>
