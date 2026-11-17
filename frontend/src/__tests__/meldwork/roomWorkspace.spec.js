import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    createChat: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-2' })),
    deleteChat: vi.fn(async () => ({ deleted: true, chatId: 'chat-2' })),
    deleteRoom: vi.fn(async () => ({ deleted: true, roomId: 'room-1' })),
    createRole: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1', roleId: 'new-role' })),
    updateRole: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1', roleId: 'worker' })),
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
    emitChanged: () => changed?.(),
  }
}

const cleanup = []
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose())
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
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()

    expect(wrapper.get('.room-project-name').text()).toContain('Demo room')
    expect(wrapper.get('.room-subtitle').text()).toContain('demo')
    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(2)
    expect(wrapper.get('.room-agent-badge').text()).toBe('Captain')
    expect(wrapper.get('.room-message').text()).toContain('Please write the docs')
    expect(wrapper.get('.room-mention-chip').text()).toBe('@Writer')
    expect(wrapper.get('.room-report-card').text()).toContain('Docs are ready')
    expect(wrapper.get('.room-report-card').text()).toContain('#1 Write docs')

    expect(wrapper.get('.room-ledger').text()).toContain('Write docs')
    expect(wrapper.get('.room-ledger').text()).toContain('Captain reviews')
    expect(wrapper.get('.room-ledger').text()).toContain('Assignment settled')
    expect(wrapper.get('.room-ledger').text()).toContain('Captain assignments')
    expect(wrapper.get('.room-ledger').text()).toContain('Writer')
  })

  it('creates a room with the selected providers and roles', async () => {
    const bridge = api()
    bridge.listRooms.mockResolvedValueOnce([])
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.get('.room-landing').text()).toContain('New project')

    await wrapper.get('[data-testid="room-create-open"]').trigger('click')
    await wrapper.get('.room-create input').setValue('Alpha')
    await wrapper.get('.room-directory button').trigger('click')
    await flushPromises()
    const providers = wrapper.findAll('.room-provider-option input')
    await providers[1].setValue(true)
    await wrapper.get('.room-create form, form.room-create').trigger('submit')
    await flushPromises()

    expect(bridge.bootstrap).toHaveBeenCalledWith({
      name: 'Alpha',
      workspace: '/tmp/demo',
      title: 'Alpha',
      providers: ['codex', 'claude'],
      roles: [
        { displayName: 'Codex', provider: 'codex', prompt: '', isCaptain: true },
        { displayName: 'Claude Code', provider: 'claude', prompt: '', isCaptain: false },
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
    await wrapper.get('.room-role-v2-name input').setValue('Reviewer')
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

  it('toggles room write authorization and requests the files drawer', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.get('.room-project-name').trigger('click')
    await flushPromises()
    await wrapper.get('.room-overview .secondary-button').trigger('click')
    await flushPromises()
    expect(bridge.setWriteAuthorized).toHaveBeenCalledWith({ roomId: 'room-1', authorized: true })

    await wrapper.get('.room-files-toggle').trigger('click')
    expect(wrapper.emitted('toggle-files')).toHaveLength(1)
  })

  it('creates a chat from chat settings', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()

    await wrapper.get('.room-chat-title').trigger('click')
    await flushPromises()
    await wrapper.get('.room-new-chat input').setValue('Research')
    await wrapper.get('.room-new-chat').trigger('submit')
    await flushPromises()
    expect(bridge.createChat).toHaveBeenCalledWith({ roomId: 'room-1', title: 'Research' })
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
