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
          <strong>Meldwork</strong>
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
        <button
          v-if="pendingDecisionCount"
          class="sidebar-rail-item sidebar-rail-attention"
          type="button"
          :title="t('projectRoom.pending.title')"
          :aria-label="t('projectRoom.pending.title')"
          @click="showPendingDecisions"
        >
          <NotificationsOutline />
          <span class="sidebar-rail-count">{{ pendingDecisionCount }}</span>
        </button>

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

        <div
          v-if="railAgents.length && projectRoomEntries.length"
          class="sidebar-rail-divider"
          aria-hidden="true"
        />

        <section
          v-if="projectRoomEntries.length && activeView !== 'rooms'"
          class="sidebar-rail-section"
          :aria-label="t('projectRoom.sidebar.title')"
        >
          <button
            v-for="project in projectRoomEntries"
            :key="project.projectId"
            class="sidebar-rail-item sidebar-rail-project"
            :class="{ active: isProjectRoomSelected(project.projectId) }"
            type="button"
            :title="`${project.name} · ${projectRoomStatusLabel(project)}`"
            :aria-label="project.name"
            @click="selectProjectRoom(project.projectId)"
          >
            <span class="project-room-avatar" aria-hidden="true">{{ projectInitial(project.name) }}</span>
            <span
              v-if="project.pendingGateCount || project.unresolvedDriftCount || project.residualCount"
              class="attention-dot"
              role="img"
              :title="t('projectRoom.sidebar.attention')"
              :aria-label="t('projectRoom.sidebar.attention')"
            />
          </button>
        </section>

        <button
          v-if="projectRoomPreviewEnabled"
          class="sidebar-rail-item sidebar-rail-add"
          type="button"
          :title="t('projectRoom.sidebar.create')"
          :aria-label="t('projectRoom.sidebar.create')"
          @click="openProjectCreate"
        >
          <AddOutline />
        </button>

        <button v-if="roomWorkspaceAvailable" class="sidebar-rail-item" type="button" :title="t('room.title')" :aria-label="t('room.title')" :aria-current="activeView === 'rooms' ? 'page' : undefined" @click="openRoomWorkspace"><PeopleOutline /></button>
        <button v-if="roomWorkspaceAvailable" class="sidebar-rail-item sidebar-rail-add" type="button" :title="t('room.createTeamRoom')" :aria-label="t('room.createTeamRoom')" @click="openTeamRoomCreate"><AddOutline /></button>
      </div>
    </div>

    <nav v-else class="conversation-nav" :aria-label="t('nav.conversations')">
      <section v-if="pendingDecisionCount" class="nav-section pending-decisions-section">
        <button
          class="nav-heading pending-decisions-heading"
          type="button"
          :title="pendingDecisionsExpanded ? t('projectRoom.pending.collapse') : t('projectRoom.pending.expand')"
          :aria-expanded="String(pendingDecisionsExpanded)"
          aria-controls="pending-decisions-list"
          @click="togglePendingDecisions"
        >
          <span>{{ t('projectRoom.pending.title') }}</span>
          <span class="nav-heading-count pending-decisions-count">{{ pendingDecisionCount }}</span>
          <ChevronDownOutline v-if="pendingDecisionsExpanded" class="nav-heading-chevron" aria-hidden="true" />
          <ChevronForwardOutline v-else class="nav-heading-chevron" aria-hidden="true" />
        </button>
        <div v-if="pendingDecisionsExpanded" id="pending-decisions-list" class="pending-decisions-list">
          <button
            v-for="item in pendingDecisionItems"
            :key="`${item.type}:${item.projectId}:${item.itemId}`"
            class="pending-decision-row"
            type="button"
            :title="`${item.projectName} · ${pendingDecisionLabel(item)}`"
            @click="selectPendingDecision(item)"
          >
            <span class="pending-decision-copy">
              <strong>{{ item.projectName }}</strong>
              <small>{{ pendingDecisionLabel(item) }}</small>
            </span>
            <time>{{ formatWaiting(item.waitingMs) }}</time>
          </button>
          <p v-if="pendingDecisionCount > pendingDecisionItems.length" class="pending-decisions-more">
            {{ t('projectRoom.pending.more', { count: pendingDecisionCount - pendingDecisionItems.length }) }}
          </p>
        </div>
      </section>

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

      <section
        v-if="activeView !== 'rooms' && (projectRoomPreviewEnabled || projectRoomEntries.length)"
        class="nav-section project-room-nav-section"
      >
        <div class="nav-heading project-room-heading" role="heading" aria-level="2">
          <span>{{ t(roomWorkspaceAvailable ? 'room.legacyProjects' : 'projectRoom.sidebar.title') }}</span>
          <small class="nav-heading-count">{{ projectRoomEntries.length }}</small>
        </div>
        <button
          v-if="projectRoomPreviewEnabled"
          class="project-room-create"
          type="button"
          @click="openProjectCreate"
        >
          <AddOutline />
          <span>{{ t('projectRoom.sidebar.create') }}</span>
        </button>
        <div class="project-room-list">
          <div v-for="project in projectRoomEntries" :key="project.projectId" class="project-room-entry">
            <div class="project-room-row" :class="{ active: isProjectRoomSelected(project.projectId) }">
              <button
                class="project-room-open"
                type="button"
                :title="t(isProjectRoomExpanded(project.projectId) ? 'projectRoom.sidebar.collapse' : 'projectRoom.sidebar.expand', { name: project.name })"
                :aria-current="isProjectRoomSelected(project.projectId) ? 'page' : undefined"
                :aria-expanded="String(isProjectRoomExpanded(project.projectId))"
                :aria-controls="`project-room-groups-${project.projectId}`"
                @click="handleProjectRoomClick(project)"
              >
                <span class="project-room-avatar" aria-hidden="true">{{ projectInitial(project.name) }}</span>
                <span class="project-room-copy">
                  <strong>{{ project.name }}</strong>
                  <small :data-tone="project.readOnly || project.deleting ? 'warning' : undefined">
                    {{ projectRoomStatusLabel(project) }}
                  </small>
                </span>
                <span
                  v-if="project.pendingGateCount || project.unresolvedDriftCount || project.residualCount"
                  class="attention-dot project-room-attention"
                  role="img"
                  :title="t('projectRoom.sidebar.attention')"
                  :aria-label="t('projectRoom.sidebar.attention')"
                />
              </button>
              <button
                v-if="!project.deleting"
                class="project-room-add"
                type="button"
                :title="t('projectRoom.sidebar.addChat', { name: project.name })"
                :aria-label="t('projectRoom.sidebar.addChat', { name: project.name })"
                @click.stop="addProjectChat(project.projectId)"
              >
                <AddOutline />
              </button>
              <button
                v-if="!project.deleting"
                class="project-room-delete"
                type="button"
                :title="t('projectRoom.sidebar.delete', { name: project.name })"
                :aria-label="t('projectRoom.sidebar.delete', { name: project.name })"
                @click.stop="deleteProjectRoom(project.projectId)"
              >
                <TrashOutline />
              </button>
            </div>
            <div
              v-if="project.groups.length && isProjectRoomExpanded(project.projectId)"
              :id="`project-room-groups-${project.projectId}`"
              class="project-room-groups"
            >
              <div v-for="group in project.groups" :key="group.id" class="project-room-group-row">
                <button
                  class="project-room-group"
                  :class="{ active: isSelectedConversation(group) }"
                  type="button"
                  :title="t('nav.openGroup', { name: groupName(group) })"
                  :aria-current="isSelectedConversation(group) ? 'page' : undefined"
                  @click="selectGroup(group.id)"
                >
                  <span class="project-room-group-name">{{ groupName(group) }}</span>
                  <span v-if="group.projectRole === 'main'" class="project-room-group-badge">
                    {{ t('projectRoom.sidebar.mainChat') }}
                  </span>
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
                </button>
                <button
                  v-if="group.projectRole !== 'main'"
                  class="project-room-group-delete"
                  type="button"
                  :title="t('nav.deleteGroup', { name: groupName(group) })"
                  :aria-label="t('nav.deleteGroup', { name: groupName(group) })"
                  :disabled="isGroupRunning(group.id)"
                  @click.stop="openSidebarConversationDelete(group, $event)"
                >
                  <TrashOutline />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="roomWorkspaceAvailable" class="nav-section team-room-nav-section">
        <button class="project-room-create" :class="{ active: activeView === 'rooms' }" type="button" :aria-current="activeView === 'rooms' ? 'page' : undefined" @click="openRoomWorkspace"><PeopleOutline /><span>{{ t('room.title') }}</span></button>
        <button class="project-room-create team-room-create" type="button" @click="openTeamRoomCreate"><AddOutline /><span>{{ t('room.createTeamRoom') }}</span></button>
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
  </Teleport>
