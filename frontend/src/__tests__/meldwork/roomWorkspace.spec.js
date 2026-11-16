import { effectScope } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RoomWorkspace from '../../components/RoomWorkspace.vue'
import { useRoomWorkspace } from '../../composables/useRoomWorkspace.js'
import { setLocale } from '../../i18n.js'

function data(id = 'room-1') {
  return { room: { id, primary_chat_id: 'chat-1', write_authorized_root: null },
    chats: [{ id: 'chat-1', title: 'First chat', status: 'active' }, { id: 'chat-2', title: 'Second chat', status: 'active' }],
    messages: [], roles: [], tasks: [], assignments: [], reports: [], artifacts: [], attentions: [] }
}
function api(snapshot = data()) {
  let assignmentEvent = null
  return { listRooms: vi.fn(async () => [{ id: 'room-1', name: 'Demo' }]), permissionModes: vi.fn(async () => ({
    claude: [
      { id: 'plan', label: 'Plan', description: 'Read only', write: false, risk: 'low' },
      { id: 'acceptEdits', label: 'Accept Edits', description: 'Write', write: true, risk: 'medium' },
      { id: 'bypassPermissions', label: 'Bypass Permissions', description: 'High risk', write: true, risk: 'high' },
    ],
    codex: [
      { id: 'read-only', label: 'Read Only', description: 'Read only', write: false, risk: 'low' },
      { id: 'workspace-write', label: 'Workspace Write', description: 'Write', write: true, risk: 'medium' },
    ],
    gemini: [
      { id: 'default', label: 'Default', description: 'Read only', write: false, risk: 'low' },
      { id: 'auto_edit', label: 'Auto Edit', description: 'Write', write: true, risk: 'medium' },
    ],
    pi: [
      { id: 'no-approve', label: 'No Approve', description: 'Read only', write: false, risk: 'low' },
      { id: 'approve', label: 'Approve', description: 'Write', write: true, risk: 'medium' },
    ],
    default: [{ id: 'default', label: 'Native Configuration', description: 'Native', write: true, risk: 'medium' }],
  })), snapshot: vi.fn(async () => snapshot),
    chatMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    listStaleAssignments: vi.fn(async () => []),
    bootstrap: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1' })),
    createChat: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-2' })),
    artifactDiff: vi.fn(async () => ({ text: '+saved change', truncated: false })),
    assignmentTrace: vi.fn(async () => ({ steps: [{ seq: 1, kind: 'tool', title: 'Read source', toolCallId: 'tool-1', input: { file_path: 'package.json' }, output: 'Opened package.json', status: 'completed' }], cursor: 'cursor-1', hasMore: false })),
    assignmentTraceBlob: vi.fn(async () => ({ text: 'trace output', totalBytes: 12, eof: true })),
    filesList: vi.fn(async () => ({ entries: [{ name: 'README.md', kind: 'file', size: 5, mtime: '2026-11-16T00:00:00Z' }], hasMore: false })),
    filesRead: vi.fn(async () => ({ kind: 'text', text: 'hello', totalBytes: 5, eof: true, encoding: 'utf-8' })),
    submitMessage: vi.fn(async () => ({ ok: true })), applyUserCommand: vi.fn(async () => ({ ok: true })),
    skills: vi.fn(async kind => ({ supported: true, skills: [{ targetKind: kind, namespace: 'local', slug: 'review', name: 'Review' }] })),
    updateSkillBindings: vi.fn(async input => ({ ...input, skillBindings: input.selections || null })),
    onAssignmentEvent: vi.fn(callback => { assignmentEvent = callback; return () => { assignmentEvent = null } }),
    emitAssignmentEvent: payload => assignmentEvent?.(payload) }
}
const cleanup = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })
function mountRoom(bridge) {
  setLocale('en')
  const wrapper = mount(RoomWorkspace, { props: { api: bridge, pickDirectory: vi.fn(async () => '/tmp/demo'), agents: [{ kind: 'codex', label: 'Codex' }] } })
  cleanup.push(() => wrapper.unmount())
  return wrapper
}

