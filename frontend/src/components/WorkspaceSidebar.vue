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
          v-if="castAgents.length"
          class="sidebar-rail-section"
          :aria-label="t('nav.sidebarAgents')"
        >
          <button
            v-for="agent in castAgents"
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
        <button v-if="roomWorkspaceAvailable" class="sidebar-rail-item sidebar-rail-add" type="button" :title="t('room.createChat')" :aria-label="t('room.createChat')" @click="openTeamRoomCreate"><AddOutline /></button>
      </div>
    </div>

    <nav v-else class="conversation-nav" :aria-label="t('nav.conversations')">
      <section class="nav-section agent-nav-section">
        <button
          class="nav-heading"
          type="button"
          :title="sidebarAgentsCollapsed ? t('nav.expandAgents') : t('nav.collapseAgents')"
          :aria-expanded="String(!sidebarAgentsCollapsed || searching)"
          aria-controls="sidebar-agent-list"
          @click="sidebarAgentsCollapsed = !sidebarAgentsCollapsed"
        >
          <span>{{ t('nav.sidebarAgents') }}</span>
          <small v-if="sidebarAgentsCollapsed" class="nav-heading-count">{{ castAgents.length }}</small>
          <ChevronForwardOutline class="nav-heading-chevron" :class="{ open: !sidebarAgentsCollapsed || searching }" aria-hidden="true" />
        </button>
        <div
          v-if="sidebarAgentsCollapsed && !searching && castAgents.length"
          class="agent-cast"
          :aria-label="t('nav.sidebarAgents')"
        >
          <button
            v-for="agent in castAgents"
            :key="agent.kind"
            class="agent-cast-item"
            :class="{ active: isRailAgentActive(agent), unavailable: !agent.ready }"
            :data-tone="memberPresence(agent)"
            :style="{ '--agent-glow': portraitGlow(agent.kind) }"
            type="button"
            :title="castAgentTitle(agent)"
            :aria-label="castAgentTitle(agent)"
            :disabled="isDirectCreationPending(agent.kind)"
            @click="handleSidebarAgentMain(agent)"
          >
            <span class="agent-cast-face">
              <img :src="agent.logo" :alt="agent.label" />
              <CloudOutline v-if="agent.cloud" class="agent-cast-cloud" aria-hidden="true" />
              <span
                v-if="agentAwaitingDecision(agent.kind)"
                class="attention-dot agent-attention-dot"
                :title="t('humanGate.waiting')"
              />
            </span>
            <span class="agent-cast-status" :data-tone="memberPresence(agent)" aria-hidden="true" />
          </button>
          <button
            class="agent-cast-add"
            type="button"
            :title="t('nav.manageAgents')"
            :aria-label="t('nav.manageAgents')"
            @click="openAgentManager"
          >
            <AddOutline />
          </button>
        </div>
        <div v-if="!sidebarAgentsCollapsed || searching" id="sidebar-agent-list">
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
                :aria-expanded="directGroupsFor(agent.kind).length > 1 ? String(isSidebarAgentExpanded(agent.kind)) : undefined"
                :aria-controls="directGroupsFor(agent.kind).length > 1 ? sidebarAgentSessionListId(agent.kind) : undefined"
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
              :class="{ 'direct-session-solo': matchingSessions(agent).length === 1 }"
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
          <span>{{ t('room.chatList') }}</span>
          <button class="project-room-add team-room-add" type="button" :title="t('room.createChat')" :aria-label="t('room.createChat')" @click="openTeamRoomCreate">
            <AddOutline />
          </button>
        </div>
        <div v-if="flatTeamChats.length" class="project-room-list team-room-list">
          <div v-for="row in flatTeamChats" :key="row.chat.id" class="project-room-entry team-room-entry team-chat-row">
            <div
              class="project-room-row team-room-row"
              :class="{
                active: isTeamChatSelected(row.room.id, row.chat.id),
                'menu-open': isChatMenuOpen(row.room, row.chat),
                renaming: isChatRenaming(row.room, row.chat),
              }"
            >
              <form
                v-if="isChatRenaming(row.room, row.chat)"
                class="project-room-open team-chat-rename"
                @submit.prevent="commitTeamRename"
              >
                <span class="team-member-mascots" aria-hidden="true">
                  <span v-for="member in chatMemberMascots(row.chat)" :key="member.key" class="team-member-mascot">
                    <RoomMascot :mascot="member.mascot" />
                  </span>
                </span>
                <input
                  ref="teamRenameInput"
                  v-model="teamRenameDraft"
                  type="text"
                  maxlength="80"
                  :aria-label="t('room.renameChat')"
                  @blur="commitTeamRename"
                  @keydown.enter.prevent="commitTeamRename"
                  @keydown.esc.prevent="cancelTeamRename"
                />
              </form>
              <button
                v-else
                class="project-room-open"
                type="button"
                :title="chatRowTitle(row.room, row.chat)"
                :aria-current="isTeamChatSelected(row.room.id, row.chat.id) ? 'page' : undefined"
                @click="openTeamChat(row.room, row.chat)"
              >
                <span class="team-member-mascots" aria-hidden="true">
                  <span v-for="member in chatMemberMascots(row.chat)" :key="member.key" class="team-member-mascot">
                    <RoomMascot :mascot="member.mascot" />
                  </span>
                  <span v-if="isChatRunning(row.chat)" class="team-room-live" :title="t('room.chatRunning')" />
                </span>
                <span class="project-room-copy">
                  <strong>{{ teamChatLabel(row.room, row.chat) }}</strong>
                  <small v-if="chatSubtitle(row.room, row.chat)">{{ chatSubtitle(row.room, row.chat) }}</small>
                </span>
              </button>
              <button
                class="team-chat-menu"
                type="button"
                :title="t('room.chatActions', { name: teamChatLabel(row.room, row.chat) })"
                :aria-label="t('room.chatActions', { name: teamChatLabel(row.room, row.chat) })"
                :aria-expanded="isChatMenuOpen(row.room, row.chat) ? 'true' : 'false'"
                aria-haspopup="menu"
                @click.stop="toggleChatMenu(row.room, row.chat, $event)"
              >
                <EllipsisHorizontal />
              </button>
            </div>
          </div>
        </div>
      </section>

      <p v-if="searching && !filteredAgentGroups.length && !flatTeamChats.length" class="nav-empty">{{ t('nav.searchEmpty') }}</p>
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
    <span
      v-if="teamChatMenu"
      class="team-chat-menu-popover"
      role="menu"
      :style="teamChatMenuStyle"
      :aria-label="t('room.chatActions', { name: teamChatLabel(teamChatMenu.room, teamChatMenu.chat) })"
    >
      <button class="team-chat-menu-item team-chat-menu-rename" type="button" role="menuitem" @click="beginTeamRename">
        <PencilOutline />
        <span>{{ t('room.renameChatAction') }}</span>
      </button>
      <button class="team-chat-menu-item danger team-chat-menu-delete" type="button" role="menuitem" @click="chooseTeamDelete">
        <TrashOutline />
        <span>{{ t('room.deleteConfirm') }}</span>
      </button>
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
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  CloudOutline,
  EllipsisHorizontal,
  PencilOutline,
  PeopleOutline,
  SearchOutline,
  SettingsOutline,
  TrashOutline,
} from '@vicons/ionicons5'

