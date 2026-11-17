const crypto = require('node:crypto')

const { createDomainIdempotency } = require('../domain-idempotency.cjs')

function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value ?? {})).digest('hex')
}

/**
 * docs-new2/04 §5.1: create_task is unique per assignment + source message.
 * Outside an assignment, a call is scoped to its run and argument shape so a
 * retry with a new callId still maps to the first task while a genuinely
 * different task in the same run is allowed.
 */
function domainScope(context) {
  if (context.captainAssignmentId && context.rootMessageId) {
    return `assignment:${context.captainAssignmentId}:source:${context.rootMessageId}`
  }
  return `run:${context.runId ?? 'none'}`
}

function domainKey(context, kind, extra = '') {
  return `${kind}:${context.chatId}:${domainScope(context)}${extra ? `:${extra}` : ''}`
}

function registerTaskTools({ dispatcher, roomDb, repository, timeline, queueRun }) {
  const { database } = roomDb
  const idempotency = createDomainIdempotency({ roomDb })

  dispatcher.register('create_task', async (args, context) => {
    const perAssignment = Boolean(context.captainAssignmentId && context.rootMessageId)
    const extra = perAssignment ? '' : `args:${stableHash(args)}`
    return idempotency.runOnce({
      key: domainKey(context, 'create_task', extra),
      chatId: context.chatId,
      kind: 'create_task',
      create: () => queueRun.createTask({
        chatId: context.chatId,
        roleId: context.roleId,
        title: args.title,
        description: args.description ?? '',
        acceptance: args.acceptance ?? '',
        parentTaskId: args.parent_task_id ?? null,
        blockedBy: args.blocked_by ?? [],
        optional: args.optional ?? false,
        assigneeRoleId: args.assignee_role_id ?? context.roleId,
        captainAssignmentId: context.captainAssignmentId ?? null,
      }),
    })
  }, {
    description: 'Create a task for yourself or another participant in this chat.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        acceptance: { type: 'string' },
        workspace: { type: 'string' },
        parent_task_id: { type: ['string', 'null'] },
        blocked_by: { type: 'array', items: { type: 'string' } },
        optional: { type: 'boolean' },
        assignee_role_id: { type: ['string', 'null'] },
      },
      required: ['title', 'description', 'acceptance'],
    },
  })

  dispatcher.register('comment_task', async (args, context) => {
    const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(args.taskId)
    if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
    if (task.chat_id !== context.chatId) throw new Error('ROOM_TASK_NOT_IN_CHAT')

    const callerKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : ''
    const extra = `task:${args.taskId}:${callerKey ? `key:${callerKey}` : `text:${stableHash(args.text ?? '')}`}`
    return idempotency.runOnce({
      key: domainKey(context, 'comment_task', extra),
      chatId: context.chatId,
      kind: 'comment_task',
      create: () => roomDb.withTransaction(() => {
        const seq = database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_activities WHERE task_id = ?')
          .get(args.taskId).seq
        const activityId = crypto.randomUUID()
        database.prepare(`
          INSERT INTO task_activities (id, task_id, seq, kind, author_type, author_id, body, created_at)
          VALUES (?, ?, ?, 'comment', 'agent', ?, ?, ?)
        `).run(activityId, args.taskId, seq, context.roleId, args.text ?? '', new Date().toISOString())
        const active = database.prepare(`
          SELECT 1 AS active FROM task_runs WHERE task_id = ? AND status IN ('starting', 'running') LIMIT 1
        `).get(args.taskId)
        let runId = null
        if (!active) {
          const last = database.prepare(`
            SELECT id FROM task_runs WHERE task_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1
          `).get(args.taskId)
          // A comment from the executor continues the executor lane. A comment
          // from any other participant stays in that participant's mention
          // lane and never becomes a required run for acceptance.
          const executor = task.assignee_role_id === context.roleId
          const laneKind = executor ? 'executor' : 'mention'
          const run = queueRun.enqueueRun({
            taskId: args.taskId,
            roleId: context.roleId,
            laneKind,
            required: executor,
            continuesRunId: last?.id ?? null,
            writeScopes: [],
          })
          runId = run.id
        }
        return { activityId, runId }
      }),
    })
  }, {
    description: 'Add a comment to a task; if the task is idle this queues a continuation run.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        text: { type: 'string' },
        idempotency_key: {
          type: 'string',
          description: 'Stable key for this logical comment; retries must reuse it. When omitted, the platform derives one from the source message and text.',
        },
      },
      required: ['taskId', 'text'],
    },
  })
}

module.exports = { registerTaskTools }