</template>

<script setup>
import { computed, unref } from 'vue'
import {
  AddOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloudOutline,
  NotificationsOutline,
  PencilOutline,
  PeopleOutline,
  TrashOutline,
} from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  addProjectChat,
  activeView,
  agentState,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  collapsedGroupMenuStyle,
  contentInteractionBlocked,
  createDirectSession,
  deleteProjectRoom,
  deleteSidebarConversation,
  directGroupsFor,
  discoveringAgents,
  dismissSidebarDeleteConfirmation,
  formatNavTime,
  formatWaiting,
  goHome,
  groupAgentSummary,
  groupGroups,
  groupName,
  groupSessionListExpanded,
  handleSidebarAgentMain,
  hasFinishedDirectRun,
  hasMoreDirectGroups,
  hasMoreGroupGroups,
  isDirectCreationPending,
  isDirectSessionListExpanded,
  isGroupAwaitingDecision,
  isGroupRunning,
  isProjectRoomExpanded,
  isProjectRoomSelected,
  isSidebarAgentExpanded,
  openConversationRename,
  openNewGroup,
  openProjectCreate,
  roomWorkspaceAvailable,
  openRoomWorkspace,
  openTeamRoomCreate,
  openSidebarConversationDelete,
  pendingDecisionCount,
  pendingDecisionItems,
  pendingDecisionLabel,
  pendingDecisionsExpanded,
  productMark,
  projectRoomEntries,
  projectRoomPreviewEnabled,
  projectRoomStatusLabel,
  remainingDirectGroupsCount,
  remainingGroupGroupsCount,
  saving,
  selectGroup,
  selectPendingDecision,
  selectProjectRoom,
  selectedGroupId,
  sidebarAgentSessionListId,
  sidebarAgentGroups,
  sidebarAgentsCollapsed,
  sidebarGroupsCollapsed,
  sidebarCollapsed,
  sidebarDeleteGroup,
  sidebarDeletePopoverStyle,
  t,
  theme,
  toggleCollapsedGroupMenu,
  toggleDirectSessionListExpanded,
  toggleGroupSessionListExpanded,
  togglePendingDecisions,
  toggleProjectRoomExpanded,
  visibleDirectGroupsFor,
  visibleGroupGroups,
} = props.controller

