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
  return { listRooms: vi.fn(async () => [{ id: 'room-1', name: 'Demo' }]), snapshot: vi.fn(async () => snapshot),
    bootstrap: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-1' })),
    createChat: vi.fn(async () => ({ roomId: 'room-1', chatId: 'chat-2' })),
    artifactDiff: vi.fn(async () => ({ text: '+saved change', truncated: false })),
    submitMessage: vi.fn(async () => ({ ok: true })), applyUserCommand: vi.fn(async () => ({ ok: true })) }
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
    await wrapper.get('.room-chat-toolbar select').setValue('chat-2')
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
    await wrapper.get('textarea').setValue('first draft')
    await wrapper.get('.room-chat-toolbar select').setValue('chat-2')
    await wrapper.get('textarea').setValue('second draft')
    await wrapper.get('.room-chat-toolbar select').setValue('chat-1')
    expect(wrapper.get('textarea').element.value).toBe('first draft')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('first draft')
    expect(wrapper.get('[role=alert]').text()).toContain('could not be completed')
    await wrapper.get('.room-composer').trigger('submit')
    await flushPromises()
    expect(bridge.submitMessage).toHaveBeenLastCalledWith({ chatId: 'chat-1', content: 'first draft' })
    expect(wrapper.get('textarea').element.value).toBe('')
  })

  it('renders Reports as escaped text, isolates chat roles and exposes validated task controls', async () => {
    const snapshot = data()
    snapshot.roles = [{ id: 'worker', chat_id: 'chat-1', display_name: 'Builder', provider: 'codex', status: 'active', current_prompt: 'Build reliable APIs.' }, { id: 'foreign', chat_id: 'chat-2', display_name: 'Other team', status: 'active' }]
    snapshot.tasks = [{ id: 'task', chat_id: 'chat-1', objective: 'Build API', status: 'active' }]
    snapshot.assignments = [{ id: 'attempt', task_id: 'task', role_id: 'worker', status: 'failed', outcome: 'failed' }]
    snapshot.reports = [{ id: 'report', task_id: 'task', assignment_id: 'attempt', summary: '<script>unsafe()</script>', evidence_json: ['tested'], created_at: '2026-11-15T00:00:00Z' }]
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(wrapper.find('.room-report script').exists()).toBe(false)
    expect(wrapper.get('.room-report').text()).toContain('<script>unsafe()</script>')
    expect(wrapper.get('.room-team').text()).not.toContain('Other team')
    expect(wrapper.get('.room-team').text()).toContain('Build reliable APIs.')
    const roleEditor = wrapper.get('.room-role-editor textarea')
    await roleEditor.setValue('Prefer small, tested changes.')
    await wrapper.get('.room-role-editor').trigger('submit')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_role_prompt', roleId: 'worker', prompt: 'Prefer small, tested changes.', chatId: 'chat-1', commandId: expect.any(String),
    }))
    const stop = wrapper.findAll('button').find(button => button.text() === 'Stop task')
    await stop.trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop_task', taskId: 'task', chatId: 'chat-1', commandId: expect.any(String) }))
    const retry = wrapper.findAll('button').find(button => button.text() === 'Retry')
    await retry.trigger('click')
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'retry_task', assignmentId: 'attempt', commandId: expect.any(String) }))
  })

  it('requires explicit directory write opt-in and disables permission changes for unknown executions', async () => {
    const snapshot = data()
    const bridge = api(snapshot)
    const wrapper = mountRoom(bridge)
    await flushPromises()
    expect(bridge.applyUserCommand).not.toHaveBeenCalled()
    await wrapper.get('.room-permissions input').setValue(true)
    await flushPromises()
    expect(bridge.applyUserCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_workspace_write', allowWrite: true, commandId: expect.any(String) }))
    snapshot.assignments = [{ id: 'unknown', outcome: 'unknown', status: 'waiting' }]
    bridge.snapshot.mockResolvedValue({ ...snapshot })
    await wrapper.get('.room-permissions button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.room-permissions input').element.disabled).toBe(true)
  })

  it('creates new projects from chosen directories and closes the inline form with Escape', async () => {
    const bridge = api()
    const wrapper = mountRoom(bridge)
    await flushPromises()
    await wrapper.get('.room-toolbar button').trigger('click')
    await wrapper.get('.room-create input').setValue('New team')
    await wrapper.get('.room-directory button').trigger('click')
    await flushPromises()
    await wrapper.get('.room-provider input').setValue(true)
    await wrapper.get('.room-create').trigger('submit')
    await flushPromises()
    expect(bridge.bootstrap).toHaveBeenCalledWith({ name: 'New team', workspace: '/tmp/demo', providers: ['codex'] })
    expect(wrapper.find('.room-create').exists()).toBe(false)
    await wrapper.get('.room-toolbar button').trigger('click')
    await wrapper.get('.room-create').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.room-create').exists()).toBe(false)
  })
})