import { portraitGlow } from '../role-portraits.js'
import { loadRoomChatSeen, saveRoomChatSeen } from '../room-chat-read-state.js'
import { roomMascot } from '../room-mascots.js'
import RoomMascot from './RoomMascot.vue'

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
  renameTeamChat,
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

const storedChatSeen = loadRoomChatSeen()
const seenChatActivity = ref(storedChatSeen || {})
let seenChatActivityInitialized = storedChatSeen !== null

function isSelectedConversation(group) {
  return unref(activeView) === 'conversation' && unref(selectedGroupId) === group.id
}

const RUNNING_CHAT_STATUSES = new Set(['working', 'queued', 'starting', 'running'])

function isChatRunning(chat) {
  return RUNNING_CHAT_STATUSES.has(chat?.activity?.status)
}

function chatActivityLabel(chat) {
  const activity = chat?.activity
  if (activity?.text) {
    const name = activity.author === 'user' ? t('room.you') : activity.name
    return name ? t('room.activityLine', { name, text: activity.text }) : activity.text
  }
  if (isChatRunning(chat) && activity?.name) return t('room.memberWorking', { name: activity.name })
  return t('room.noMessages')
}

function chatTime(chat) {
  const value = chat?.activity?.created_at || chat?.updated_at
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function chatRowTitle(room, chat) {
  const label = t('room.openChat', { name: teamChatLabel(room, chat) })
  const time = chatTime(chat)
  return time ? `${label} · ${time}` : label
}

function chatMemberMascots(chat) {
  const members = Array.isArray(chat?.members) ? chat.members : []
  const captain = members.find(member => member.is_captain)
  const rest = members.filter(member => member !== captain)
    .sort((a, b) => (Number(b?.last_seq) || 0) - (Number(a?.last_seq) || 0))
  const visible = (captain ? [captain, ...rest] : rest).slice(0, 3)
  const faces = visible.length ? visible : [{ id: chat?.id || 'chat' }]
  return faces.map(member => {
    const key = member.id || `${member.provider || ''}:${member.name || ''}`
    return { key, mascot: roomMascot({ id: key }) }
  })
}

function chatSubtitle(_room, chat) {
  return chatActivityLabel(chat)
}

function chatDeleteTarget(room, chat) {
  const name = teamChatLabel(room, chat)
  const onlyChat = (room?.chats || []).length <= 1
  if (onlyChat) return { type: 'room', roomId: room.id, name }
  return { type: 'chat', roomId: room.id, chatId: chat.id, name }
}

function teamChatLabel(room, chat) {
  if (chat?.is_primary && (chat.title === room?.name || chat.title === t('room.lobby'))) return t('room.lobby')
  return chat?.title
}

const teamDeleteTarget = ref(null)
const teamDeletePopoverStyle = ref({})
const teamChatMenu = ref(null)
const teamChatMenuStyle = ref({})
const teamChatMenuButton = ref(null)
const teamRenameTarget = ref(null)
const teamRenameDraft = ref('')
const teamRenameInput = ref(null)
let teamRenameSettled = false

function chatMenuKey(room, chat) {
  return `${room?.id || ''}:${chat?.id || ''}`
}

function isChatMenuOpen(room, chat) {
  return teamChatMenu.value?.key === chatMenuKey(room, chat)
}

function isChatRenaming(room, chat) {
  const target = teamRenameTarget.value
  return Boolean(target && target.roomId === room?.id && target.chatId === chat?.id)
}

function dismissChatMenu(restoreFocus = false) {
  const button = teamChatMenuButton.value
  teamChatMenu.value = null
  teamChatMenuButton.value = null
  if (restoreFocus) void nextTick(() => button?.focus?.())
}

function toggleChatMenu(room, chat, event) {
  if (isChatMenuOpen(room, chat)) {
    dismissChatMenu()
    return
  }
  dismissTeamDelete()
  const button = event?.currentTarget
  const rect = button?.getBoundingClientRect?.()
  teamChatMenuButton.value = button || null
  if (rect && typeof window !== 'undefined') {
    const width = 168
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8))
    const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 96))
    teamChatMenuStyle.value = { top: `${top}px`, left: `${left}px` }
  }
  teamChatMenu.value = { room, chat, key: chatMenuKey(room, chat) }
}

