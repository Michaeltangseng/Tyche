import { describe, expect, it } from 'vitest'
import { buildRoomWorkflow } from '../../roomWorkflow.js'

const roles = [
  { id: 'captain', display_name: 'Captain', is_captain: true },
  { id: 'jia', display_name: '甲' },
  { id: 'yi', display_name: '乙' },
]

describe('room workflow', () => {
  it('grows a branch only from tasks that were actually created', () => {
    const first = buildRoomWorkflow({
      roles,
      tasks: [{
        id: 'joke',
        title: '写个笑话',
        assignee_role_id: 'jia',
        created_by_role_id: 'captain',
        status: 'done',
        created_at: '2026-11-25T10:00:00Z',
      }],
      runs: [{ id: 'run-1', task_id: 'joke', status: 'completed' }],
    })
    expect(first.layers.map(layer => layer.map(node => node.roleId))).toEqual([['captain'], ['jia']])
    expect(first.nodes.find(node => node.id === 'joke').live).toBe(false)

    const branched = buildRoomWorkflow({
      roles,
      tasks: [
        ...[{
          id: 'joke',
          title: '写个笑话',
          assignee_role_id: 'jia',
          created_by_role_id: 'captain',
          status: 'done',
          created_at: '2026-11-25T10:00:00Z',
        }],
        {
          id: 'setup',
          title: '起个头',
          assignee_role_id: 'jia',
          parent_task_id: 'joke',
          status: 'done',
          created_at: '2026-11-25T10:01:00Z',
        },
        {
          id: 'punchline',
          title: '收尾',
          assignee_role_id: 'yi',
          parent_task_id: 'joke',
          status: 'in_progress',
          created_at: '2026-11-25T10:02:00Z',
        },
      ],
      runs: [{ id: 'run-2', task_id: 'punchline', status: 'running' }],
    })
    expect(branched.layers.map(layer => layer.map(node => node.id))).toEqual([
      ['origin:captain'],
      ['joke'],
      ['setup', 'punchline'],
    ])
    expect(branched.nodes.find(node => node.id === 'punchline').live).toBe(true)
    expect(branched.nodes.find(node => node.id === 'setup').live).toBe(false)
    expect(branched.edges.map(edge => edge.label)).toEqual(['写个笑话', '起个头', '收尾'])
  })

  it('adds a beat for each later handoff instead of stopping at the first task', () => {
    const graph = buildRoomWorkflow({
      roles,
      tasks: [{
        id: 'joke',
        title: '讲一个笑话',
        assignee_role_id: 'jia',
        created_by_role_id: 'captain',
        status: 'in_progress',
        created_at: '2026-11-25T10:00:00Z',
      }],
      messages: [
        { id: 'm1', sequence: 1, author_type: 'agent', author_id: 'captain', kind: 'mention', mentions: ['jia'], content: '开工', status: 'done' },
        { id: 'm2', sequence: 2, author_type: 'agent', author_id: 'jia', kind: 'message', mentions: [], content: '笑话正文', status: 'done' },
        { id: 'm3', sequence: 3, author_type: 'agent', author_id: 'jia', kind: 'mention', mentions: ['yi'], content: '该你了', status: 'done' },
        { id: 'm4', sequence: 4, author_type: 'agent', author_id: 'yi', kind: 'message', mentions: [], content: '第二则', status: 'done' },
        { id: 'm5', sequence: 5, author_type: 'agent', author_id: 'yi', kind: 'mention', mentions: ['jia'], content: '再来一个', status: 'done' },
        { id: 'm6', sequence: 6, author_type: 'agent', author_id: 'jia', kind: 'message', mentions: [], content: '第三则', status: 'working' },
      ],
    })

    expect(graph.layers.map(layer => layer.map(node => node.roleId))).toEqual([
      ['captain'],
      ['jia'],
      ['yi'],
      ['jia'],
    ])
    expect(graph.edges.map(edge => edge.label)).toEqual(['讲一个笑话', '该你了', '再来一个'])
    const speakers = graph.nodes.filter(node => node.roleId === 'jia')
    expect(speakers[0].live).toBe(false)
    expect(speakers[1].live).toBe(true)
  })

  it('shows an assignment target until a later task records that handoff', () => {
    const pending = buildRoomWorkflow({
      roles,
      assignments: [{
        id: 'assignment-1',
        target_role_ids: ['jia'],
        status: 'active',
        message_id: 'message-1',
        created_at: '2026-11-25T10:00:00Z',
      }],
      messages: [{ id: 'message-1', content: '先说一个笑话' }],
    })
    expect(pending.layers.map(layer => layer.map(node => node.id))).toEqual([
      ['origin:captain'],
      ['assignment:assignment-1:jia'],
    ])
    expect(pending.nodes.find(node => node.roleId === 'jia').live).toBe(true)
    expect(pending.edges[0].label).toBe('先说一个笑话')
  })
})
