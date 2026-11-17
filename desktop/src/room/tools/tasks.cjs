const crypto = require('node:crypto')

function registerTaskTools({ dispatcher, roomDb, repository, timeline, queueRun }) {
  const { database } = roomDb

  dispatcher.register('create_task', async (args, context) => {
    return queueRun.createTask({
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
    return roomDb.withTransaction(() => {
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
        const run = queueRun.enqueueRun({
          taskId: args.taskId,
          roleId: context.roleId,
          laneKind: 'executor',
          required: true,
          continuesRunId: last?.id ?? null,
          writeScopes: [],
        })
        runId = run.id
      }
      return { activityId, runId }
    })
  }, {
    description: 'Add a comment to a task; if the task is idle this queues a continuation run.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['taskId', 'text'],
    },
  })
}

module.exports = { registerTaskTools }
