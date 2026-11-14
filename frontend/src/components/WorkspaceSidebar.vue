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

    <button class="new-group-button" type="button" :title="t('nav.newGroup')" @click="openNewGroup">
      <AddOutline />
      <span>{{ t('nav.newGroup') }}</span>
    </button>

    <nav class="conversation-nav" :aria-label="t('nav.conversations')">
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

      <section v-if="projectRoomEntries.length" class="nav-section project-room-nav-section">
        <div class="nav-heading project-room-heading" role="heading" aria-level="2">
          <span>{{ t('projectRoom.sidebar.title') }}</span>
          <small class="nav-heading-count">{{ projectRoomEntries.length }}</small>
        </div>
        <div class="project-room-list">
          <div v-for="project in projectRoomEntries" :key="project.projectId" class="project-room-entry">
            <div class="project-room-row" :class="{ active: isProjectRoomSelected(project.projectId) }">
              <button
                class="project-room-open"
                type="button"
                :title="t('projectRoom.sidebar.open', { name: project.name })"
                :aria-current="isProjectRoomSelected(project.projectId) ? 'page' : undefined"
                @click="selectProjectRoom(project.projectId)"
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
                v-if="project.groups.length"
                class="project-room-toggle"
                type="button"
                :title="t(isProjectRoomExpanded(project.projectId) ? 'projectRoom.sidebar.collapse' : 'projectRoom.sidebar.expand', { name: project.name })"
                :aria-label="t(isProjectRoomExpanded(project.projectId) ? 'projectRoom.sidebar.collapse' : 'projectRoom.sidebar.expand', { name: project.name })"
                :aria-expanded="String(isProjectRoomExpanded(project.projectId))"
                :aria-controls="`project-room-groups-${project.projectId}`"
                @click="toggleProjectRoomExpanded(project.projectId)"
              >
                <ChevronDownOutline v-if="isProjectRoomExpanded(project.projectId)" aria-hidden="true" />
                <ChevronForwardOutline v-else aria-hidden="true" />
              </button>
            </div>
            <div
              v-if="project.groups.length && isProjectRoomExpanded(project.projectId)"
              :id="`project-room-groups-${project.projectId}`"
              class="project-room-groups"
            >
              <button
                v-for="group in project.groups"
                :key="group.id"
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
            </div>
          </div>
        </div>
      </section>

      <section class="nav-section">
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

      <section class="nav-section group-nav-section">
        <button
          class="nav-heading"
          type="button"
          :title="sidebarGroupsCollapsed ? t('nav.expandGroups') : t('nav.collapseGroups')"
          :aria-expanded="String(!sidebarGroupsCollapsed)"
          aria-controls="sidebar-group-list"
          @click="sidebarGroupsCollapsed = !sidebarGroupsCollapsed"
        >
          <span>{{ t('nav.groups') }}</span>
          <small v-if="sidebarGroupsCollapsed" class="nav-heading-count">{{ groupGroups.length }}</small>
        </button>
        <div v-if="!sidebarGroupsCollapsed" id="sidebar-group-list">
          <div v-if="groupGroups.length" class="group-conversation-list">
            <div
              v-for="group in visibleGroupGroups"
              :key="group.id"
              class="group-conversation-row"
              :class="{ active: isSelectedConversation(group) }"
            >
              <button
                class="conversation-link"
                type="button"
                :title="t('nav.openGroup', { name: groupName(group) })"
                :aria-current="isSelectedConversation(group) ? 'page' : undefined"
                @click="selectGroup(group.id)"
              >
                <span class="group-avatar stack" :aria-label="groupAgentSummary(group)">
                  <img v-for="kind in group.agentKinds.slice(0, 3)" :key="kind" :src="agentLogo(kind, theme)" alt="" />
                </span>
                <span>{{ groupName(group) }}</span>
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
                  role="img"
                  :title="t('nav.runFinished')"
                  :aria-label="t('nav.runFinished')"
                >
                  <CheckmarkCircleOutline aria-hidden="true" />
                </span>
              </button>
              <span class="group-conversation-actions">
                <button
                  class="direct-session-action"
                  type="button"
                  :title="t('nav.renameGroup', { name: groupName(group) })"
                  :aria-label="t('nav.renameGroup', { name: groupName(group) })"
                  @click="openConversationRename(group)"
                >
                  <PencilOutline />
                </button>
                <span class="sidebar-delete-control">
                  <button
                    class="direct-session-action danger"
                    type="button"
                    :title="t('nav.deleteGroup', { name: groupName(group) })"
                    :aria-label="t('nav.deleteGroup', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openSidebarConversationDelete(group, $event)"
                  >
                    <TrashOutline />
                  </button>
                </span>
              </span>
            </div>
            <button
              v-if="hasMoreGroupGroups"
              class="sidebar-more-button"
              type="button"
              :title="t(groupSessionListExpanded ? 'nav.lessGroups' : 'nav.moreGroups', {
                count: remainingGroupGroupsCount,
              })"
              :aria-label="t(groupSessionListExpanded ? 'nav.lessGroups' : 'nav.moreGroups', {
                count: remainingGroupGroupsCount,
              })"
              :aria-expanded="String(groupSessionListExpanded)"
              @click="toggleGroupSessionListExpanded"
            >
              <span>{{ t(groupSessionListExpanded ? 'nav.lessItems' : 'nav.moreItems') }}</span>
            </button>
          </div>
          <p v-else class="nav-empty">{{ t('nav.noGroups') }}</p>
        </div>
      </section>
    </nav>

    <div v-if="sidebarCollapsed" class="collapsed-group-switcher">
      <button
        ref="collapsedGroupMenuButton"
        class="icon-button collapsed-group-switcher-button"
        :class="{ active: collapsedGroupMenuOpen }"
        type="button"
        :title="t('nav.switchGroup')"
        :aria-label="t('nav.switchGroup')"
        :aria-expanded="String(collapsedGroupMenuOpen)"
        aria-haspopup="dialog"
        aria-controls="collapsed-group-menu"
        @click="toggleCollapsedGroupMenu"
      >
        <ChatbubblesOutline />
        <span
          v-if="groupGroups.some(group => isGroupAwaitingDecision(group.id))"
          class="attention-dot collapsed-group-attention"
          aria-hidden="true"
        />
      </button>
    </div>


  </aside>

  <Teleport to="body">
    <section
      v-if="collapsedGroupMenuOpen"
      id="collapsed-group-menu"
      ref="collapsedGroupMenu"
      class="collapsed-group-menu"
      role="dialog"
      :aria-label="t('nav.switchGroup')"
      :style="collapsedGroupMenuStyle"
    >
      <header class="collapsed-group-menu-header">
        <span class="collapsed-group-menu-icon"><PeopleOutline /></span>
        <span>
          <strong>{{ t('nav.groups') }}</strong>
          <small>{{ t('nav.groupCount', { count: groupGroups.length }) }}</small>
        </span>
      </header>
      <div v-if="groupGroups.length" class="collapsed-group-menu-list">
        <button
          v-for="group in groupGroups"
          :key="group.id"
          class="collapsed-group-option"
          :class="{ active: activeView === 'conversation' && selectedGroupId === group.id }"
          type="button"
          :title="t('nav.openGroup', { name: groupName(group) })"
          :aria-current="activeView === 'conversation' && selectedGroupId === group.id ? 'page' : undefined"
          @click="selectGroup(group.id)"
        >
          <span class="group-avatar stack" :aria-label="groupAgentSummary(group)">
            <img v-for="kind in group.agentKinds.slice(0, 3)" :key="kind" :src="agentLogo(kind, theme)" alt="" />
          </span>
          <span class="collapsed-group-option-main">
            <strong>{{ groupName(group) }}</strong>
            <small>{{ groupAgentSummary(group) }}</small>
          </span>
          <span class="collapsed-group-option-state">
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
              role="img"
              :title="t('nav.runFinished')"
              :aria-label="t('nav.runFinished')"
            >
              <CheckmarkCircleOutline aria-hidden="true" />
            </span>
            <CheckmarkCircleOutline v-else-if="isSelectedConversation(group)" aria-hidden="true" />
            <time v-else>{{ formatNavTime(group.updatedAt || group.createdAt) }}</time>
          </span>
        </button>
      </div>
      <p v-else class="collapsed-group-menu-empty">{{ t('nav.noGroups') }}</p>
    </section>
  </Teleport>

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
  PencilOutline,
  PeopleOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeView,
  agentState,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  collapsedGroupMenuStyle,
  contentInteractionBlocked,
  createDirectSession,
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
  openSidebarConversationDelete,
  pendingDecisionCount,
  pendingDecisionItems,
  pendingDecisionLabel,
  pendingDecisionsExpanded,
  productMark,
  projectRoomEntries,
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

function projectInitial(name) {
  return String(name || '').trim().slice(0, 1).toUpperCase() || '•'
}

const sidebarAgentCount = computed(() => (
  unref(sidebarAgentGroups).reduce((total, group) => total + group.agents.length, 0)
))

function agentAwaitingDecision(kind) {
  return directGroupsFor(kind).some(group => isGroupAwaitingDecision(group.id))
}
</script>