describe('v2 team workspace', () => {
  it('shows the directory, controller, available agents and empty configuration states', async () => {
    const snapshot = data()
    snapshot.room.workspace = '/tmp/current-project'
    snapshot.room.providers_json = ['codex', 'claude']
    const bridge = api(snapshot)
    bridge.skills.mockResolvedValue({ supported: true, skills: [] })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.get('.room-overview').text()).toContain('/tmp/current-project')
    expect(wrapper.get('.room-overview').text()).toContain('Codex')
    expect(wrapper.get('.room-overview').text()).toContain('Automatic dispatch enabled')
    expect(wrapper.get('.room-skill-settings').text()).toContain('No skills found')
    expect(wrapper.get('.room-context').text()).toContain('No collaboration agreement yet')
    await wrapper.get('.room-context-editor textarea').setValue('Ask two reviewers before implementing.')
    await wrapper.get('.room-context-editor').trigger('submit')
    await flushPromises()
    expect(bridge.submitMessage).toHaveBeenCalledWith({ chatId: 'chat-1', content: 'Ask two reviewers before implementing.' })
  })

  it('preserves unsaved skills across polling and keeps the catalog deduplicated', async () => {
    vi.useFakeTimers()
    const snapshot = data()
    snapshot.room.providers_json = ['codex']
    const bridge = api(snapshot)
    bridge.snapshot.mockImplementation(async () => structuredClone(snapshot))
    const skill = { targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }
    bridge.skills.mockResolvedValue({ supported: true, skills: [skill, skill] })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.findAll('.room-skill-settings input')).toHaveLength(1)
    await wrapper.get('.room-skill-settings input').setValue(true)
    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.get('.room-skill-settings input').element.checked).toBe(true)
    expect(bridge.skills).toHaveBeenCalledTimes(1)
    bridge.updateSkillBindings.mockRejectedValueOnce(new Error('save failed'))
    await wrapper.get('.room-skill-settings > button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-skill-settings [role=alert]').text()).toContain('Your selection is preserved')
    await wrapper.get('.room-skill-settings > button').trigger('click')
    await flushPromises()
    expect(bridge.updateSkillBindings).toHaveBeenLastCalledWith({ chatId: 'chat-1', selections: [skill] })
  })

  it('shows skill discovery errors and offers a retry', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex']
    const bridge = api(snapshot)
    bridge.skills.mockRejectedValueOnce(new Error('unavailable'))
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.get('.room-skill-settings [role=alert]').text()).toContain('could not be read')
    await wrapper.get('.room-skill-settings [role=alert] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.room-skill-settings [role=alert]').exists()).toBe(false)
    expect(wrapper.findAll('.room-skill-settings input')).toHaveLength(1)
  })

  it('explains a missing skill manifest without discarding the selection', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex']
    const bridge = api(snapshot)
    bridge.updateSkillBindings.mockRejectedValue(new Error("Error invoking remote method: LOCAL_SKILL_MANIFEST_MISSING"))
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-skill-settings input').setValue(true)
    await wrapper.get('.room-skill-settings > button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-skill-settings [role=alert]').text()).toContain('missing meldwork.skill.json')
    expect(wrapper.get('.room-skill-settings input').element.checked).toBe(true)
  })
  it('saves cloneable chat and role skill payloads and restores inheritance', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex']
    snapshot.chats[0].skill_bindings_json = []
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', status: 'active', skill_bindings_json: [{ targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }] }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const chatSkill = wrapper.find('.room-skill-settings input[type=checkbox]')
    await chatSkill.setValue(true)
    await wrapper.get('.room-skill-settings button').trigger('click')
    expect(bridge.updateSkillBindings).toHaveBeenCalledWith({ chatId: 'chat-1', selections: [{ targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }] })
    expect(() => structuredClone(bridge.updateSkillBindings.mock.calls[0][0])).not.toThrow()
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()
    const roleSkill = wrapper.get('.room-role-v2-skills input[type=checkbox]')
    await roleSkill.setValue(false)
    await roleSkill.setValue(true)
    await wrapper.get('.room-role-v2-skills .secondary-button').trigger('click')
    await flushPromises()
    expect(bridge.updateSkillBindings).toHaveBeenLastCalledWith({ chatId: 'chat-1', roleId: 'worker', selections: [{ targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }] })
    expect(() => structuredClone(bridge.updateSkillBindings.mock.calls.at(-1)[0])).not.toThrow()
    const roleMode = wrapper.findAll('.room-role-v2-skills .room-mini-option').find(button => button.text() === 'Inherit chat defaults')
    await roleMode.trigger('click')
    await wrapper.get('.room-role-v2-skills .secondary-button').trigger('click')
    expect(bridge.updateSkillBindings).toHaveBeenLastCalledWith({ chatId: 'chat-1', roleId: 'worker', inheritChat: true })
    expect(() => structuredClone(bridge.updateSkillBindings.mock.calls.at(-1)[0])).not.toThrow()
  })

  it('renders controller notes as visible controller messages', async () => {
    const snapshot = data()
    snapshot.messages = [{
      id: 'controller-note', chat_id: 'chat-1', sequence: 1, author_type: 'controller', author_id: 'controller',
      content: 'Message received; no work needed this round.', created_at: '2026-11-16T12:00:00Z',
    }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    const note = wrapper.get('.room-message-controller')
    expect(note.text()).toContain('Controller')
    expect(note.text()).toContain('Message received; no work needed this round.')
  })

  it('loads an inline assignment trace from a report card', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', status: 'active' }]
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Write docs', status: 'done' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'completed', run_id: 'run-private' }]
    snapshot.reports = [{ id: 'report', task_id: 'task', assignment_id: 'attempt', summary: 'Document ready', evidence_json: [], artifact_ids_json: [], created_at: '2026-11-15T00:00:00Z' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const trace = wrapper.get('.room-message-body .room-assignment-trace')
    trace.element.open = true
    await trace.trigger('toggle')
    await flushPromises()
    expect(bridge.assignmentTrace).toHaveBeenCalledWith({ roomId: 'room-1', assignmentId: 'attempt', direction: 'backward', limit: 100 })
    expect(trace.text()).toContain('Read source')
  })

  it('requests the room files drawer from the header', async () => {
    const wrapper = mountRoom(api(data()))
    await flushPromises()
    await wrapper.get('.room-files-toggle').trigger('click')
    expect(wrapper.emitted('toggle-files')).toHaveLength(1)
  })

  it('renders and appends live output for a running assignment', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', status: 'active' }]
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Write the document', status: 'running' }]
    snapshot.assignments = [{ id: 'assignment', task_id: 'task', role_id: 'worker', status: 'running' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    bridge.emitAssignmentEvent({ roomId: 'room-1', chatId: 'chat-1', assignmentId: 'assignment',
      event: { type: 'answer_delta', delta: 'First part', status: 'running' } })
    await flushPromises()
    bridge.emitAssignmentEvent({ roomId: 'room-1', chatId: 'chat-1', assignmentId: 'assignment',
      event: { type: 'answer_delta', delta: ' and second part', status: 'running' } })
    await flushPromises()
    expect(wrapper.get('.room-live-output').text()).toContain('First part and second part')
  })

  it('loads an earlier message page and keeps it visible after refresh', async () => {
    const snapshot = data()
    snapshot.messages = [{ id: 'latest', chat_id: 'chat-1', sequence: 101, author_type: 'user', content: 'Latest', created_at: '2026-11-15T00:01:00Z' }]
    snapshot.messages_have_older = ['chat-1']
    const bridge = api(snapshot)
    bridge.chatMessages.mockResolvedValue({ messages: [{ id: 'earlier', chat_id: 'chat-1', sequence: 1, author_type: 'user', content: 'Earlier', created_at: '2026-11-15T00:00:00Z' }], hasMore: false })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-load-older').trigger('click')
    await flushPromises()
    expect(bridge.chatMessages).toHaveBeenCalledWith({ roomId: 'room-1', chatId: 'chat-1', beforeSequence: 101, limit: 100 })
    await wrapper.get('.room-composer textarea').setValue('Another message')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Earlier')
    expect(wrapper.text()).toContain('Latest')
    expect(wrapper.find('.room-load-older').exists()).toBe(false)
  })

  it('refreshes the active room after a ledger change notification', async () => {
    const snapshot = data()
    const bridge = api(snapshot)
    let changed
    bridge.onChanged = vi.fn(callback => { changed = callback; return () => { changed = null } })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const updated = data()
    updated.messages = [{ id: 'new', chat_id: 'chat-1', sequence: 1, author_type: 'agent', content: 'New report', created_at: '2026-11-15T00:00:00Z' }]
    bridge.snapshot.mockResolvedValueOnce(updated)
    changed({})
    await new Promise(resolve => setTimeout(resolve, 100))
    await flushPromises()
    expect(bridge.snapshot).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('New report')
  })

  it('keeps the reader at the same message position when prepending history', async () => {
    const snapshot = data()
    snapshot.messages = [{ id: 'latest', chat_id: 'chat-1', sequence: 101, author_type: 'user', content: 'Latest', created_at: '2026-11-15T00:01:00Z' }]
    snapshot.messages_have_older = ['chat-1']
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const timeline = wrapper.get('.room-timeline').element
    let height = 500
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => height })
    timeline.scrollTop = 120
    bridge.chatMessages.mockImplementationOnce(async () => {
      height = 800
      return { messages: [{ id: 'earlier', chat_id: 'chat-1', sequence: 1, author_type: 'user', content: 'Earlier', created_at: '2026-11-15T00:00:00Z' }], hasMore: false }
    })

    await wrapper.get('.room-load-older').trigger('click')
    await flushPromises()

    expect(timeline.scrollTop).toBe(420)
  })

  it('opens saved diffs by ledger ID, escapes output and closes with Escape', async () => {
    const snapshot = data()
    snapshot.artifacts = [{ id: 'artifact', path: 'docs/spec.md', version: 'commit', status: 'published' }]
    const bridge = api(snapshot)
    bridge.artifactDiff.mockResolvedValue({ text: '+<script>unsafe()</script>', truncated: true })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-show-diff').trigger('click')
    await flushPromises()
    expect(bridge.artifactDiff).toHaveBeenCalledWith({ roomId: 'room-1', artifactId: 'artifact' })
    expect(wrapper.get('.room-artifact-diff pre').text()).toContain('<script>unsafe()</script>')
    expect(wrapper.find('.room-artifact-diff script').exists()).toBe(false)
    expect(wrapper.get('.room-artifact-diff [role=status]').text()).toContain('first part')
    await wrapper.get('.room-artifact-diff').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.room-artifact-diff').exists()).toBe(false)
  })

  it('ignores a late diff after changing artifacts and clears it on a chat switch', async () => {
    const snapshot = data()
    snapshot.artifacts = ['one', 'two'].map(id => ({ id, path: `${id}.md`, version: 'commit', status: 'published' }))
    const bridge = api(snapshot)
    let finish
    bridge.artifactDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    bridge.artifactDiff.mockResolvedValue({ text: '+second artifact', truncated: false })
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.findAll('.room-show-diff')[0].trigger('click')
    await flushPromises()
    await wrapper.findAll('.room-show-diff')[1].trigger('click')
    await flushPromises()
    finish({ text: '+old artifact', truncated: false })
    await flushPromises()
    expect(wrapper.get('.room-artifact-diff pre').text()).toBe('+second artifact')
    await wrapper.get('.room-chat-settings select').setValue('chat-2')
    expect(wrapper.find('.room-artifact-diff').exists()).toBe(false)
  })

  it('shows diff read failures and lets the user retry', async () => {
    const snapshot = data()
    snapshot.artifacts = [{ id: 'artifact', path: 'spec.md', version: 'commit', status: 'published' }]
    const bridge = api(snapshot)
    bridge.artifactDiff.mockRejectedValueOnce(new Error('unavailable'))
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-show-diff').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-artifact-diff [role=alert]').text()).toContain('unavailable')
    await wrapper.get('.room-artifact-diff [role=alert] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-artifact-diff pre').text()).toBe('+saved change')
  })

  it('serializes polling and discards stale Room responses and disposes its timer', async () => {
    vi.useFakeTimers()
    let finish
    const bridge = api()
    bridge.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    bridge.snapshot.mockResolvedValue(data('room-2'))
    const scope = effectScope()
    cleanup.push(() => scope.stop())
    const model = scope.run(() => useRoomWorkspace({ api: bridge, pollMs: 100 }))
    const first = model.openRoom('room-1')
    void model.refresh()
    expect(bridge.snapshot).toHaveBeenCalledTimes(1)
    await model.openRoom('room-2')
    finish(data('room-1'))
    await first
    expect(model.snapshot.value.room.id).toBe('room-2')
    expect(model.roomId.value).toBe('room-2')
    bridge.snapshot.mockResolvedValue(data('room-2'))
    await vi.advanceTimersByTimeAsync(100)
    expect(model.snapshot.value.room.id).toBe('room-2')
    scope.stop()
    const count = bridge.snapshot.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.snapshot).toHaveBeenCalledTimes(count)
  })

  it('refreshes after an older poll before selecting a newly created chat', async () => {
    const bridge = api()
    const scope = effectScope()
    cleanup.push(() => scope.stop())
    const model = scope.run(() => useRoomWorkspace({ api: bridge }))
    await model.openRoom('room-1')
    let finishPoll
    bridge.snapshot.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve }))
    const poll = model.refresh()
    bridge.createChat.mockResolvedValue({ chatId: 'chat-3' })
    const fresh = data()
    fresh.chats.push({ id: 'chat-3', title: 'New chat', status: 'active' })
    bridge.snapshot.mockResolvedValue(fresh)
    const creating = model.createChat('New chat')
    await flushPromises()
    expect(model.busy.value).toBe(true)
    finishPoll(data())
    await poll
    await creating
    expect(bridge.snapshot).toHaveBeenCalledTimes(3)
    expect(model.chatId.value).toBe('chat-3')
    expect(model.chat.value.title).toBe('New chat')
  })

  it('keeps separate chat drafts and preserves failed submissions', async () => {
    const bridge = api()
    bridge.submitMessage.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-composer textarea').setValue('first draft')
    await wrapper.get('.room-chat-settings select').setValue('chat-2')
    await wrapper.get('.room-composer textarea').setValue('second draft')
    await wrapper.get('.room-chat-settings select').setValue('chat-1')
    expect(wrapper.get('.room-composer textarea').element.value).toBe('first draft')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(wrapper.get('.room-composer textarea').element.value).toBe('first draft')
    expect(wrapper.get('[role=alert]').text()).toContain('could not be completed')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(bridge.submitMessage).toHaveBeenLastCalledWith({ chatId: 'chat-1', content: 'first draft' })
    expect(wrapper.get('.room-composer textarea').element.value).toBe('')
  })

  it('renders Reports as escaped text, isolates chat roles and exposes validated task controls', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Builder', provider: 'codex', status: 'active', responsibilities: 'Implement backend changes.', creation_reason: 'The request includes backend implementation.', current_prompt: 'Build reliable APIs.' }, { id: 'foreign', chat_id: 'chat-2', display_name: 'Other team', status: 'active' }]
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Build API', status: 'active' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'failed', outcome: 'failed' }]
    snapshot.reports = [{ id: 'report', task_id: 'task', assignment_id: 'attempt', summary: '<script>unsafe()</script>', evidence_json: ['tested'], created_at: '2026-11-15T00:00:00Z' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.find('.room-report script').exists()).toBe(false)
    expect(wrapper.get('.room-report').text()).toContain('<script>unsafe()</script>')
    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(1)
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-role-v2-intro').element.value).toBe('Implement backend changes.')
    expect(wrapper.get('.room-role-v2-form .room-role-v2-section h3').text()).toContain('Role prompt')
    const rolePrompt = wrapper.get('.room-role-prompt')
    expect(rolePrompt.element.value).toBe('Build reliable APIs.')
    await rolePrompt.setValue('Prefer small, tested changes.')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_role', roleId: 'worker', prompt: 'Prefer small, tested changes.', chatId: 'chat-1', commandId: expect.any(String),
    }))
    await wrapper.get('.room-role-modal').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    const stop = wrapper.findAll('button').find(button => button.text() === 'Stop task')
    await stop.trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop_task', taskId: 'task', chatId: 'chat-1', commandId: expect.any(String) }))
    const retry = wrapper.findAll('button').find(button => button.text() === 'Retry')
    await retry.trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'retry_task', assignmentId: 'attempt', commandId: expect.any(String) }))
  })

  it('shows the current collaboration agreement for the selected chat', async () => {
    const snapshot = data()
    snapshot.chats[0].context_revision = 2
    snapshot.chats[0].current_context = { revision: 2, instructions: 'Use English reports and ask before implementation.' }
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    expect(wrapper.get('.room-context').text()).toContain('Current collaboration agreement')
    expect(wrapper.get('.room-context').text()).toContain('Use English reports and ask before implementation.')
    await wrapper.get('.room-chat-settings select').setValue('chat-2')
    expect(wrapper.get('.room-context').text()).toContain('No collaboration agreement yet')
  })

  it('offers the existing resume command when controller routing is blocked', async () => {
    const snapshot = data()
    snapshot.chats[0].controller_blocked = true
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.get('.room-controller-blocked').text()).toContain('New messages are saved but not routed yet.')
    await wrapper.get('.room-controller-blocked button').trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'resume_chat', chatId: 'chat-1' }))
  })

  it('shows stale execution warning from platform liveness observations', async () => {
    const snapshot = data()
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Build API', status: 'active' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'running' }]
    const bridge = api(snapshot)
    bridge.listStaleAssignments.mockResolvedValue([{ assignmentId: 'attempt', taskId: 'task', state: 'running' }])
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(bridge.listStaleAssignments).toHaveBeenCalledWith({ roomId: 'room-1', timeoutMs: 120000 })
    expect(wrapper.get('.room-stale-warning').text()).toContain('no platform heartbeat')
    expect(wrapper.get('.room-assignment').text()).toContain('Possibly disconnected')
  })

  it('loads an assignment trace through its room and assignment IDs only', async () => {
    const snapshot = data()
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Build API', status: 'active' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'running', run_id: 'run-private' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const trace = wrapper.get('.room-assignment-trace')
    trace.element.open = true
    await trace.trigger('toggle')
    await flushPromises()
    expect(bridge.assignmentTrace).toHaveBeenCalledWith({ roomId: 'room-1', assignmentId: 'attempt', direction: 'backward', limit: 100 })
    expect(trace.text()).toContain('Read source')
  })

  it('creates new projects from chosen directories and closes the modal with Escape', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('[data-testid="room-create-open"]').trigger('click')
    await wrapper.get('.room-create input').setValue('New team')
    await wrapper.get('.room-directory button').trigger('click')
    await flushPromises()
    await wrapper.get('.room-create').trigger('submit')
    await flushPromises()
    expect(bridge.bootstrap).toHaveBeenCalledWith({ name: 'New team', workspace: '/tmp/demo', providers: ['codex'], title: 'Team chat' })
    expect(() => structuredClone(bridge.bootstrap.mock.calls[0][0])).not.toThrow()
    expect(wrapper.find('.room-create').exists()).toBe(false)
    await wrapper.get('[data-testid="room-create-open"]').trigger('click')
    await wrapper.get('.room-create').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.room-create').exists()).toBe(false)
  })

  it('opens the create modal when the sidebar requests a new team room', async () => {
    setLocale('en')
    const bridge = api()
    const wrapper = mount(RoomWorkspace, { props: { api: bridge, pickDirectory: vi.fn(async () => '/tmp/demo'), agents: [{ kind: 'codex', label: 'Codex' }], createRequest: true } })
    cleanup.push(() => wrapper.unmount())
    await flushPromises()
    expect(wrapper.find('.room-create').exists()).toBe(true)
    expect(wrapper.emitted('create-request-consumed')).toHaveLength(1)
  })

  it('opens project settings from the project name and chat settings from the chat title', async () => {
    const snapshot = data()
    snapshot.room.workspace = '/tmp/current-project'
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    expect(wrapper.get('.room-welcome').isVisible()).toBe(true)
    expect(wrapper.get('.room-project-settings-modal').isVisible()).toBe(false)
    expect(wrapper.get('.room-chat-settings-modal').isVisible()).toBe(false)
    expect(wrapper.get('.room-timeline').text()).not.toContain('/tmp/current-project')
    await wrapper.get('.room-project-name').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-project-settings-modal').isVisible()).toBe(true)
    expect(wrapper.get('.room-overview').text()).toContain('/tmp/current-project')
    await wrapper.get('.room-project-settings-modal').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.get('.room-project-settings-modal').isVisible()).toBe(false)
    await wrapper.get('.room-chat-title').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-chat-settings-modal').isVisible()).toBe(true)
    expect(wrapper.get('.room-context').text()).toContain('No collaboration agreement yet')
    await wrapper.get('.room-chat-settings-modal').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.get('.room-chat-settings-modal').isVisible()).toBe(false)
  })

  it('shows default agent seats and marks the controller seat', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex']
    snapshot.roles = [{ id: 'controller-seat', chat_id: 'chat-1', display_name: 'codex', provider: 'codex', status: 'active', creation_reason: 'project_default_agent', current_prompt: '', is_controller: 1 }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    const chip = wrapper.get('.room-agent-chip')
    expect(chip.text()).toContain('Codex')
    expect(chip.text()).toContain('Controller')
    await chip.trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-role-v2-title').text()).toContain('Controller')
    expect(wrapper.get('.room-role-modal').text()).not.toContain('Added for')
  })

  it('opens role settings from an agent chip and saves the prompt', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', status: 'active', responsibilities: 'Write docs.', creation_reason: 'Documentation task.', current_prompt: 'Write clearly.', capabilities_json: ['write'] }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-role-modal').isVisible()).toBe(true)
    expect(wrapper.get('.room-role-modal').text()).toContain('Writer')
    expect(wrapper.find('.room-role-v2-close .secondary-button').exists()).toBe(false)
    expect(wrapper.find('.room-role-v2-close .room-icon-button').exists()).toBe(true)
    expect(wrapper.find('.room-role-v2-intro').exists()).toBe(true)
    expect(wrapper.find('.room-role-provider-choice.active').exists()).toBe(true)
    const prompt = wrapper.get('.room-role-prompt')
    expect(prompt.element.value).toBe('Write clearly.')
    await prompt.setValue('Write concise docs.')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_role', roleId: 'worker', prompt: 'Write concise docs.', chatId: 'chat-1', commandId: expect.any(String),
    }))
    await wrapper.get('.room-role-modal').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('.room-role-modal').exists()).toBe(false)
  })

  it('opens role settings directly when adding an agent', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex', 'claude']
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.find('.room-chat-toolbar').exists()).toBe(false)

    await wrapper.get('.room-agent-add').trigger('click')
    await flushPromises()
    expect(wrapper.find('.room-add-agent-modal').exists()).toBe(false)
    expect(wrapper.get('.room-role-modal').isVisible()).toBe(true)
    expect(wrapper.find('.room-role-delete-button').exists()).toBe(false)
    expect(wrapper.get('.room-role-v2-name input').element.value).toBe('Codex')

    await wrapper.get('.room-role-v2-name input').setValue('Reviewer')
    await wrapper.get('.room-role-controller-toggle').trigger('click')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()

    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create_role',
      displayName: 'Reviewer',
      provider: 'codex',
      responsibilities: '',
      nativePermission: 'read-only',
      isController: true,
      chatId: 'chat-1',
      commandId: expect.any(String),
    }))
    expect(wrapper.find('.room-role-modal').exists()).toBe(false)
  })

  it('deletes an existing role from the role settings header', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', status: 'active', capabilities_json: [], current_prompt: '' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()

    await wrapper.get('.room-role-delete-button').trigger('click')
    expect(wrapper.get('.room-role-delete-confirm').text()).toContain('Delete role Writer')
    await wrapper.get('.room-role-delete-confirm .danger-button').trigger('click')
    await flushPromises()

    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'delete_role',
      roleId: 'worker',
      chatId: 'chat-1',
      commandId: expect.any(String),
    }))
    expect(wrapper.find('.room-role-modal').exists()).toBe(false)
  })

  it('edits role name, responsibilities, agent and native permission through one command', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['codex', 'claude']
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'codex', status: 'active', responsibilities: 'Write docs.', current_prompt: 'Write clearly.', capabilities_json: ['read'] }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()

    const name = wrapper.get('.room-role-v2-name input')
    await name.setValue('Editor')
    await wrapper.get('.room-role-v2-intro').setValue('Edit and publish docs.')
    await wrapper.get('.room-role-provider-choice[data-provider="claude"]').trigger('click')
    const acceptEdits = wrapper.findAll('.room-mini-option').find(node => node.text() === 'Accept Edits')
    await acceptEdits.get('input').setValue(true)
    await wrapper.get('.room-role-controller-toggle').trigger('click')
    await wrapper.get('.room-role-v2-footer .primary-button').trigger('click')
    await flushPromises()

    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_role',
      roleId: 'worker',
      displayName: 'Editor',
      responsibilities: 'Edit and publish docs.',
      provider: 'claude',
      nativePermission: 'acceptEdits',
      isController: true,
      chatId: 'chat-1',
      commandId: expect.any(String),
    }))
    expect(() => structuredClone(bridge.applyUserCommand.mock.calls[0][0])).not.toThrow()
  })

  it('localizes native permission mode labels and descriptions', async () => {
    const snapshot = data()
    snapshot.room.providers_json = ['claude']
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Writer', provider: 'claude', status: 'active', native_permission: 'acceptEdits' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-agent-chip').trigger('click')
    await flushPromises()

    setLocale('zh')
    await wrapper.vm.$nextTick()
    const section = wrapper.findAll('.room-role-v2-section').find(node => node.text().includes('执行权限'))
    expect(section).toBeTruthy()
    expect(section.text()).toContain('自动接受编辑')
    expect(section.text()).toContain('自动接受文件修改。')
  })

  it('opens the requested chat and reports active room changes', async () => {
    const snapshot = data()
    const bridge = api(snapshot)
    setLocale('en')
    const wrapper = mount(RoomWorkspace, {
      props: {
        api: bridge,
        pickDirectory: vi.fn(async () => '/tmp/demo'),
        agents: [{ kind: 'codex', label: 'Codex' }],
        openRequest: { roomId: 'room-1', chatId: 'chat-2', nonce: 1 },
      },
    })
    cleanup.push(() => wrapper.unmount())
    await flushPromises()
    expect(wrapper.get('.room-chat-title').text()).toContain('Second chat')
    expect(wrapper.emitted('active-change').at(-1)[0]).toEqual({ roomId: 'room-1', chatId: 'chat-2' })
  })

  it('renders Attention cards in the conversation and answers them', async () => {
    const snapshot = data()
    snapshot.attentions = [{ id: 'attention-1', chat_id: 'chat-1', type: 'decision', question: 'Proceed?', options_json: [{ id: 'yes', label: 'Yes' }], status: 'open' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    const card = wrapper.get('.room-attention-card')
    expect(card.text()).toContain('Proceed?')
    await card.get('select').setValue('yes')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'answer_attention', chatId: 'chat-1', attentionId: 'attention-1', optionId: 'yes',
    }))
  })

  it('shows the work panel only when there is work to inspect', async () => {
    const empty = mountRoom(api(data()))
    await flushPromises()
    expect(empty.find('.room-ledger').exists()).toBe(false)
    expect(empty.find('.room-work-toggle').exists()).toBe(false)

    const snapshot = data()
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Build API', status: 'active' }]
    const working = mountRoom(api(snapshot))
    await flushPromises()
    expect(working.find('.room-ledger').exists()).toBe(true)
    expect(working.get('.room-work-toggle').text()).toContain('Work')
  })

  it('renders reported artifacts inline and keeps only unlinked artifacts in the work panel', async () => {
    const snapshot = data()
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Write docs', status: 'done' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'completed' }]
    snapshot.artifacts = [
      { id: 'linked', path: 'docs/spec.md', version: 'commit-1', status: 'published' },
      { id: 'loose', path: 'assets/hero.png', version: 'commit-2', status: 'published' },
    ]
    snapshot.reports = [{ id: 'report', task_id: 'task', assignment_id: 'attempt', summary: 'Document ready', evidence_json: [], artifact_ids_json: ['linked'], created_at: '2026-11-15T00:00:00Z' }]
    const wrapper = mountRoom(api(snapshot))
    await flushPromises()
    expect(wrapper.get('.room-message-artifacts').text()).toContain('docs/spec.md')
    expect(wrapper.get('.room-ledger').text()).not.toContain('docs/spec.md')
    expect(wrapper.get('.room-ledger').text()).toContain('assets/hero.png')
  })
})