function handleChatMenuPointer(event) {
  const target = event.target
  if (target instanceof Element && target.closest('.team-chat-menu, .team-chat-menu-popover')) return
  dismissChatMenu()
}

function beginTeamRename() {
  const current = teamChatMenu.value
  if (!current) return
  const title = teamChatLabel(current.room, current.chat) || ''
  teamRenameSettled = false
  teamRenameDraft.value = title
  teamRenameTarget.value = { roomId: current.room.id, chatId: current.chat.id, title }
  dismissChatMenu()
  void nextTick(() => {
    const input = Array.isArray(teamRenameInput.value) ? teamRenameInput.value[0] : teamRenameInput.value
    input?.focus?.()
    input?.select?.()
  })
}

function cancelTeamRename() {
  teamRenameSettled = true
  teamRenameTarget.value = null
}

function commitTeamRename() {
  if (teamRenameSettled) return
  const target = teamRenameTarget.value
  if (!target) return
  teamRenameSettled = true
  const title = teamRenameDraft.value.replace(/\s+/g, ' ').trim().slice(0, 80)
  teamRenameTarget.value = null
  if (!title || title === target.title) return
  void renameTeamChat(target.roomId, target.chatId, title)
}

function chooseTeamDelete() {
  const current = teamChatMenu.value
  const anchor = teamChatMenuButton.value
  dismissChatMenu()
  if (!current) return
  openTeamDelete(chatDeleteTarget(current.room, current.chat), anchor)
}

