import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RoomWorkflow from '../../components/RoomWorkflow.vue'
import RoomWorkspace from '../../components/RoomWorkspace.vue'
import { setLocale } from '../../i18n.js'

function data() {
  return {
    room: {
      id: 'room-1',
      name: 'Demo room',
      workspace_label: 'demo',
      write_authorized: false,
      providers: ['codex', 'claude'],
      primary_chat_id: 'chat-1',
    },
    chats: [
      { id: 'chat-1', room_id: 'room-1', title: 'Main chat', status: 'active' },
      { id: 'chat-2', room_id: 'room-1', title: 'Research', status: 'active' },
    ],
    roles: [
      { id: 'captain', chat_id: 'chat-1', display_name: 'Captain', provider: 'claude', is_captain: true, native_permission: 'bypassPermissions', prompt: 'route', prompt_revision: 1 },
      { id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', is_captain: false, native_permission: 'danger-full-access', prompt: 'write', prompt_revision: 1 },
    ],
    messages: [],
    tasks: [],
    runs: [],
    reports: [],
    reviews: [],
    assignments: [],
    attentions: [],
    messages_have_older: [],
  }
}

function api(snapshot = data()) {
  let changed = null
  let runtimeEvent = null
  return {
    listRooms: vi.fn(async () => [{
      id: 'room-1',
      name: 'Demo room',
      primary_chat_id: 'chat-1',
      chats: snapshot.chats,
    }]),
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    chatMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    bootstrap: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1' })),
    renameChat: vi.fn(async ({ title }) => ({ chatId: 'chat-1', title })),
    deleteChat: vi.fn(async () => ({ deleted: true, chatId: 'chat-2' })),
    deleteRoom: vi.fn(async () => ({ deleted: true, roomId: 'room-1' })),
    createRole: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1', roleId: 'new-role' })),
    updateRole: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1', roleId: 'worker' })),
    setCaptain: vi.fn(async ({ roleId }) => ({ roomId: 'room-1', chatId: 'chat-1', roleId })),
    deleteRole: vi.fn(async () => ({ deleted: true, roomId: 'room-1', roleId: 'worker' })),
    answerAttention: vi.fn(async () => ({ attentionId: 'attention-1', status: 'answered' })),
    submitMessage: vi.fn(async () => ({ message: { id: 'message-1' }, replies: [] })),
    acceptTask: vi.fn(async () => ({ id: 'task-1', status: 'done' })),
    stopReply: vi.fn(async () => ({ stopped: true })),
    setWriteAuthorized: vi.fn(async ({ authorized }) => ({ roomId: 'room-1', authorized })),
    filesList: vi.fn(async () => ({ entries: [], hasMore: false })),
    filesRead: vi.fn(async () => ({ kind: 'text', text: '', totalBytes: 0, eof: true, encoding: 'utf-8' })),
    runtimeEvents: vi.fn(async () => []),
    onChanged: vi.fn(callback => {
      changed = callback
      return () => { changed = null }
    }),
    onRuntimeEvents: vi.fn(callback => {
      runtimeEvent = callback
      return () => { runtimeEvent = null }
    }),
    emitChanged: () => changed?.(),
    emitRuntimeEvent: payload => runtimeEvent?.([payload]),
  }
}

const cleanup = []
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose())
  delete window.tycheDesktop
  vi.useRealTimers()
})

function mountRoom(bridge, options = {}) {
  setLocale('en')
  const wrapper = mount(RoomWorkspace, {
    attachTo: document.body,
    props: {
      api: bridge,
      pickDirectory: vi.fn(async () => '/tmp/demo'),
      agents: [
        { kind: 'codex', label: 'Codex' },
        { kind: 'claude', label: 'Claude Code' },
      ],
      ...options,
    },
  })
  cleanup.push(() => wrapper.unmount())
  return wrapper
}

