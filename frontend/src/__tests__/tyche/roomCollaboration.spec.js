import { describe, expect, it } from 'vitest'
import { deriveRoomCollaboration } from '../../roomCollaboration.js'

function task(overrides = {}) {
  return {
    id: 'task-1',
    chat_id: 'chat-1',
    number: 1,
    title: 'Draft the plan',
    status: 'in_progress',
    assignee_role_id: 'worker',
    captain_assignment_id: '',
    created_at: '2026-11-15T10:00:00Z',
    updated_at: '2026-11-15T10:00:00Z',
    ...overrides,
  }
}

function run(overrides = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    role_id: 'worker',
    status: 'running',
    queued_at: '2026-11-15T10:01:00Z',
    started_at: '2026-11-15T10:01:10Z',
    ended_at: null,
    ...overrides,
  }
}

function agentMessage(overrides = {}) {
  return {
    id: 'message-1',
    chat_id: 'chat-1',
    author_type: 'agent',
    author_id: 'worker',
    status: 'working',
    created_at: '2026-11-15T10:02:00Z',
    ...overrides,
  }
}

function userMessage(overrides = {}) {
  return {
    id: 'user-1',
    chat_id: 'chat-1',
    author_type: 'user',
    status: 'done',
    created_at: '2026-11-15T10:00:00Z',
    ...overrides,
  }
}

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    chat_id: 'chat-1',
    status: 'active',
    target_role_ids: ['worker'],
    target_reply_ids: [],
    created_at: '2026-11-15T10:01:00Z',
    ...overrides,
  }
}

