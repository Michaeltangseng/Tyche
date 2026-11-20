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
          <div v-for="agentGroup in sidebarAgentGroups" :key="agentGroup.id" class="sidebar-agent-location-group">
            <p class="sidebar-agent-location-heading">{{ t(agentGroup.titleKey) }}</p>
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
                :title="agent.ready ? agent.label : `${agent.label}: ${agentState(agent).label}`"
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
                </span>
                <span>
                  <strong>{{ agent.label }}</strong>
                  <small :data-tone="agent.ready ? undefined : agentState(agent).tone">
                    {{ !agent.ready ? agentState(agent).label : directGroupsFor(agent.kind).length
                      ? t('nav.agentSessions', { count: directGroupsFor(agent.kind).length })
                      : t('nav.noAgentSessions') }}
                  </small>
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
              v-if="directGroupsFor(agent.kind).length && isSidebarAgentExpanded(agent.kind)"
              :id="sidebarAgentSessionListId(agent.kind)"
              class="direct-session-list"
            >
              <div
                v-for="group in visibleDirectGroupsFor(agent.kind)"
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
        <p v-if="!sidebarAgentGroups.length && !sidebarAgentsCollapsed && !discoveringAgents" class="nav-empty">{{ t('nav.noSidebarAgents') }}</p>
      </section>

      <section v-if="roomWorkspaceAvailable" class="nav-section team-room-nav-section">
        <div class="nav-heading project-room-heading team-room-heading" role="heading" aria-level="2">
          <span>{{ t('room.title') }}</span>
          <small class="nav-heading-count">{{ teamRoomList.length }}</small>
          <button class="project-room-add team-room-add" type="button" :title="t('room.createTeamRoom')" :aria-label="t('room.createTeamRoom')" @click="openTeamRoomCreate">
            <AddOutline />
          </button>
        </div>
        <div v-if="teamRoomList.length" class="project-room-list team-room-list">
          <div v-for="room in teamRoomList" :key="room.id" class="project-room-entry team-room-entry">
            <div class="project-room-row team-room-row" :class="{ active: isTeamRoomSelected(room.id) }">
              <button
                class="project-room-open"
                type="button"
                :title="t(isTeamRoomExpanded(room.id) ? 'room.collapseChats' : 'room.expandChats', { name: room.name })"
                :aria-current="isTeamRoomSelected(room.id) ? 'page' : undefined"
                :aria-expanded="String(isTeamRoomExpanded(room.id))"
                :aria-controls="`team-room-chats-${room.id}`"
                @click="handleTeamRoomClick(room)"
              >
                <span class="project-room-avatar" aria-hidden="true">{{ projectInitial(room.name) }}</span>
                <span class="project-room-copy">
                  <strong>{{ room.name }}</strong>
                  <small>{{ t('room.chatCount', { count: room.chats?.length || 0 }) }}</small>
                </span>
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
              v-if="room.chats?.length && isTeamRoomExpanded(room.id)"
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
                  <span class="project-room-group-name">{{ teamChatLabel(room, chat) }}</span>
                  <span v-if="chat.is_primary && teamChatLabel(room, chat) !== t('room.primaryChat')" class="project-room-group-badge">
                    {{ t('room.primaryChat') }}
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

    </nav>

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
import { computed, onBeforeUnmount, ref, unref, watch } from 'vue'
import {
  AddOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  CloudOutline,
  PencilOutline,
  PeopleOutline,
  TrashOutline,
} from '@vicons/ionicons5'

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

const teamRoomList = computed(() => {
  const value = unref(teamRooms)
  return Array.isArray(value) ? value : []
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