function openTeamDelete(target, anchor) {
  const rect = anchor?.getBoundingClientRect?.()
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
  if (event.key !== 'Escape') return
  if (teamChatMenu.value) {
    event.preventDefault()
    dismissChatMenu(true)
    return
  }
  if (!teamDeleteTarget.value) return
  event.preventDefault()
  dismissTeamDelete()
}

function confirmTeamDelete() {
  const target = teamDeleteTarget.value
  teamDeleteTarget.value = null
  if (!target) return
  if (target.type === 'room') void deleteTeamRoom(target.roomId)
  else void deleteTeamChat(target.roomId, target.chatId)
}

watch([teamDeleteTarget, teamChatMenu], ([deleteTarget, menu]) => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', handleTeamDeleteKey)
  document.removeEventListener('pointerdown', handleChatMenuPointer, true)
  if (deleteTarget || menu) document.addEventListener('keydown', handleTeamDeleteKey)
  if (menu) document.addEventListener('pointerdown', handleChatMenuPointer, true)
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', handleTeamDeleteKey)
  document.removeEventListener('pointerdown', handleChatMenuPointer, true)
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

function castAgentTitle(agent) {
  return agent.ready ? `${agent.label} · ${memberStatus(agent)}` : `${agent.label}: ${agentState(agent).label}`
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

watch(teamRoomList, (rooms) => {
  if (!seenChatActivityInitialized) {
    if (!rooms.length) return
    const seen = {}
    for (const room of rooms) {
      for (const chat of room.chats || []) seen[chat.id] = Number(chat.activity_seq) || 0
    }
    seenChatActivity.value = seen
    seenChatActivityInitialized = true
    saveRoomChatSeen(seen)
    return
  }
  const next = { ...seenChatActivity.value }
  let changed = false
  for (const room of rooms) {
    for (const chat of room.chats || []) {
      if (!isTeamChatSelected(room.id, chat.id)) continue
      const seq = Number(chat.activity_seq) || 0
      if (next[chat.id] !== seq) {
        next[chat.id] = seq
        changed = true
      }
    }
  }
  if (changed) {
    seenChatActivity.value = next
    saveRoomChatSeen(next)
  }
}, { immediate: true, deep: true })

function markChatSeen(chat) {
  const seq = Number(chat?.activity_seq) || 0
  if (!chat?.id || Number(seenChatActivity.value[chat.id]) === seq) return
  const next = { ...seenChatActivity.value, [chat.id]: seq }
  seenChatActivity.value = next
  saveRoomChatSeen(next)
}

function openTeamChat(room, chat) {
  markChatSeen(chat)
  selectTeamChat(room.id, chat.id)
}

function chatActivityTime(chat) {
  const value = Date.parse(chat?.activity?.created_at || chat?.updated_at || chat?.created_at || '')
  return Number.isFinite(value) ? value : 0
}

const flatTeamChats = computed(() => {
  const rows = teamRoomList.value.flatMap(room => (
    [...(Array.isArray(room.chats) ? room.chats : [])]
      .sort((a, b) => chatActivityTime(b) - chatActivityTime(a))
      .map(chat => ({ room, chat }))
  ))
  const visible = searching.value
    ? rows.filter(row => queryMatches(teamChatLabel(row.room, row.chat), row.chat.title, row.room.name, row.room.workspace_label))
    : rows
  return visible.sort((a, b) => chatActivityTime(b.chat) - chatActivityTime(a.chat))
})

function focusSidebarSearch() {
  if (unref(sidebarCollapsed)) sidebarCollapsed.value = false
  nextTick(() => sidebarSearchInput.value?.focus())
}

function openSidebarSettings() {
  openSystemSettings?.('agents')
}

function openAgentManager() {
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
const castAgents = computed(() => railAgents.value.filter(agent => agent.ready === true))

function isRailAgentActive(agent) {
  return directGroupsFor(agent.kind).some(group => isSelectedConversation(group))
}

function agentAwaitingDecision(kind) {
  return directGroupsFor(kind).some(group => isGroupAwaitingDecision(group.id))
}
</script>
