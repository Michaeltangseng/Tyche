import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspaceNavigationState } from '../../composables/useWorkspaceNavigationState.js'

function group(id, options = {}) {
  return {
    id,
    agentKinds: ['codex'],
    conversationType: 'group',
    ...options,
  }
}

function createNavigation() {
  const snapshot = ref({
    groups: [group('group-1')],
    runningGroupIds: [],
    messages: [],
    runs: [],
  })
  const dependencies = {
    clearSidebarDeleteState: vi.fn(),
    closeCollapsedGroupMenu: vi.fn(),
    closeTracePanel: vi.fn(),
    directGroupsFor: vi.fn(() => []),
    flushPendingRunFinishedEvents: vi.fn(),
    hasFinishedDirectRun: vi.fn(() => false),
    isDirectCreationPending: vi.fn(() => false),
    openAgentManager: vi.fn(),
    openDirect: vi.fn(),
    preloadAgentSkills: vi.fn(),
    setFinishedDirectRun: vi.fn(),
    setSidebarAgentExpanded: vi.fn(),
    sidebarCollapsed: ref(false),
    snapshot,
    sortByUpdated: (left, right) => (
      (Date.parse(right.updatedAt || right.createdAt || '') || 0)
      - (Date.parse(left.updatedAt || left.createdAt || '') || 0)
    ),
    t: key => key,
    toggleSidebarAgentExpanded: vi.fn(),
  }
  return {
    dependencies,
    navigation: useWorkspaceNavigationState(dependencies),
    snapshot,
  }
}

describe('workspace navigation state', () => {
  it('opens a pending external group once it appears in the snapshot', async () => {
    const { dependencies, navigation, snapshot } = createNavigation()

    navigation.handleOpenGroup({ groupId: 'group-2' })
    expect(navigation.selectedGroupId.value).toBe('')

    snapshot.value = {
      ...snapshot.value,
      groups: [...snapshot.value.groups, group('group-2')],
    }
    await nextTick()

    expect(navigation.activeView.value).toBe('conversation')
    expect(navigation.selectedGroupId.value).toBe('group-2')
    expect(dependencies.preloadAgentSkills).toHaveBeenCalledTimes(1)

    snapshot.value = { ...snapshot.value, groups: [...snapshot.value.groups] }
    await nextTick()
    expect(dependencies.preloadAgentSkills).toHaveBeenCalledTimes(1)
  })

  it('keeps a valid conversation selected while an unknown external group is pending', () => {
    const { navigation } = createNavigation()

    navigation.selectGroup('group-1')
    navigation.handleOpenGroup({ groupId: 'missing-group' })

    expect(navigation.activeView.value).toBe('conversation')
    expect(navigation.selectedGroupId.value).toBe('group-1')
  })

  it('returns to home only after the selected group is removed', async () => {
    const { navigation, snapshot } = createNavigation()
    navigation.selectGroup('group-1')

    snapshot.value = { ...snapshot.value, groups: [] }
    await nextTick()

    expect(navigation.activeView.value).toBe('home')
    expect(navigation.selectedGroupId.value).toBe('')
  })

  it('opens a project room main chat and records a pending decision target', () => {
    const { navigation, snapshot } = createNavigation()
    snapshot.value = {
      ...snapshot.value,
      groups: [
        group('main-1', {
          projectId: 'project-1', projectRole: 'main', name: 'Main chat',
          updatedAt: '2026-07-29T08:00:00Z',
        }),
        group('chat-1', {
          projectId: 'project-1', name: 'Tech talk', updatedAt: '2026-07-29T09:00:00Z',
        }),
        group('ordinary-1', { name: 'Ordinary' }),
      ],
      projectRooms: [{
        projectId: 'project-1',
        name: 'Project One',
        displayName: 'repo',
        pendingGateCount: 1,
      }],
      pendingDecisions: {
        items: [{
          type: 'gate',
          projectId: 'project-1',
          projectName: 'Project One',
          checkpointId: 'checkpoint-1',
          checkpointName: 'Requirements',
          reason: 'needs-human',
          itemId: 'gate-1',
          waitingSince: '2026-07-29T08:00:00Z',
          waitingMs: 60000,
        }],
        total: 1,
      },
    }

    expect(navigation.projectRoomEntries.value).toHaveLength(1)
    expect(navigation.projectRoomEntries.value[0].groups.map(item => item.id))
      .toEqual(['main-1', 'chat-1'])
    expect(navigation.isProjectRoomExpanded('project-1')).toBe(false)

    expect(navigation.selectPendingDecision(navigation.pendingDecisionItems.value[0])).toBe(true)
    expect(navigation.activeView.value).toBe('conversation')
    expect(navigation.selectedGroupId.value).toBe('main-1')
    expect(navigation.isProjectRoomExpanded('project-1')).toBe(true)
    expect(navigation.projectTarget.value).toEqual({
      projectId: 'project-1',
      type: 'gate',
      checkpointId: 'checkpoint-1',
      itemId: 'gate-1',
      reason: 'needs-human',
      waitingSince: '2026-07-29T08:00:00Z',
    })

    navigation.selectGroup('ordinary-1')
    expect(navigation.projectTarget.value).toBe(null)
    expect(navigation.selectedGroupId.value).toBe('ordinary-1')
  })

  it('ignores stale running ids for empty groups without a live run', () => {
    const { navigation, snapshot } = createNavigation()
    snapshot.value = {
      ...snapshot.value,
      runningGroupIds: ['group-1'],
      runs: [],
      messages: [],
    }

    expect(navigation.isGroupRunning('group-1')).toBe(false)

    snapshot.value = {
      ...snapshot.value,
      runs: [{
        runId: 'run-1',
        groupId: 'group-1',
        phase: 'running',
        targetKinds: ['codex'],
        agentRuns: [{ agentRunId: 'agent-1', kind: 'codex', status: 'running' }],
      }],
    }

    expect(navigation.isGroupRunning('group-1')).toBe(true)
  })
})
