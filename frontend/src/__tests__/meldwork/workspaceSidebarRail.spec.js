import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../../components/WorkspaceSidebar.vue'

function controller() {
  const agent = { kind: 'codex', label: 'Codex', logo: './codex.svg', ready: true }
  const project = {
    projectId: 'project-1',
    name: 'Alpha',
    groups: [],
    pendingGateCount: 0,
    unresolvedDriftCount: 0,
    residualCount: 0,
    readOnly: false,
    deleting: null,
  }
  return {
    addProjectChat: vi.fn(),
    activeView: ref('home'),
    agentState: () => ({ label: 'Ready' }),
    contentInteractionBlocked: ref(false),
    createDirectSession: vi.fn(),
    deleteProjectRoom: vi.fn(),
    deleteSidebarConversation: vi.fn(),
    directGroupsFor: () => [],
    discoveringAgents: ref(false),
    dismissSidebarDeleteConfirmation: vi.fn(),
    formatNavTime: () => '',
    formatWaiting: () => '',
    goHome: vi.fn(),
    groupAgentSummary: () => '',
    groupGroups: () => [],
    groupName: group => group.name,
    groupSessionListExpanded: () => false,
    handleSidebarAgentMain: vi.fn(),
    hasFinishedDirectRun: () => false,
    hasMoreDirectGroups: () => false,
    hasMoreGroupGroups: () => false,
    isDirectCreationPending: () => false,
    isDirectSessionListExpanded: () => false,
    isGroupAwaitingDecision: () => false,
    isGroupRunning: () => false,
    isProjectRoomExpanded: () => false,
    isProjectRoomSelected: () => false,
    isSidebarAgentExpanded: () => false,
    openConversationRename: vi.fn(),
    openNewGroup: vi.fn(),
    openProjectCreate: vi.fn(),
    openSidebarConversationDelete: vi.fn(),
    pendingDecisionCount: ref(0),
    pendingDecisionItems: ref([]),
    pendingDecisionLabel: () => '',
    pendingDecisionsExpanded: ref(false),
    productMark: '',
    projectRoomEntries: ref([project]),
    projectRoomPreviewEnabled: ref(true),
    projectRoomStatusLabel: () => 'Idle',
    remainingDirectGroupsCount: () => 0,
    remainingGroupGroupsCount: () => 0,
    saving: ref(false),
    selectGroup: vi.fn(),
    selectPendingDecision: vi.fn(),
    selectProjectRoom: vi.fn(),
    selectedGroupId: ref(''),
    sidebarAgentSessionListId: kind => `agent-${kind}`,
    sidebarAgentGroups: ref([{ id: 'local', titleKey: 'agentLocation.local', agents: [agent] }]),
    sidebarAgentsCollapsed: ref(false),
    sidebarGroupsCollapsed: ref(false),
    sidebarCollapsed: ref(true),
    sidebarDeleteGroup: ref(null),
    sidebarDeletePopoverStyle: {},
    t: key => key,
    theme: ref('dark'),
    toggleCollapsedGroupMenu: vi.fn(),
    toggleDirectSessionListExpanded: vi.fn(),
    toggleGroupSessionListExpanded: vi.fn(),
    togglePendingDecisions: vi.fn(),
    toggleProjectRoomExpanded: vi.fn(),
    visibleDirectGroupsFor: () => [],
    visibleGroupGroups: () => [],
  }
}

describe('workspace sidebar rail', () => {
  it('hides the legacy project tree while viewing team rooms', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.openRoomWorkspace = vi.fn()
    fixture.activeView.value = 'rooms'
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })
    expect(wrapper.find('.sidebar-rail-project').exists()).toBe(false)
    fixture.sidebarCollapsed.value = false
    await nextTick()
    expect(wrapper.find('.project-room-nav-section').exists()).toBe(false)
    fixture.activeView.value = 'home'
    await nextTick()
    expect(wrapper.get('.project-room-nav-section').text()).toContain('room.legacyProjects')
    wrapper.unmount()
  })
  it('keeps agent and project entries in the collapsed rail', async () => {
    const fixture = controller()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.find('.conversation-nav').exists()).toBe(false)
    expect(wrapper.find('.sidebar-rail').exists()).toBe(true)

    const [agentButton, projectButton] = wrapper.findAll('.sidebar-rail-item')
    expect(agentButton.attributes('aria-label')).toBe('Codex')
    expect(wrapper.get('.sidebar-rail-project').text()).toContain('A')

    await agentButton.trigger('click')
    expect(fixture.handleSidebarAgentMain).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'codex' }),
    )
    await projectButton.trigger('click')
    expect(fixture.selectProjectRoom).toHaveBeenCalledWith('project-1')
  })

  it('renders agents before project rooms when the sidebar expands', async () => {
    const fixture = controller()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    fixture.sidebarCollapsed.value = false
    await nextTick()

    expect(wrapper.find('.sidebar-rail').exists()).toBe(false)
    const agentSection = wrapper.get('.agent-nav-section')
    const projectSection = wrapper.get('.project-room-nav-section')
    expect(
      agentSection.element.compareDocumentPosition(projectSection.element)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
