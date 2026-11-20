import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../../components/WorkspaceSidebar.vue'

function controller() {
  const agent = { kind: 'codex', label: 'Codex', logo: './codex.svg', ready: true }
  return {
    addTeamChat: vi.fn(),
    activeView: ref('home'),
    agentState: () => ({ label: 'Ready' }),
    contentInteractionBlocked: ref(false),
    createDirectSession: vi.fn(),
    deleteSidebarConversation: vi.fn(),
    deleteTeamChat: vi.fn(),
    deleteTeamRoom: vi.fn(),
    directGroupsFor: () => [],
    discoveringAgents: ref(false),
    dismissSidebarDeleteConfirmation: vi.fn(),
    formatNavTime: () => '',
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
    isSidebarAgentExpanded: () => false,
    isTeamChatSelected: () => false,
    isTeamRoomExpanded: () => false,
    isTeamRoomSelected: () => false,
    openConversationRename: vi.fn(),
    openNewGroup: vi.fn(),
    openTeamRoomCreate: vi.fn(),
    openSidebarConversationDelete: vi.fn(),
    productMark: '',
    remainingDirectGroupsCount: () => 0,
    remainingGroupGroupsCount: () => 0,
    saving: ref(false),
    selectGroup: vi.fn(),
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
    visibleDirectGroupsFor: () => [],
    visibleGroupGroups: () => [],
  }
}

describe('workspace sidebar rail', () => {
  it('offers team-room creation in the expanded sidebar', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.openRoomWorkspace = vi.fn()
    fixture.sidebarCollapsed.value = false
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })
    const teamSection = wrapper.get('.team-room-nav-section')
    expect(teamSection.exists()).toBe(true)
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

  it('filters the sidebar from search and opens settings from the footer', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.sidebarCollapsed.value = false
    fixture.openSystemSettings = vi.fn()
    fixture.teamRooms = ref([
      { id: 'team-1', name: 'Alpha', chats: [{ id: 'chat-1', title: 'Research', is_primary: true }] },
      { id: 'team-2', name: 'Beta', chats: [{ id: 'chat-2', title: 'Notes', is_primary: true }] },
    ])
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.get('.member-presence').attributes('data-tone')).toBe('ready')
    expect(wrapper.get('.sidebar-agent-main').attributes('title')).toContain('nav.agentIdle')
    await wrapper.get('.sidebar-search input').setValue('beta')
    expect(wrapper.findAll('.team-room-entry')).toHaveLength(1)
    expect(wrapper.text()).toContain('Beta')
    expect(wrapper.text()).not.toContain('Codex')

    await wrapper.get('.sidebar-footer .icon-button').trigger('click')
    expect(fixture.openSystemSettings).toHaveBeenCalledWith('agents')
    wrapper.unmount()
  })

  it('keeps agent entries in the collapsed rail', async () => {
    const fixture = controller()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.find('.conversation-nav').exists()).toBe(false)
    expect(wrapper.find('.sidebar-rail').exists()).toBe(true)

    const [agentButton] = wrapper.findAll('.sidebar-rail-item')
    expect(agentButton.attributes('aria-label')).toBe('Codex')

    await agentButton.trigger('click')
    expect(fixture.handleSidebarAgentMain).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'codex' }),
    )
  })

  it('renders agents before team rooms when the sidebar expands', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.openRoomWorkspace = vi.fn()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    fixture.sidebarCollapsed.value = false
    await nextTick()

    expect(wrapper.find('.sidebar-rail').exists()).toBe(false)
    const agentSection = wrapper.get('.agent-nav-section')
    const teamSection = wrapper.get('.team-room-nav-section')
    expect(
      agentSection.element.compareDocumentPosition(teamSection.element)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