function isSelectedConversation(group) {
  return unref(activeView) === 'conversation' && unref(selectedGroupId) === group.id
}

function handleProjectRoomClick(project) {
  if (isProjectRoomExpanded(project.projectId)) {
    toggleProjectRoomExpanded(project.projectId)
    return
  }
  toggleProjectRoomExpanded(project.projectId)
  const main = (project.groups || []).find(group => group.projectRole === 'main')
  if (main) selectGroup(main.id)
  else selectProjectRoom(project.projectId)
}

function projectInitial(name) {
  return String(name || '').trim().slice(0, 1).toUpperCase() || '•'
}

const sidebarAgentCount = computed(() => (
  unref(sidebarAgentGroups).reduce((total, group) => total + group.agents.length, 0)
))

const railAgents = computed(() => (
  unref(sidebarAgentGroups).flatMap(group => group.agents)
))

function isRailAgentActive(agent) {
  return directGroupsFor(agent.kind).some(group => isSelectedConversation(group))
}

function showPendingDecisions() {
  if (!unref(pendingDecisionsExpanded)) togglePendingDecisions()
  sidebarCollapsed.value = false
}

function agentAwaitingDecision(kind) {
  return directGroupsFor(kind).some(group => isGroupAwaitingDecision(group.id))
}
</script>