describe('team room workspace', () => {
  it('renders room roles, reports, tasks, runs, reviews, and captain badges', async () => {
    const snapshot = data()
    snapshot.messages = [
      {
        id: 'm1', chat_id: 'chat-1', sequence: 1, author_type: 'user', author_id: 'user',
        author_name: 'user', content: 'Please write the docs', status: 'done',
        mentions: ['worker'], created_at: '2026-11-15T10:00:00Z',
      },
    ]
    snapshot.tasks = [{
      id: 'task-1', chat_id: 'chat-1', number: 1, title: 'Write docs', status: 'in_review',
      description: 'Document the room domain', acceptance: 'Docs reviewed', assignee_role_id: 'worker',
      created_at: '2026-11-15T10:01:00Z',
    }]
    snapshot.runs = [{
      id: 'run-1', task_id: 'task-1', role_id: 'worker', lane_kind: 'executor',
      status: 'completed', outcome: 'known',
    }]
    snapshot.reports = [{
      id: 'report-1', task_id: 'task-1', run_id: 'run-1', kind: 'ready',
      summary: 'Docs are ready', evidence: ['docs/room.md'], artifact_ids: [],
      created_at: '2026-11-15T10:02:00Z',
    }]
    snapshot.reviews = [{
      id: 'review-1', chat_id: 'chat-1', kind: 'assignment_settled', status: 'pending',
      body: 'Assignment settled. Review the report.', created_at: '2026-11-15T10:03:00Z',
    }]
    snapshot.assignments = [{
      id: 'assignment-1', chat_id: 'chat-1', target_role_ids: ['worker'],
      status: 'settled', created_at: '2026-11-15T10:00:30Z',
    }]
    snapshot.artifacts = [{
      id: 'artifact-1',
      room_id: 'room-1',
      task_id: 'task-1',
      run_id: 'run-1',
      path: 'docs/room.md',
      kind: 'document',
      version: '1',
      status: 'ready',
      created_at: '2026-11-15T10:02:00Z',
    }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()

    expect(wrapper.get('.room-chat-title-text').text()).toBe('Main chat')
    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(2)
    expect(wrapper.get('.room-captain-mark').attributes('title')).toBe('Captain')
    expect(wrapper.get('.room-message').text()).toContain('Please write the docs')
    expect(wrapper.get('.room-mention-chip').text()).toBe('@Writer')
    expect(wrapper.get('.room-report-card').text()).toContain('Docs are ready')
    expect(wrapper.get('.room-report-card').text()).toContain('#1 Write docs')

    expect(wrapper.find('.room-work-toggle').exists()).toBe(false)
    expect(wrapper.find('[data-work-tab="artifacts"]').exists()).toBe(false)
    expect(wrapper.find('[data-work-tab="tasks"]').exists()).toBe(false)
    expect(wrapper.get('.room-ledger').text()).toContain('Write docs')
    expect(wrapper.get('.room-flow-node').text()).toContain('Writer')
    expect(wrapper.find('.room-flow-node[data-live="true"]').exists()).toBe(false)

    await wrapper.get('.room-usage-toggle').trigger('click')
    expect(wrapper.get('.room-work-tab.active').text()).toContain('Usage')
  })

  it('jumps the chat to the turn behind a workflow face', async () => {
    const snapshot = data()
    snapshot.tasks = [{
      id: 'task-1', chat_id: 'chat-1', number: 1, title: 'Tell a joke', status: 'done',
      assignee_role_id: 'worker', created_by_role_id: 'captain', created_at: '2026-11-15T10:00:30Z',
    }]
    snapshot.messages = [
      {
        id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
        author_name: 'Writer', content: 'A short joke', status: 'done', mentions: [],
        created_at: '2026-11-15T10:01:00Z',
      },
    ]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()

    const article = wrapper.get('#room-message-reply-1')
    article.element.scrollIntoView = vi.fn()
    const face = wrapper.findAll('.room-flow-node').find(node => node.text().includes('Writer'))
    await face.trigger('click')

    expect(article.element.scrollIntoView).toHaveBeenCalled()
    expect(article.classes()).toContain('room-message-focus')
  })

  it('lets the workbench grow wider and wraps a long trace onto another row', async () => {
    localStorage.removeItem('tyche.roomLedgerWidth')
    const roles = [
      { id: 'captain', display_name: 'Captain' },
      { id: 'a', display_name: 'A' },
      { id: 'b', display_name: 'B' },
      { id: 'c', display_name: 'C' },
      { id: 'd', display_name: 'D' },
    ]
    const nodes = [
      { id: 'origin:captain', roleId: 'captain', messageId: 'm0', title: '', live: false },
      ...['a', 'b', 'c', 'd'].map(id => ({ id, roleId: id, messageId: id, title: id, live: false })),
    ]
    const edges = ['a', 'b', 'c', 'd'].map(id => ({ id: `edge-${id}`, from: 'origin:captain', to: id, label: id }))
    const flow = mount(RoomWorkflow, { props: { workflow: { nodes, edges, layers: [] }, roles } })
    cleanup.push(() => flow.unmount())
    const rows = flow.findAll('.room-flow-kids')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('.room-flow-node')).toHaveLength(3)
    expect(rows[1].attributes('data-follow')).toBe('true')
    expect(rows[1].findAll('.room-flow-node')).toHaveLength(1)

    const snapshot = data()
    snapshot.tasks = [{
      id: 'task-1', chat_id: 'chat-1', number: 1, title: 'Write docs', status: 'done',
      assignee_role_id: 'worker', created_at: '2026-11-15T10:01:00Z',
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    const handle = wrapper.get('.room-ledger-resize')
    expect(handle.attributes('aria-label')).toBe('Resize workbench')
    const point = (type, clientX, target = window) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }))
    }
    point('pointerdown', 500, handle.element)
    point('pointermove', 400)
    point('pointerup', 400)
    await flushPromises()
    expect(wrapper.get('.room-ledger').attributes('style')).toContain('440px')
    localStorage.removeItem('tyche.roomLedgerWidth')
  })

  it('defaults the workbench to trace when only assignments exist', async () => {
    const snapshot = data()
    snapshot.assignments = [{
      id: 'assignment-1',
      chat_id: 'chat-1',
      target_role_ids: ['worker'],
      status: 'settled',
      created_at: '2026-11-15T10:00:30Z',
    }]
    snapshot.reviews = [{
      id: 'review-1',
      chat_id: 'chat-1',
      kind: 'assignment_settled',
      status: 'completed',
      created_at: '2026-11-15T10:01:00Z',
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()

    const ledger = wrapper.get('.room-ledger')
    expect(ledger.get('.room-work-tab.active').text()).toContain('Trace')
    expect(ledger.text()).toContain('Writer')
    expect(ledger.text()).toContain('Captain')
    expect(ledger.find('[data-work-tab="tasks"]').exists()).toBe(false)
  })

  it('shows per-role usage in the workbench usage tab', async () => {
    const snapshot = data()
    snapshot.tasks = [{
      id: 'task-1',
      chat_id: 'chat-1',
      number: 1,
      title: 'Usage task',
      status: 'in_progress',
      assignee_role_id: 'worker',
      created_at: '2026-11-15T10:00:00Z',
    }]
    snapshot.messages = [{
      id: 'reply-1',
      chat_id: 'chat-1',
      sequence: 2,
      author_type: 'agent',
      author_id: 'worker',
      author_name: 'Writer',
      content: 'Done',
      status: 'done',
      created_at: '2026-11-15T10:01:00Z',
      data: {
        usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 8100, context: { percent: 42 } },
      },
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()

    await wrapper.get('[data-work-tab="usage"]').trigger('click')
    const ledger = wrapper.get('.room-ledger')
    expect(ledger.text()).toContain('Total')
    expect(ledger.text()).toContain('Writer')
    expect(ledger.text()).toContain('in 1.2k · out 340 · cache 8.1k')
    expect(ledger.text()).toContain('42%')
  })

  it('creates a room with one captain and no extra members', async () => {
    const bridge = api()
    bridge.listRooms.mockResolvedValueOnce([])
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.get('.room-landing').text()).toContain('New chat')
    expect(wrapper.find('.room-create').exists()).toBe(false)

    await wrapper.get('[data-testid="room-create-open"]').trigger('click')
    await flushPromises()

    expect(bridge.bootstrap).toHaveBeenCalledWith({
      name: 'New chat',
      title: 'New chat',
      providers: ['codex'],
      roles: [
        { displayName: 'Codex', provider: 'codex', prompt: '', isCaptain: true },
      ],
    })
  })

  it('starts a chat with every preferred member and the chosen Captain', async () => {
    window.tycheDesktop = {
      workPreferences: {
        get: async () => ({
          chatStartMode: 'multi',
          defaultCaptainKind: 'claude',
          defaultMemberKinds: ['codex', 'claude'],
        }),
      },
    }
    const bridge = api()
    bridge.listRooms.mockResolvedValueOnce([])
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('[data-testid="room-create-open"]').trigger('click')
    await flushPromises()
    expect(bridge.bootstrap).toHaveBeenCalledWith({
      name: 'New chat',
      title: 'New chat',
      providers: ['codex', 'claude'],
      roles: [
        { displayName: 'Codex', provider: 'codex', prompt: '', isCaptain: false },
        { displayName: 'Claude Code', provider: 'claude', prompt: '', isCaptain: true },
      ],
    })
  })

  it('sends a message with a client id and shows older pages', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'latest', chat_id: 'chat-1', sequence: 101, author_type: 'user', author_id: 'user',
      author_name: 'user', content: 'Latest', status: 'done', created_at: '2026-11-15T00:01:00Z',
    }]
    snapshot.messages_have_older = ['chat-1']
    const bridge = api(snapshot)
    bridge.chatMessages.mockResolvedValue({
      messages: [{
        id: 'earlier', chat_id: 'chat-1', sequence: 1, author_type: 'user', author_id: 'user',
        author_name: 'user', content: 'Earlier', status: 'done', created_at: '2026-11-15T00:00:00Z',
      }],
      hasMore: false,
    })
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.get('.room-load-older').trigger('click')
    await flushPromises()
    expect(bridge.chatMessages).toHaveBeenCalledWith({
      roomId: 'room-1', chatId: 'chat-1', beforeSeq: 101, limit: 100, includeCaptain: true,
    })
    expect(wrapper.text()).toContain('Earlier')

    await wrapper.get('.room-composer textarea').setValue('Another message')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(bridge.submitMessage).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      chatId: 'chat-1',
      content: 'Another message',
      clientId: expect.any(String),
    }))
  })

  it('opens directory settings from the header instead of the files drawer', async () => {
    const wrapper = mountRoom(api())
    await flushPromises()
    expect(wrapper.find('.room-workspace-dialog').exists()).toBe(false)
    await wrapper.get('.room-workspace-switch').trigger('click')
    const dialog = wrapper.get('.room-workspace-dialog')
    expect(dialog.text()).toContain('Switch directory')
    expect(dialog.text()).toContain('Set working directory')
    expect(dialog.text()).toContain('demo')
  })

  it('folds a mention handoff into the same author bubble', async () => {
    const snapshot = data()
    snapshot.messages = [
      {
        id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'captain',
        author_name: 'Captain', content: 'A joke', kind: 'message', reply_to: 'user-1',
        status: 'done', created_at: '2026-11-15T10:00:00Z', mentions: [],
      },
      {
        id: 'mention-1', chat_id: 'chat-1', sequence: 3, author_type: 'agent', author_id: 'captain',
        author_name: 'Captain', content: 'Please score it', kind: 'mention',
        status: 'done', created_at: '2026-11-15T10:00:01Z', mentions: ['worker'],
      },
      {
        id: 'reply-2', chat_id: 'chat-1', sequence: 5, author_type: 'agent', author_id: 'worker',
        author_name: 'Writer', content: 'Seven', kind: 'message', reply_to: 'mention-1',
        status: 'done', created_at: '2026-11-15T10:00:02Z', mentions: [],
      },
    ]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    const rows = wrapper.findAll('.room-message')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('A joke')
    expect(rows[0].text()).toContain('Please score it')
    expect(rows[0].text()).toContain('Handoff to Writer')
    expect(rows[1].text()).toContain('Seven')
    expect(rows[1].text()).not.toContain('Please score it')
  })

  it('keeps same-millisecond messages in ledger sequence order', async () => {
    const snapshot = data()
    snapshot.messages = [
      {
        id: 'later', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
        author_name: 'Writer', content: 'Second', status: 'done', created_at: '2026-11-15T10:00:00.000Z',
      },
      {
        id: 'earlier', chat_id: 'chat-1', sequence: 1, author_type: 'user', author_id: 'user',
        author_name: 'user', content: 'First', status: 'done', created_at: '2026-11-15T10:00:00.000Z',
      },
    ]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    const rows = wrapper.findAll('.room-message')
    expect(rows[0].text()).toContain('First')
    expect(rows[1].text()).toContain('Second')
  })

  it('streams live text, tools, and context usage for a working reply', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
      author_name: 'Writer', content: '', status: 'working', created_at: '2026-11-15T10:01:00Z',
    }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()

    bridge.emitRuntimeEvent({
      runId: 'reply-1', chatId: 'chat-1', roleId: 'worker', mode: 'chat',
      event: { kind: 'text_delta', text: 'Writing the docs', seq: 1 },
    })
    await flushPromises()
    expect(wrapper.get('.room-live-output').text()).toBe('Writing the docs')

    bridge.emitRuntimeEvent({
      runId: 'reply-1', chatId: 'chat-1', roleId: 'worker', mode: 'chat',
      event: { kind: 'tool_call_started', callId: 'call-1', toolName: 'shell', input: 'ls', seq: 2 },
    })
    await flushPromises()
    expect(wrapper.get('.room-tool-card').text()).toContain('Run')

    bridge.emitRuntimeEvent({
      runId: 'reply-1', chatId: 'chat-1', roleId: 'worker', mode: 'chat',
      event: {
        kind: 'usage',
        usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 8100, context: { percent: 42 } },
        seq: 3,
      },
    })
    await flushPromises()
    expect(wrapper.get('.room-turn-usage').text()).toBe('in 1.2k · out 340 · cache 8.1k')
    expect(wrapper.find('.room-usage-chip').exists()).toBe(false)
    await wrapper.get('.room-usage-toggle').trigger('click')
    const ledger = wrapper.get('.room-ledger')
    expect(ledger.get('.room-work-tab.active').text()).toContain('Usage')
    expect(ledger.text()).toContain('Writer')
    expect(ledger.text()).toContain('in 1.2k · out 340 · cache 8.1k')
    expect(ledger.text()).toContain('42%')
  })

  it('shows stored thinking and the settled tool trace without loading runtime events', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
      author_name: 'Writer', content: '**Done**', status: 'done', created_at: '2026-11-15T10:01:00Z',
      data: {
        thinking: 'Checking the table',
        trace: [{ callId: 'call-1', name: 'shell', input: 'ls', output: 'README.md', status: 'completed' }],
      },
    }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const body = wrapper.get('.room-message-body')
    const trace = body.get('.room-run-trace')
    expect(trace.text()).toContain('Checking the table')
    expect(body.html().indexOf('markdown-body')).toBeLessThan(body.html().indexOf('room-run-trace'))
    expect(trace.text()).toContain('1 steps')
    trace.element.open = true
    await trace.trigger('toggle')
    await flushPromises()
    expect(bridge.runtimeEvents).not.toHaveBeenCalledWith(expect.objectContaining({ runId: 'reply-1' }))
    expect(trace.text()).toContain('Run')
    expect(trace.text()).toContain('README.md')
  })

  it('shows token usage stored on a finished reply', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
      author_name: 'Writer', content: 'Done', status: 'done', created_at: '2026-11-15T10:01:00Z',
      data: { usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 8100 } },
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    expect(wrapper.get('.room-turn-usage').text()).toBe('in 1.2k · out 340 · cache 8.1k')
  })

  it('loads a persisted trace for a completed reply', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
      author_name: 'Writer', content: 'Done', status: 'done', created_at: '2026-11-15T10:01:00Z',
    }]
    const bridge = api(snapshot)
    bridge.runtimeEvents.mockResolvedValue([{
      id: 'event-1', runId: 'reply-1', chatId: 'chat-1', kind: 'tool_call_started',
      payload: { kind: 'tool_call_started', callId: 'call-1', toolName: 'shell', input: 'ls' },
      createdAt: '2026-11-15T10:01:01Z',
    }])
    const wrapper = mountRoom(bridge)
    await flushPromises()

    const trace = wrapper.get('.room-run-trace')
    trace.element.open = true
    await trace.trigger('toggle')
    await flushPromises()
    expect(bridge.runtimeEvents).toHaveBeenCalledWith({
      roomId: 'room-1', chatId: 'chat-1', runId: 'reply-1', limit: 1000,
    })
    expect(trace.text()).toContain('Run')
    expect(trace.text()).toContain('1 steps')
  })

  it('renders a reply as markdown and keeps live reasoning inside the run block', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'reply-1', chat_id: 'chat-1', sequence: 2, author_type: 'agent', author_id: 'worker',
      author_name: 'Writer', content: '**Done**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
      status: 'done', created_at: '2026-11-15T10:01:00Z',
    }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    bridge.emitRuntimeEvent({
      runId: 'reply-1', chatId: 'chat-1', roleId: 'worker', mode: 'chat',
      event: { kind: 'reasoning', text: 'Checking the table', seq: 1 },
    })
    await flushPromises()
    const body = wrapper.get('.room-message-body')
    expect(body.get('.markdown-body strong').text()).toBe('Done')
    expect(body.get('table').text()).toContain('A')
    expect(body.get('.room-run-trace').text()).toContain('Checking the table')
  })

  it('accepts settled tasks and answers open attentions', async () => {
    const snapshot = data()
    snapshot.tasks = [{
      id: 'task-1', chat_id: 'chat-1', number: 1, title: 'Write docs', status: 'in_review',
      description: '', acceptance: '', assignee_role_id: 'worker', created_at: '2026-11-15T10:01:00Z',
    }]
    snapshot.reports = [{
      id: 'report-1', task_id: 'task-1', run_id: 'run-1', kind: 'ready',
      summary: 'Ready', evidence: [], artifact_ids: [], created_at: '2026-11-15T10:02:00Z',
    }]
    snapshot.attentions = [{
      id: 'attention-1', chat_id: 'chat-1', type: 'effect_unknown',
      question: 'Did the write land?', options: [], status: 'open',
      created_at: '2026-11-15T10:03:00Z',
    }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.get('.room-report-card .primary-button').trigger('click')
    await flushPromises()
    expect(bridge.acceptTask).toHaveBeenCalledWith({
      roomId: 'room-1', taskId: 'task-1', commandId: expect.any(String),
    })

    await wrapper.get('.room-attention-card input').setValue('Yes, it landed.')
    await wrapper.get('.room-attention-card form').trigger('submit')
    await flushPromises()
    expect(bridge.answerAttention).toHaveBeenCalledWith({
      roomId: 'room-1',
      chatId: 'chat-1',
      attentionId: 'attention-1',
      resolution: 'Yes, it landed.',
      commandId: expect.any(String),
    })
  })

  it('offers every launchable provider when editing a role', async () => {
    const snapshot = data()
    snapshot.room.providers = ['claude']
    snapshot.room.launch_providers = ['claude', 'codex']
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    await wrapper.get('.room-agent-add').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-role-engine-field select').findAll('option').map(node => node.element.value))
      .toEqual(['claude', 'codex'])
    expect(wrapper.findAll('.room-role-provider-choice').map(node => node.attributes('data-portrait')))
      .toEqual(['claude', 'codex', 'pi', 'gemini'])
  })

  it('opens the role dialog from a roster card', async () => {
    const snapshot = data()
    snapshot.roles[1].responsibilities = 'Write the draft'
    snapshot.messages = [{
      id: 'roster-1',
      chat_id: 'chat-1',
      sequence: 2,
      author_type: 'agent',
      author_id: 'captain',
      author_name: 'Captain',
      content: 'Added Writer.',
      status: 'done',
      data: { roleIds: ['worker'] },
      created_at: '2026-11-15T10:05:00Z',
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()

    const card = wrapper.get('.room-roster-card')
    expect(card.text()).toContain('Writer')
    expect(card.text()).toContain('Write the draft')
    await card.trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-role-modal').text()).toContain('Writer')
    expect(wrapper.get('.room-role-prompt').element.value).toBe('write')
  })

  it('updates role prompts, creates roles, and deletes unused roles', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.findAll('.room-agent-chip')[1].trigger('click')
    await flushPromises()
    await wrapper.get('.room-role-prompt').setValue('Review every document.')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()
    expect(bridge.updateRole).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      roleId: 'worker',
      prompt: 'Review every document.',
    }))

    await wrapper.get('.room-agent-add').trigger('click')
    await flushPromises()
    await wrapper.get('.room-role-identity input').setValue('Reviewer')
    await wrapper.get('.room-role-prompt').setValue('Review the work.')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()
    expect(bridge.createRole).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      chatId: 'chat-1',
      displayName: 'Reviewer',
      provider: 'codex',
      prompt: 'Review the work.',
    }))

    await wrapper.findAll('.room-agent-chip')[1].trigger('click')
    await flushPromises()
    await wrapper.get('.room-role-delete-button').trigger('click')
    await wrapper.get('.room-role-delete-confirm .danger-button').trigger('click')
    await flushPromises()
    expect(bridge.deleteRole).toHaveBeenCalledWith({ roomId: 'room-1', roleId: 'worker' })
  })

  it('promotes a role through the atomic Captain swap', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.findAll('.room-agent-chip')[1].trigger('click')
    await flushPromises()
    await wrapper.get('.room-role-controller-toggle').trigger('click')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()

    expect(bridge.updateRole).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'worker',
      isCaptain: false,
    }))
    expect(bridge.setCaptain).toHaveBeenCalledWith({ roomId: 'room-1', roleId: 'worker' })
  })

  it('renames the open chat from the title without opening settings', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()

    expect(wrapper.find('.room-settings-modal').exists()).toBe(false)
    await wrapper.get('.room-chat-title').trigger('click')
    await flushPromises()
    const editor = wrapper.get('.room-chat-title.editing [role="textbox"]')
    editor.element.textContent = 'Plan the snake page'
    await editor.trigger('blur')
    await flushPromises()
    expect(bridge.renameChat).toHaveBeenCalledWith({
      roomId: 'room-1',
      chatId: 'chat-1',
      title: 'Plan the snake page',
    })
  })

  it('refreshes the active room after a ledger change notification', async () => {
    vi.useFakeTimers()
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(bridge.snapshot).toHaveBeenCalledTimes(1)

    bridge.emitChanged()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(bridge.snapshot).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('marks a member whose provider has no room launcher', async () => {
    const snapshot = data()
    snapshot.room.launch_providers = ['claude', 'codex', 'pi']
    snapshot.room.providers = ['claude', 'codex', 'hermes']
    snapshot.roles.push({
      id: 'hermes',
      chat_id: 'chat-1',
      display_name: 'Hermes',
      provider: 'hermes',
      is_captain: false,
      native_permission: 'default',
      prompt: 'watch',
      prompt_revision: 1,
    })
    const wrapper = mountRoom(api(snapshot), {
      agents: [
        { kind: 'codex', label: 'Codex' },
        { kind: 'claude', label: 'Claude Code' },
        { kind: 'hermes', label: 'Hermes' },
      ],
    })
    await flushPromises()
    const chip = wrapper.findAll('.room-agent-chip').find(node => node.text().includes('Hermes'))
    const writer = wrapper.findAll('.room-agent-chip').find(node => node.text().includes('Writer'))
    expect(chip.attributes('title')).toContain('Cannot speak in this chat')
    expect(chip.text()).toContain('🔇')
    expect(chip.attributes('data-quiet')).toBe('true')
    expect(writer.attributes('title') || '').not.toContain('Cannot speak')
  })

  it('marks a role whose Agent is not available on this machine', async () => {
    const snapshot = data()
    snapshot.room.launch_providers = ['claude', 'codex', 'kimi']
    snapshot.roles.push({
      id: 'kimi',
      chat_id: 'chat-1',
      display_name: '笑匠丙',
      provider: 'kimi',
      is_captain: false,
      native_permission: 'default',
      prompt: 'close',
      prompt_revision: 1,
    })
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()

    const chip = wrapper.findAll('.room-agent-chip').find(node => node.text().includes('笑匠丙'))
    expect(chip.attributes('data-quiet')).toBe('true')
    expect(chip.text()).toContain('⚠')
    expect(chip.attributes('title')).toContain('not available on this machine')
    expect(wrapper.get('.room-cast-warning').text()).toContain('Agents unavailable: 1')

    await chip.trigger('click')
    await flushPromises()
    const option = wrapper.findAll('.room-role-engine-field option')
      .find(node => node.attributes('value') === 'kimi')
    expect(option.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.room-role-v2-footer .primary-button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('not available on this machine')
  })

  it('opens the room and chat requested by the sidebar', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge, {
      openRequest: { roomId: 'room-1', chatId: 'chat-2', nonce: 1 },
    })
    await flushPromises()
    expect(bridge.snapshot).toHaveBeenCalledWith({ roomId: 'room-1', includeCaptain: true })
    expect(wrapper.emitted('active-change')?.at(-1)?.[0]).toEqual({
      roomId: 'room-1',
      chatId: 'chat-2',
    })
  })
})
