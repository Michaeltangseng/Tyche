const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function taskView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    number: row.number,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    status: row.status,
    assigneeRoleId: row.assignee_role_id,
    captainAssignmentId: row.captain_assignment_id,
    updatedAt: row.updated_at,
  }
}

function reportView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    laneId: row.lane_id,
    kind: row.kind,
    summary: row.summary,
    evidence: parseJson(row.evidence_json, []),
    artifactIds: parseJson(row.artifact_ids_json, []),
    nextRequest: parseJson(row.next_request_json, null),
    attentionId: row.attention_id,
    createdAt: row.created_at,
  }
}

function runView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    taskId: row.task_id,
    laneId: row.lane_id,
    roleId: row.role_id,
    status: row.status,
    outcome: row.outcome,
    snapshotState: row.snapshot_state,
    endedAt: row.ended_at,
    reason: row.reason,
  }
}

function createSettlement({ roomDb, repository, timeline, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function loadTask(taskId) {
    return database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  }

  function loadRun(runId) {
    return database.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId)
  }

  function taskStatus(taskId) {
    return taskView(loadTask(taskId))
  }

  function attention({ chatId, taskId, type, question, requestedBy }) {
    const id = crypto.randomUUID()
    database.prepare(`
      INSERT INTO attentions (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, '[]', 'open', ?, ?)
    `).run(id, chatId, taskId, type, question, requestedBy, at())
    return id
  }

  return {
    claim({ runId, taskId, status, summary, evidence = [], artifactIds = [] }) {
      const run = loadRun(runId)
      if (!run) throw new Error('ROOM_RUN_NOT_FOUND')
      if (run.task_id !== taskId) throw new Error('ROOM_RUN_TASK_MISMATCH')
      if (!['progress', 'ready', 'waiting', 'blocked', 'failed', 'handoff'].includes(status)) {
        throw new Error('ROOM_REPORT_STATUS_INVALID')
      }
      const existing = database.prepare('SELECT * FROM reports WHERE run_id = ? AND kind = ?').get(runId, status)
      if (existing) return { report: reportView(existing), task: taskStatus(taskId) }

      return roomDb.withTransaction(() => {
        const task = loadTask(taskId)
        const reportId = crypto.randomUUID()
        const createdAt = at()
        database.prepare(`
          INSERT INTO reports
            (id, task_id, run_id, lane_id, kind, summary, evidence_json, artifact_ids_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reportId, taskId, runId, run.lane_id, status, summary ?? '',
          JSON.stringify(evidence ?? []), JSON.stringify(artifactIds ?? []), createdAt,
        )
        const seq = database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_activities WHERE task_id = ?')
          .get(taskId).seq
        const message = timeline.append({
          chatId: task.chat_id,
          authorType: 'agent',
          authorId: run.role_id,
          kind: 'report_card',
          content: summary ?? '',
          taskId,
          status: 'done',
          data: { reportId, reportKind: status },
        })
        database.prepare(`
          INSERT INTO task_activities (id, task_id, seq, kind, author_type, author_id, body, message_id, created_at)
          VALUES (?, ?, ?, 'report', 'agent', ?, ?, ?, ?)
        `).run(crypto.randomUUID(), taskId, seq, run.role_id, summary ?? '', message.id, createdAt)
        return {
          report: reportView(database.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)),
          task: taskStatus(taskId),
        }
      })
    },

    settle({ runId, exit, snapshot = { state: 'unknown' } }) {
      const run = loadRun(runId)
      if (!run) throw new Error('ROOM_RUN_NOT_FOUND')
      if (!['starting', 'running'].includes(run.status)) {
        return { task: taskStatus(run.task_id), run: runView(run) }
      }
      const task = loadTask(run.task_id)
      if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
      const report = database.prepare(`
        SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(runId)
      if (!report) throw new Error('ROOM_REPORT_REQUIRED')

      const writeCapable = parseJson(run.write_scopes_json, []).length > 0
      const endedAt = at()

      if (!exit?.observed) {
        database.prepare(`
          UPDATE task_runs SET status = 'interrupted', outcome = 'unknown', snapshot_state = 'unknown',
            ended_at = ?, reason = 'exit unconfirmed' WHERE id = ?
        `).run(endedAt, runId)
        database.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(endedAt, run.task_id)
        const attentionId = attention({
          chatId: task.chat_id,
          taskId: run.task_id,
          type: 'run_interrupted',
          question: report.summary || 'The run exited without a confirmed status.',
          requestedBy: run.role_id,
        })
        database.prepare('UPDATE reports SET attention_id = ? WHERE id = ?').run(attentionId, report.id)
        return { task: taskStatus(run.task_id), run: runView(loadRun(runId)) }
      }

      if (exit.code !== 0) {
        const snapshotState = writeCapable ? (snapshot?.state ?? 'failed') : 'not_applicable'
        database.prepare(`
          UPDATE task_runs SET status = 'failed', outcome = 'known', snapshot_state = ?,
            ended_at = ?, reason = ? WHERE id = ?
        `).run(snapshotState, endedAt, `exit code ${exit.code}`, runId)
        database.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(endedAt, run.task_id)
        const attentionId = attention({
          chatId: task.chat_id,
          taskId: run.task_id,
          type: 'run_failed',
          question: report.summary || `The run failed with exit code ${exit.code}.`,
          requestedBy: run.role_id,
        })
        database.prepare('UPDATE reports SET attention_id = ? WHERE id = ?').run(attentionId, report.id)
        return { task: taskStatus(run.task_id), run: runView(loadRun(runId)) }
      }

      if (writeCapable && snapshot?.state !== 'completed') {
        database.prepare(`
          UPDATE task_runs SET status = 'failed', outcome = 'known', snapshot_state = 'failed',
            ended_at = ?, reason = 'snapshot not completed' WHERE id = ?
        `).run(endedAt, runId)
        database.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(endedAt, run.task_id)
        const attentionId = attention({
          chatId: task.chat_id,
          taskId: run.task_id,
          type: 'snapshot_failed',
          question: 'The write-capable run did not produce a completed snapshot.',
          requestedBy: run.role_id,
        })
        database.prepare('UPDATE reports SET attention_id = ? WHERE id = ?').run(attentionId, report.id)
        return { task: taskStatus(run.task_id), run: runView(loadRun(runId)) }
      }

      const snapshotState = writeCapable ? 'completed' : 'not_applicable'
      if (writeCapable && Array.isArray(snapshot?.artifactIds) && snapshot.artifactIds.length > 0) {
        const artifactIds = [...new Set([...parseJson(report.artifact_ids_json, []), ...snapshot.artifactIds])]
        database.prepare('UPDATE reports SET artifact_ids_json = ? WHERE id = ?')
          .run(JSON.stringify(artifactIds), report.id)
      }
      const nextStatus = report.kind === 'ready'
        ? 'in_review'
        : report.kind === 'progress'
          ? 'in_progress'
          : 'blocked'
      database.prepare(`
        UPDATE task_runs SET status = 'completed', outcome = 'known', snapshot_state = ?, ended_at = ?
        WHERE id = ?
      `).run(snapshotState, endedAt, runId)
      database.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, endedAt, run.task_id)
      return { task: taskStatus(run.task_id), run: runView(loadRun(runId)) }
    },

    acceptTask({ taskId, commandId }) {
      if (typeof commandId !== 'string' || commandId.length === 0) throw new TypeError('ROOM_COMMAND_ID_REQUIRED')
      const existing = database.prepare('SELECT * FROM user_commands WHERE id = ?').get(commandId)
      if (existing) {
        const stored = parseJson(existing.result_json, {})
        if (existing.type !== 'accept_task' || stored.taskId !== taskId) throw new Error('ROOM_COMMAND_CONFLICT')
        return taskStatus(taskId)
      }
      const task = loadTask(taskId)
      if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
      if (task.status !== 'in_review') throw new Error('ROOM_TASK_NOT_SETTLED')
      // The acceptance gate belongs to the latest required run, not to any
      // earlier completed run: a later progress/failed run must block it.
      const latestRequired = database.prepare(`
        SELECT * FROM task_runs
        WHERE task_id = ? AND required = 1
        ORDER BY queued_at DESC, rowid DESC LIMIT 1
      `).get(taskId)
      if (!latestRequired || latestRequired.status !== 'completed' || latestRequired.outcome !== 'known') {
        throw new Error('ROOM_TASK_NOT_SETTLED')
      }
      const latestReport = database.prepare(`
        SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(latestRequired.id)
      if (!latestReport || latestReport.kind !== 'ready') throw new Error('ROOM_TASK_NOT_SETTLED')
      const requiredArtifacts = parseJson(task.required_artifact_ids_json, [])
      if (requiredArtifacts.length > 0) {
        const reportArtifacts = new Set(parseJson(latestReport.artifact_ids_json, []))
        if (requiredArtifacts.some(artifactId => !reportArtifacts.has(artifactId))) {
          throw new Error('ROOM_TASK_ARTIFACTS_MISSING')
        }
      }
      roomDb.withTransaction(() => {
        database.prepare(`
          INSERT INTO user_commands (id, chat_id, type, payload_json, status, result_json, created_at)
          VALUES (?, ?, 'accept_task', ?, 'succeeded', ?, ?)
        `).run(commandId, task.chat_id, JSON.stringify({ taskId }), JSON.stringify({ taskId, status: 'done' }), at())
        database.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(at(), taskId)
      })
      return taskStatus(taskId)
    },
  }
}

function registerFinishTaskTool({ dispatcher, settlement, roomDb }) {
  if (!roomDb) throw new TypeError('ROOM_FINISH_TASK_DATABASE_REQUIRED')
  const { database } = roomDb
  dispatcher.register('finish_task', async (args, context) => {
    const lane = database.prepare(`
      SELECT l.kind, l.role_id, t.assignee_role_id
      FROM task_runs r
      JOIN task_lanes l ON l.id = r.lane_id
      JOIN tasks t ON t.id = r.task_id
      WHERE r.id = ?
    `).get(context.runId)
    if (!lane || lane.kind !== 'executor' || lane.role_id !== lane.assignee_role_id) {
      throw new Error('ROOM_FINISH_TASK_LANE_INVALID')
    }
    return settlement.claim({
      runId: context.runId,
      taskId: args.taskId,
      status: args.status,
      summary: args.summary ?? '',
      evidence: args.evidence ?? [],
      artifactIds: args.artifact_ids ?? [],
    })
  }, {
    description: 'Claim that the current task run is ready, progress, blocked, or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['progress', 'ready', 'waiting', 'blocked', 'failed', 'handoff'] },
        summary: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        artifact_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'status', 'summary'],
    },
  })
}

module.exports = { createSettlement, registerFinishTaskTool }
