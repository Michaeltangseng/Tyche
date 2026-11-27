import { nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../../components/WorkspaceSidebar.vue'

function controller() {
  const agent = { kind: 'codex', label: 'Codex', logo: './codex.svg', ready: true }
  return {
    addTeamChat: vi.fn(),
    activeView: ref('home'),
    agentState: (agent) => (
      agent?.ready === false
        ? { label: 'Needs a model', tone: 'warning' }
        : { label: 'Ready', tone: 'ready' }
    ),
    contentInteractionBlocked: ref(false),
    createDirectSession: vi.fn(),
    deleteSidebarConversation: vi.fn(),
    deleteTeamChat: vi.fn(),
    deleteTeamRoom: vi.fn(),
    renameTeamChat: vi.fn(),
    setTeamWorkspace: vi.fn(async () => ({ roomId: 'team-1', moved: false })),
    pickTeamDirectory: vi.fn(async () => '/tmp/picked'),
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
  beforeEach(() => localStorage.clear())

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
      workspace_path: '/tmp/tyche-demo',
      primary_chat_id: 'chat-1',
      chats: [
        {
          id: 'chat-2',
          title: 'Research',
          is_primary: false,
          activity_seq: 2,
          activity: { name: 'Claude', author: 'agent', status: 'done', text: 'The date is December 25.', created_at: '2026-11-20T09:00:00Z' },
        },
        {
          id: 'chat-1',
          title: 'Team chat',
          is_primary: true,
          activity_seq: 4,
          members: [
            { name: 'Claude', provider: 'claude', last_seq: 1 },
            { name: 'Codex', provider: 'codex', last_seq: 4 },
            { name: 'Pi', provider: 'pi', last_seq: 3 },
            { name: 'Gemini', provider: 'gemini', last_seq: 2 },
          ],
          activity: { name: 'Pi', author: 'agent', status: 'done', text: 'snake.html', created_at: '2026-11-20T10:00:00Z' },
        },
      ],
    }])
    fixture.isTeamRoomExpanded = () => true
    fixture.isTeamChatSelected = (roomId, chatId) => chatId === 'chat-1'
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })
    const rows = wrapper.findAll('.team-chat-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Team chat')
    expect(rows[0].text()).toContain('room.activityLine')
    expect(rows[1].text()).toContain('Research')
    expect(rows[1].text()).toContain('room.activityLine')
    expect(wrapper.text()).not.toContain('room.scratchLabel')
    expect(wrapper.find('.team-room-chats').exists()).toBe(false)
    expect(wrapper.find('.team-face-stack-chat').exists()).toBe(false)
    const mascots = wrapper.findAll('.team-chat-row .team-member-mascot .room-mascot-art svg')
    expect(mascots).toHaveLength(4)
    expect(mascots[0].element.getAttribute('viewBox')).toBe('0 0 64 64')
    expect(wrapper.get('.room-mascot-art').html()).not.toContain('<style')

    await rows[1].get('.project-room-open').trigger('click')
    expect(fixture.selectTeamChat).toHaveBeenCalledWith('team-1', 'chat-2')

    await wrapper.get('.team-room-add').trigger('click')
    expect(fixture.openTeamRoomCreate).toHaveBeenCalled()

    const menuButton = rows[1].get('.team-chat-menu')
    menuButton.element.getBoundingClientRect = () => ({ top: 40, right: 204, bottom: 64, left: 180, width: 24, height: 24 })
    await menuButton.trigger('click')
    await nextTick()
    const menu = document.body.querySelector('.team-chat-menu-popover')
    expect(menu?.textContent).toContain('room.renameChatAction')
    expect(menu?.textContent).toContain('room.deleteConfirm')
    expect(menu?.textContent).toContain('room.switchWorkspace')
    expect(menu.querySelector('.team-chat-workspace')).toBeNull()
    expect(menu?.style.left).toBe('210px')
    expect(menu?.style.top).toBe('40px')
    menu.querySelector('.team-chat-menu-delete')?.click()
    await nextTick()
    document.body.querySelector('.sidebar-delete-popover .danger-button')?.click()
    await nextTick()
    expect(fixture.deleteTeamChat).toHaveBeenCalledWith('team-1', 'chat-2')

    await menuButton.trigger('click')
    await nextTick()
    document.body.querySelector('.team-chat-menu-workspace')?.click()
    await nextTick()
    const directoryDialog = document.body.querySelector('.team-workspace-dialog')
    const pathInput = directoryDialog.querySelector('.team-chat-workspace input')
    expect(pathInput?.value).toBe('/tmp/tyche-demo')
    document.body.querySelector('.team-chat-workspace-browse')?.click()
    await flushPromises()
    expect(pathInput.value).toBe('/tmp/picked')
    pathInput.value = '/tmp/project'
    pathInput.dispatchEvent(new Event('input', { bubbles: true }))
    directoryDialog.querySelector('.team-chat-workspace').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(fixture.setTeamWorkspace).toHaveBeenCalledWith('team-1', '/tmp/project', undefined)

    await rows[0].get('.team-chat-menu').trigger('click')
    await nextTick()
    document.body.querySelector('.team-chat-menu-rename')?.click()
    await nextTick()
    const input = wrapper.get('.team-chat-rename input')
    await input.setValue('Relay jokes')
    await input.trigger('keydown', { key: 'Enter' })
    expect(fixture.renameTeamChat).toHaveBeenCalledWith('team-1', 'chat-1', 'Relay jokes')
    wrapper.unmount()
  })

  it('shows member faces on unselected chats and only uses the chat icon for empty ones', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    fixture.sidebarCollapsed.value = false
    fixture.teamRooms = ref([{
      id: 'team-1',
      name: 'Team Alpha',
      primary_chat_id: 'chat-1',
      chats: [
        {
          id: 'chat-1',
          title: 'Team chat',
          is_primary: true,
          members: [
            { name: 'Claude', provider: 'claude', last_seq: 1 },
            { name: 'Codex', provider: 'codex', last_seq: 4 },
          ],
        },
        { id: 'chat-2', title: 'Empty', is_primary: false, members: [] },
      ],
    }])
    fixture.isTeamRoomExpanded = () => true
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    const chats = wrapper.findAll('.team-chat-row')
    expect(chats[0].find('.room-mascot-art svg').exists()).toBe(true)
    expect(chats[1].find('.room-mascot-art svg').exists()).toBe(true)
    expect(chats[0].find('.team-face-stack-chat').exists()).toBe(false)
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
    expect(wrapper.text()).toContain('Notes')
    expect(wrapper.text()).not.toContain('Codex')

    await wrapper.get('.sidebar-footer .icon-button').trigger('click')
    expect(fixture.openSystemSettings).toHaveBeenCalledWith('agents')
    wrapper.unmount()
  })

  it('hides local agents in the collapsed rail', async () => {
    const fixture = controller()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.find('.conversation-nav').exists()).toBe(false)
    expect(wrapper.find('.sidebar-rail').exists()).toBe(true)
    expect(wrapper.find('.sidebar-rail [aria-label="Codex"]').exists()).toBe(false)
    expect(wrapper.find('.sidebar-footer .sidebar-user-mark').exists()).toBe(true)
    expect(wrapper.find('.sidebar-footer .icon-button').exists()).toBe(true)
    wrapper.unmount()
  })

  it('stacks the latest chats in the collapsed rail', async () => {
    const fixture = controller()
    fixture.roomWorkspaceAvailable = ref(true)
    const chats = Array.from({ length: 9 }, (_, index) => ({
      id: `chat-${index + 1}`,
      title: `Chat ${index + 1}`,
      updated_at: `2026-11-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
      members: index === 8
        ? [
          { id: 'a', name: 'A', is_captain: true, last_seq: 1 },
          { id: 'b', name: 'B', last_seq: 3 },
          { id: 'c', name: 'C', last_seq: 2 },
          { id: 'd', name: 'D', last_seq: 0 },
        ]
        : [{ id: `solo-${index}`, name: 'Solo' }],
    }))
    fixture.teamRooms = ref([{ id: 'team-1', name: 'Team', primary_chat_id: 'chat-1', chats }])
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    expect(wrapper.find('.sidebar-rail [aria-label="Codex"]').exists()).toBe(false)
    const railChats = wrapper.findAll('.sidebar-rail-chat')
    expect(railChats).toHaveLength(8)
    expect(railChats[0].attributes('aria-label')).toBe('Chat 9')
    expect(railChats[0].get('.rail-chat-stack').attributes('data-count')).toBe('3')
    expect(railChats[0].findAll('.rail-chat-face')).toHaveLength(3)
    expect(railChats.at(-1).attributes('aria-label')).toBe('Chat 2')

    await railChats[0].trigger('pointerenter')
    expect(wrapper.get('.rail-chat-label').text()).toBe('Chat 9')
    expect(wrapper.get('.rail-chat-stick').attributes('data-traveling')).toBe('false')

    await railChats[1].trigger('pointerenter')
    expect(wrapper.get('.rail-chat-label').text()).toBe('Chat 8')
    expect(wrapper.get('.rail-chat-stick').attributes('data-traveling')).toBe('true')

    await railChats[0].trigger('click')
    expect(fixture.selectTeamChat).toHaveBeenCalledWith('team-1', 'chat-9')
    wrapper.unmount()
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

  it('keeps an unready local Agent in the collapsed cast with a warning dot', async () => {
    const fixture = controller()
    fixture.sidebarCollapsed.value = false
    fixture.sidebarAgentsCollapsed.value = true
    const localGroup = fixture.sidebarAgentGroups.value[0]
    fixture.sidebarAgentGroups.value = [{
      ...localGroup,
      agents: [
        ...localGroup.agents,
        { kind: 'hermes', label: 'Hermes', logo: './hermes.svg', ready: false },
      ],
    }]
    fixture.openSystemSettings = vi.fn()
    const wrapper = mount(WorkspaceSidebar, { props: { controller: fixture } })

    const cast = wrapper.findAll('.agent-cast-item')
    expect(cast).toHaveLength(2)
    expect(cast[0].attributes('title')).toContain('Codex')
    expect(cast[0].find('.agent-cast-face img').attributes('src')).toBe('./codex.svg')
    expect(cast[0].find('.agent-cast-status').attributes('data-tone')).toBe('ready')
    const hermes = wrapper.get('.agent-cast-item[title*="Hermes"]')
    expect(hermes.attributes('title')).toContain('Needs a model')
    expect(hermes.find('.agent-cast-status').attributes('data-tone')).toBe('warning')
    expect(wrapper.get('.agent-nav-section .nav-heading-count').text()).toBe('2')
    expect(wrapper.find('.sidebar-agent-main').exists()).toBe(false)

    await cast[0].trigger('click')
    expect(fixture.handleSidebarAgentMain).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'codex' }),
    )
    await wrapper.get('.agent-cast-add').trigger('click')
    expect(fixture.openSystemSettings).toHaveBeenCalledWith('agents')
    wrapper.unmount()
  })
})
