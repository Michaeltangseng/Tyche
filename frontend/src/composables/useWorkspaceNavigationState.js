import { computed, ref, watch } from 'vue'

const ACTIVE_RUN_PHASES = new Set(['preparing', 'running', 'waiting'])
const TERMINAL_AGENT_STATUSES = new Set([
  'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted',
])

function runStillActive(run) {
  if (!ACTIVE_RUN_PHASES.has(String(run?.phase || '').toLowerCase())) return false
  const targetKinds = Array.isArray(run?.targetKinds) ? run.targetKinds : []
  if (!targetKinds.length || run?.mode === 'auto') return true
  const completed = new Set(Array.isArray(run?.completedKinds) ? run.completedKinds : [])
  const latestStatusByKind = new Map()
  for (const agent of Array.isArray(run?.agentRuns) ? run.agentRuns : []) {
    if (!agent?.kind) continue
    latestStatusByKind.set(agent.kind, String(agent.status || '').toLowerCase())
  }
  return targetKinds.some(kind => (
    !completed.has(kind) && !TERMINAL_AGENT_STATUSES.has(latestStatusByKind.get(kind))
  ))
}

export function useWorkspaceNavigationState({
  clearSidebarDeleteState,
  closeCollapsedGroupMenu,
  closeTracePanel,
  directGroupsFor,
  flushPendingRunFinishedEvents,
  hasFinishedDirectRun,
  isDirectCreationPending,
  openAgentManager,
  openDirect,
  preloadAgentSkills,
  setFinishedDirectRun,
  setSidebarAgentExpanded,
  sidebarCollapsed,
  snapshot,
  sortByUpdated,
  t,
  toggleSidebarAgentExpanded,
}) {
  const activeView = ref('home')
  const selectedGroupId = ref('')
  const projectTarget = ref(null)
  const expandedProjectRoomIds = ref([])
  const pendingDecisionsExpanded = ref(false)
  let pendingRequestedGroupId = ''

  const activeGroup = computed(() => (
    snapshot.value.groups.find(group => group.id === selectedGroupId.value) || null
  ))
  const activeProjectId = computed(() => activeGroup.value?.projectId || '')
  const activeGroupMemberSignature = computed(() => {
    const group = activeGroup.value
    return group ? [group.id, ...group.agentKinds].join('\u0000') : ''
  })

  function projectGroupsFor(projectId) {
    const groups = snapshot.value.groups
      .filter(group => group.projectId === projectId)
      .sort(sortByUpdated)
    const main = groups.find(group => group.projectRole === 'main')
    return main ? [main, ...groups.filter(group => group !== main)] : groups
  }

  const projectRoomEntries = computed(() => (
    Array.isArray(snapshot.value.projectRooms) ? snapshot.value.projectRooms : []
  ).map(project => ({
    ...project,
    groups: projectGroupsFor(project.projectId),
  })))
  const pendingDecisionItems = computed(() => (
    Array.isArray(snapshot.value.pendingDecisions?.items)
      ? snapshot.value.pendingDecisions.items
      : []
  ))
  const pendingDecisionCount = computed(() => {
    const total = Number(snapshot.value.pendingDecisions?.total)
    return Number.isInteger(total) && total >= 0 ? total : pendingDecisionItems.value.length
  })

  function isProjectRoomExpanded(projectId) {
    return expandedProjectRoomIds.value.includes(String(projectId || ''))
  }

  function toggleProjectRoomExpanded(projectId) {
    const id = String(projectId || '')
    if (!id) return
    expandedProjectRoomIds.value = expandedProjectRoomIds.value.includes(id)
      ? expandedProjectRoomIds.value.filter(item => item !== id)
      : [...expandedProjectRoomIds.value, id]
  }

  function isProjectRoomSelected(projectId) {
    return activeProjectId.value === String(projectId || '')
  }

  function togglePendingDecisions() {
    pendingDecisionsExpanded.value = !pendingDecisionsExpanded.value
  }

  function projectRoomStatusLabel(project) {
    if (project?.deleting?.phase === 'draining') return t('projectRoom.deleting.draining')
    if (project?.deleting?.phase === 'drained') return t('projectRoom.deleting.drained')
    if (project?.readOnly) return t('projectRoom.sidebar.readOnly')
    return String(project?.displayName || '')
  }

  function pendingDecisionLabel(item) {
    const type = String(item?.type || '')
    const key = type === 'gate' ? 'gate'
      : type === 'drift' ? 'drift'
        : type === 'residual' ? 'residual'
          : type === 'suspended' ? 'suspended' : 'generic'
    const label = t(`projectRoom.pending.${key}`)
    const checkpoint = String(item?.checkpointName || '')
    return checkpoint ? `${checkpoint} · ${label}` : label
  }

  function formatWaiting(waitingMs) {
    const minutes = Math.max(0, Math.floor((Number(waitingMs) || 0) / 60000))
    if (minutes < 1) return t('projectRoom.pending.justNow')
    if (minutes < 60) return t('projectRoom.pending.minutes', { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('projectRoom.pending.hours', { count: hours })
    return t('projectRoom.pending.days', { count: Math.floor(hours / 24) })
  }

  function selectProjectRoom(projectId, target = null) {
    const id = String(projectId || '')
    if (!id) return false
    const groups = projectGroupsFor(id)
    const main = groups.find(group => group.projectRole === 'main') || groups[0]
    if (!main) return false
    if (!expandedProjectRoomIds.value.includes(id)) {
      expandedProjectRoomIds.value = [...expandedProjectRoomIds.value, id]
    }
    selectGroup(main.id)
    projectTarget.value = target ? { projectId: id, ...target } : null
    return true
  }

  function selectPendingDecision(item) {
    const projectId = String(item?.projectId || '')
    if (!projectId) return false
    return selectProjectRoom(projectId, {
      type: String(item?.type || ''),
      checkpointId: item?.checkpointId || '',
      itemId: item?.itemId || '',
      reason: item?.reason || '',
      waitingSince: item?.waitingSince || null,
    })
  }

  function handleSidebarAgentMain(agent) {
    if (!agent || isDirectCreationPending(agent.kind)) return
    if (sidebarCollapsed.value) {
      void openDirect(agent)
      return
    }
    if (directGroupsFor(agent.kind).length) {
      toggleSidebarAgentExpanded(agent.kind)
      return
    }
    void openDirect(agent)
  }

  function handleAgentPrimary(agent) {
    if (agent.ready) openDirect(agent)
    else openAgentManager(agent.kind)
  }

  function goHome() {
    closeCollapsedGroupMenu()
    activeView.value = 'home'
    projectTarget.value = null
    clearSidebarDeleteState()
    pendingRequestedGroupId = ''
    closeTracePanel()
  }

  function selectGroup(id) {
    closeCollapsedGroupMenu()
    const group = snapshot.value.groups.find(item => item.id === id)
    if (!group) {
      selectedGroupId.value = ''
      activeView.value = 'home'
      return
    }
    activeView.value = 'conversation'
    projectTarget.value = null
    closeTracePanel()
    clearSidebarDeleteState()
    selectedGroupId.value = id
    if (group.projectId && !expandedProjectRoomIds.value.includes(group.projectId)) {
      expandedProjectRoomIds.value = [...expandedProjectRoomIds.value, group.projectId]
    }
    if (group.conversationType === 'direct' && group.directAgentKind) {
      setSidebarAgentExpanded(group.directAgentKind, true)
    }
    void preloadAgentSkills(group.agentKinds)
    if (hasFinishedDirectRun(id)) setFinishedDirectRun(id, false)
  }

  function isGroupRunning(id) {
    const groupRuns = (Array.isArray(snapshot.value.runs) ? snapshot.value.runs : [])
      .filter(run => run?.groupId === id)
    if (groupRuns.length) return groupRuns.some(runStillActive)
    const hasConversationActivity = (Array.isArray(snapshot.value.messages) ? snapshot.value.messages : [])
      .some(message => message?.groupId === id)
    return hasConversationActivity && snapshot.value.runningGroupIds.includes(id)
  }

  function openPendingRequestedGroup() {
    if (!pendingRequestedGroupId
        || !snapshot.value.groups.some(group => group.id === pendingRequestedGroupId)) return false
    const groupId = pendingRequestedGroupId
    pendingRequestedGroupId = ''
    selectGroup(groupId)
    return true
  }

  function handleOpenGroup(event) {
    const groupId = String(event?.groupId || '')
    if (!groupId) return
    pendingRequestedGroupId = groupId
    openPendingRequestedGroup()
  }

  watch(() => snapshot.value.groups.map(group => group.id).join('\u0000'), () => {
    openPendingRequestedGroup()
    if (selectedGroupId.value
        && !snapshot.value.groups.some(group => group.id === selectedGroupId.value)) {
      selectedGroupId.value = ''
      if (activeView.value === 'conversation') activeView.value = 'home'
    } else if (activeView.value === 'conversation' && !selectedGroupId.value) {
      activeView.value = 'home'
    }
    flushPendingRunFinishedEvents()
  })

  return {
    activeGroup,
    activeGroupMemberSignature,
    activeProjectId,
    activeView,
    formatWaiting,
    goHome,
    handleAgentPrimary,
    handleOpenGroup,
    handleSidebarAgentMain,
    isGroupRunning,
    isProjectRoomExpanded,
    isProjectRoomSelected,
    pendingDecisionCount,
    pendingDecisionItems,
    pendingDecisionLabel,
    pendingDecisionsExpanded,
    projectRoomEntries,
    projectRoomStatusLabel,
    projectTarget,
    selectGroup,
    selectPendingDecision,
    selectProjectRoom,
    selectedGroupId,
    togglePendingDecisions,
    toggleProjectRoomExpanded,
  }
}
