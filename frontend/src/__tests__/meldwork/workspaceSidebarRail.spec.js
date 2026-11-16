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
    addTeamChat: vi.fn(),
    activeView: ref('home'),
    agentState: () => ({ label: 'Ready' }),
    contentInteractionBlocked: ref(false),
    createDirectSession: vi.fn(),
    deleteProjectRoom: vi.fn(),
    deleteSidebarConversation: vi.fn(),
    deleteTeamChat: vi.fn(),
    deleteTeamRoom: vi.fn(),
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
    handleTeamRoomClick: vi.fn(),
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
    isTeamChatSelected: () => false,
    isTeamRoomExpanded: () => false,
    isTeamRoomSelected: () => false,
    openConversationRename: vi.fn(),
    openNewGroup: vi.fn(),
    openProjectCreate: vi.fn(),
    openTeamRoomCreate: vi.fn(),
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
    selectTeamChat: vi.fn(),
    selectedGroupId: ref(''),
    sidebarAgentSessionListId: kind => `agent-${kind}`,
    sidebarAgentGroups: ref([{ id: 'local', titleKey: 'agentLocation.local', agents: [agent] }]),
    sidebarAgentsCollapsed: ref(false),
    sidebarGroupsCollapsed: ref(false),
    sidebarCollapsed: ref(true),
    sidebarDeleteGroup: ref(null),
    sidebarDeletePopoverStyle: {},
    t: key => key,
    teamRooms: ref([]),
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
  it('places team rooms below legacy projects and offers team-room creation', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.openRoomWorkspace = vi.fn()
    fixture.sidebarCollapsed.value = false
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })
    const projectSection = wrapper.get('.project-room-nav-section')
    const teamSection = wrapper.get('.team-room-nav-section')
    expect(
      projectSection.element.compareDocumentPosition(teamSection.element)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await wrapper.get('.team-room-add').trigger('click')
    expect(fixture.openTeamRoomCreate).toHaveBeenCalled()
    expect(wrapper.find('.team-room-create').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders team rooms with expandable chat children and chat actions', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.sidebarCollapsed.value = false
    fixture.teamRooms = ref([{
      id: 'team-1',
      name: 'Team Alpha',
      primary_chat_id: 'chat-1',
      chats: [
        { id: 'chat-1', title: 'Team chat', is_primary: true },
        { id: 'chat-2', title: 'Research', is_primary: false },
      ],
    }])
    fixture.isTeamRoomExpanded = () => true
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.get('.team-room-nav-section').text()).toContain('Team Alpha')
    const chats = wrapper.findAll('.team-room-chats .project-room-group')
    expect(chats).toHaveLength(2)
    expect(chats[0].text()).toContain('room.primaryChat')

    await chats[1].trigger('click')
    expect(fixture.selectTeamChat).toHaveBeenCalledWith('team-1', 'chat-2')

    await wrapper.get('.team-room-row .project-room-open').trigger('click')
    expect(fixture.handleTeamRoomClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'team-1' }))

    await wrapper.get('.team-room-add-chat').trigger('click')
    expect(fixture.addTeamChat).toHaveBeenCalledWith('team-1')

    await wrapper.get('.team-room-delete').trigger('click')
    await nextTick()
    expect(document.body.querySelector('.team-delete-backdrop')).not.toBeNull()
    document.body.querySelector('.sidebar-delete-popover .danger-button')?.click()
    await nextTick()
    expect(fixture.deleteTeamRoom).toHaveBeenCalledWith('team-1')

    await wrapper.findAll('.team-room-delete-chat').at(-1).trigger('click')
    await nextTick()
    document.body.querySelector('.sidebar-delete-popover .danger-button')?.click()
    await nextTick()
    expect(fixture.deleteTeamChat).toHaveBeenCalledWith('team-1', 'chat-2')
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