describe('room collaboration derivation', () => {
  it('stays idle without live work or a settled task', () => {
    expect(deriveRoomCollaboration({})).toMatchObject({
      mode: 'idle',
      nodes: [],
      activeRoleId: '',
      taskId: '',
    })
  })

  it('shows a replying agent without turning it into a task pipeline', () => {
    const state = deriveRoomCollaboration({
      messages: [agentMessage()],
    })

    expect(state.mode).toBe('replying')
    expect(state.nodes).toEqual([])
    expect(state.activeRoleId).toBe('worker')
    expect(state.activeSince).toBe('2026-11-15T10:02:00Z')
    expect(state.replies).toEqual([
      { roleId: 'worker', since: '2026-11-15T10:02:00Z', messageId: 'message-1' },
    ])
  })

  it('builds the relay from task runs and marks the live node active', () => {
    const state = deriveRoomCollaboration({
      tasks: [task()],
      runs: [
        run(),
        run({
          id: 'run-2',
          role_id: 'reviewer',
          status: 'queued',
          queued_at: '2026-11-15T10:03:00Z',
          started_at: null,
        }),
      ],
      assignments: [{
        id: 'assignment-1',
        chat_id: 'chat-1',
        target_role_ids: ['worker', 'reviewer'],
        created_at: '2026-11-15T09:59:00Z',
      }],
    })

    expect(state.mode).toBe('running')
    expect(state.taskNumber).toBe(1)
    expect(state.activeRoleId).toBe('worker')
    expect(state.activeSince).toBe('2026-11-15T10:01:10Z')
    expect(state.nodes.map(node => [node.roleId, node.state])).toEqual([
      ['worker', 'active'],
      ['reviewer', 'waiting'],
    ])
  })

  it('shows an assigned role as waiting before its run is queued', () => {
    const state = deriveRoomCollaboration({
      tasks: [task({ assignee_role_id: '', captain_assignment_id: 'assignment-1' })],
      assignments: [{
        id: 'assignment-1',
        target_role_ids: ['worker'],
        created_at: '2026-11-15T09:59:00Z',
      }],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes).toEqual([expect.objectContaining({
      roleId: 'worker',
      state: 'waiting',
      source: 'assigned',
    })])
    expect(state.activeRoleId).toBe('')
  })

  it('appends a live reply from a role outside the task chain', () => {
    const state = deriveRoomCollaboration({
      tasks: [task()],
      runs: [run()],
      messages: [agentMessage({ id: 'captain-reply', author_id: 'captain', created_at: '2026-11-15T10:05:00Z' })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes.map(node => [node.roleId, node.state, node.source])).toEqual([
      ['worker', 'active', 'run'],
      ['captain', 'active', 'reply'],
    ])
    expect(state.activeRoleId).toBe('captain')
    expect(state.activeSince).toBe('2026-11-15T10:05:00Z')
  })

  it('counts additional live tasks without inventing their nodes', () => {
    const state = deriveRoomCollaboration({
      tasks: [
        task(),
        task({ id: 'task-2', number: 2, title: 'Second task', assignee_role_id: 'reviewer', created_at: '2026-11-15T10:04:00Z' }),
      ],
      runs: [
        run(),
        run({ id: 'run-2', task_id: 'task-2', role_id: 'reviewer', queued_at: '2026-11-15T10:05:00Z' }),
      ],
    })

    expect(state.mode).toBe('running')
    expect(state.extraActiveTasks).toBe(1)
    expect(state.nodes.map(node => node.roleId)).toEqual(['reviewer'])
  })

  it('recaps a completed task with the roles that actually ran', () => {
    const state = deriveRoomCollaboration({
      tasks: [task({ status: 'in_review', updated_at: '2026-11-15T10:04:00Z' })],
      runs: [run({ status: 'completed', ended_at: '2026-11-15T10:04:00Z' })],
      reports: [{
        id: 'report-1',
        task_id: 'task-1',
        run_id: 'run-1',
        kind: 'ready',
        created_at: '2026-11-15T10:04:30Z',
      }],
      messages: [agentMessage({ status: 'done' })],
    })

    expect(state.mode).toBe('settled')
    expect(state.tone).toBe('review')
    expect(state.nodes).toEqual([expect.objectContaining({
      roleId: 'worker',
      state: 'done',
      runId: 'run-1',
    })])
    expect(state.settledAt).toBe('2026-11-15T10:04:30.000Z')
  })

  it('returns to idle once the user starts a new turn', () => {
    const state = deriveRoomCollaboration({
      tasks: [task({ status: 'done', updated_at: '2026-11-15T10:04:00Z' })],
      runs: [run({ status: 'completed', ended_at: '2026-11-15T10:04:00Z' })],
      messages: [{
        id: 'user-2',
        chat_id: 'chat-1',
        author_type: 'user',
        status: 'done',
        created_at: '2026-11-15T10:10:00Z',
      }],
    })

    expect(state.mode).toBe('idle')
    expect(state.nodes).toEqual([])
  })

  it('marks a failed run as attention in the recap', () => {
    const state = deriveRoomCollaboration({
      tasks: [task({ status: 'blocked' })],
      runs: [run({ status: 'failed', ended_at: '2026-11-15T10:04:00Z' })],
      messages: [agentMessage({ status: 'done' })],
    })

    expect(state.mode).toBe('settled')
    expect(state.tone).toBe('attention')
    expect(state.nodes[0].state).toBe('attention')
  })

  it('switches to the relay when a Captain assignment is live', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-reply',
          author_id: 'worker',
          status: 'working',
          created_at: '2026-11-15T10:02:00Z',
        }),
      ],
      assignments: [assignment({
        target_role_ids: ['worker', 'reviewer'],
        target_reply_ids: ['worker-reply'],
      })],
    })

    expect(state.mode).toBe('running')
    expect(state.taskNumber).toBe('')
    expect(state.nodes.map(node => [node.roleId, node.state])).toEqual([
      ['worker', 'active'],
      ['reviewer', 'waiting'],
    ])
    expect(state.activeRoleId).toBe('worker')
  })

  it('marks a completed assignment step done and keeps the current one lit', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-done',
          author_id: 'worker',
          status: 'done',
          created_at: '2026-11-15T10:02:00Z',
          mentions: ['reviewer'],
        }),
        agentMessage({
          id: 'reviewer-live',
          author_id: 'reviewer',
          status: 'working',
          created_at: '2026-11-15T10:03:00Z',
        }),
      ],
      assignments: [assignment({
        target_role_ids: ['worker', 'reviewer'],
        target_reply_ids: ['worker-done', 'reviewer-live'],
      })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes.map(node => [node.roleId, node.state])).toEqual([
      ['worker', 'done'],
      ['reviewer', 'active'],
    ])
    expect(state.activeRoleId).toBe('reviewer')
  })

  it('uses a completed handoff message when the assignment has no reply ids', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-done',
          author_id: 'worker',
          status: 'done',
          created_at: '2026-11-15T10:02:00Z',
          mentions: ['reviewer'],
        }),
        agentMessage({
          id: 'reviewer-live',
          author_id: 'reviewer',
          status: 'working',
          created_at: '2026-11-15T10:03:00Z',
        }),
      ],
      assignments: [assignment({ target_role_ids: ['worker', 'reviewer'] })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes.map(node => [node.roleId, node.state])).toEqual([
      ['worker', 'done'],
      ['reviewer', 'active'],
    ])
  })

  it('shows assigned roles waiting before the first reply starts', () => {
    const state = deriveRoomCollaboration({
      messages: [userMessage()],
      assignments: [assignment({ target_role_ids: ['worker', 'reviewer'] })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes.map(node => node.state)).toEqual(['waiting', 'waiting'])
    expect(state.activeRoleId).toBe('')
  })

  it('does not replay an assignment from a previous user turn', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage({ created_at: '2026-11-15T10:10:00Z' }),
        agentMessage({ id: 'new-reply', status: 'working', created_at: '2026-11-15T10:11:00Z' }),
      ],
      assignments: [assignment({ created_at: '2026-11-15T09:00:00Z' })],
    })

    expect(state.mode).toBe('replying')
  })

  it('adds a live Captain reply to the assignment relay', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-done',
          author_id: 'worker',
          status: 'done',
          created_at: '2026-11-15T10:02:00Z',
          mentions: ['reviewer'],
        }),
        agentMessage({
          id: 'captain-live',
          author_id: 'captain',
          status: 'working',
          created_at: '2026-11-15T10:03:00Z',
        }),
      ],
      assignments: [assignment({ target_reply_ids: ['worker-done'] })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes.map(node => [node.roleId, node.state])).toEqual([
      ['worker', 'done'],
      ['captain', 'active'],
    ])
    expect(state.activeRoleId).toBe('captain')
  })

  it('recaps settled assignment work with the roles that replied', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-done',
          author_id: 'worker',
          status: 'done',
          created_at: '2026-11-15T10:02:00Z',
          mentions: ['reviewer'],
        }),
        agentMessage({
          id: 'reviewer-done',
          author_id: 'reviewer',
          status: 'done',
          created_at: '2026-11-15T10:03:00Z',
        }),
      ],
      assignments: [assignment({
        target_role_ids: ['worker', 'reviewer'],
        target_reply_ids: ['worker-done', 'reviewer-done'],
      })],
      reviews: [{
        id: 'review-1',
        chat_id: 'chat-1',
        kind: 'assignment_settled',
        status: 'done',
        created_at: '2026-11-15T10:04:00Z',
      }],
    })

    expect(state.mode).toBe('settled')
    expect(state.tone).toBe('done')
    expect(state.nodes.map(node => node.state)).toEqual(['done', 'done'])
    expect(state.settledAt).toBe('2026-11-15T10:04:00.000Z')
  })

  it('keeps a failed assignment step visible as attention', () => {
    const state = deriveRoomCollaboration({
      messages: [
        userMessage(),
        agentMessage({
          id: 'worker-failed',
          author_id: 'worker',
          status: 'failed',
          created_at: '2026-11-15T10:02:00Z',
        }),
      ],
      assignments: [assignment({ target_reply_ids: ['worker-failed'] })],
    })

    expect(state.mode).toBe('running')
    expect(state.nodes[0].state).toBe('attention')
  })
})
