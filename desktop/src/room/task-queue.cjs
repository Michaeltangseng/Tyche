const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
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
    sessionId: row.session_id,
    required: row.required === 1,
    continuesRunId: row.continues_run_id,
    previousRunId: row.previous_run_id,
    captainAssignmentId: row.captain_assignment_id,
    machine: row.machine,
    workspaceRef: row.workspace_ref,
    writeScopes: parseJson(row.write_scopes_json, []),
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    reason: row.reason,
  }
}

function laneView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    taskId: row.task_id,
    roleId: row.role_id,
    kind: row.kind,
    sessionId: row.session_id,
    lastSeq: row.last_seq,
    active: row.active === 1,
    createdAt: row.created_at,
  }
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
  }
}

function createTaskQueue({ roomDb, repository, timeline, outbox, now = () => Date.now(), startRun = null }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function getTask(taskId) {
    return taskView(database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId))
  }

  function enqueueRunInternal({ taskId, roleId, laneKind = 'executor', required = true, continuesRunId = null, writeScopes = [] }) {
    const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
    let lane = database.prepare('SELECT * FROM task_lanes WHERE task_id = ? AND role_id = ? AND kind = ?').get(taskId, roleId, laneKind)
    if (!lane) {
      const laneId = crypto.randomUUID()
      database.prepare(`
        INSERT INTO task_lanes (id, task_id, role_id, kind, last_seq, active, created_at)
        VALUES (?, ?, ?, ?, 0, 1, ?)
      `).run(laneId, taskId, roleId, laneKind, at())
      lane = database.prepare('SELECT * FROM task_lanes WHERE id = ?').get(laneId)
    }
    const previous = database.prepare(`
      SELECT id FROM task_runs WHERE lane_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1
    `).get(lane.id)
    const room = database.prepare(`
      SELECT r.workspace FROM rooms r JOIN chats c ON c.room_id = r.id WHERE c.id = ?
    `).get(task.chat_id)
    const runId = crypto.randomUUID()
    const queuedAt = at()
    database.prepare(`
      INSERT INTO task_runs
        (id, task_id, lane_id, role_id, status, outcome, snapshot_state, required, continues_run_id,
         previous_run_id, captain_assignment_id, workspace_ref, write_scopes_json, queued_at)
      VALUES (?, ?, ?, ?, 'queued', 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, taskId, lane.id, roleId, required ? 1 : 0, continuesRunId, previous?.id ?? null,
      task.captain_assignment_id ?? null, room?.workspace ?? null,
      JSON.stringify(writeScopes ?? []), queuedAt,
    )
    outbox.enqueue({
      chatId: task.chat_id,
      kind: 'start_run',
      payload: { runId, taskId, laneId: lane.id, roleId, laneKind, writeScopes: writeScopes ?? [] },
      idempotencyKey: `start_run:${runId}`,
    })
    return runView(database.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId))
  }

  const queue = {
    createTask({ chatId, roleId, title, description, acceptance, parentTaskId = null, blockedBy = [], optional = false, assigneeRoleId = null, captainAssignmentId = null }) {
      if (typeof title !== 'string' || title.length === 0) throw new TypeError('ROOM_TASK_TITLE_REQUIRED')
      const chat = repository.getChat(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const creator = repository.getRole(roleId)
      if (!creator || creator.chatId !== chatId || creator.status !== 'active') throw new Error('ROOM_TASK_CREATOR_INVALID')
      const assignee = captainAssignmentId ? roleId : (assigneeRoleId ?? roleId)
      if (!captainAssignmentId) {
        const assigneeRole = repository.getRole(assignee)
        if (!assigneeRole || assigneeRole.chatId !== chatId || assigneeRole.status !== 'active') {
          throw new Error('ROOM_TASK_ASSIGNEE_INVALID')
        }
      }
      const roomRow = database.prepare(`
        SELECT r.workspace_origin AS origin, r.workspace_confirmed AS confirmed
        FROM rooms r JOIN chats c ON c.room_id = r.id
        WHERE c.id = ?
      `).get(chatId)
      if (roomRow?.origin === 'default' && Number(roomRow.confirmed) !== 1) {
        const open = database.prepare(`
          SELECT id FROM attentions
          WHERE chat_id = ? AND type = 'workspace_directory' AND status = 'open'
          LIMIT 1
        `).get(chatId)
        if (!open) {
          database.prepare(`
            INSERT INTO attentions (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
            VALUES (?, ?, NULL, 'workspace_directory', ?, '[]', 'open', 'captain', ?)
          `).run(
            crypto.randomUUID(),
            chatId,
            'Set a working directory before files are changed.',
            at(),
          )
        }
        throw new Error('ROOM_WORKSPACE_UNCONFIRMED')
      }
      return roomDb.withTransaction(() => {
        const next = database.prepare(`
          SELECT COALESCE(MAX(t.number), 0) + 1 AS number
          FROM tasks t JOIN chats c ON c.id = t.chat_id
          WHERE c.room_id = ?
        `).get(chat.roomId).number
        const taskId = crypto.randomUUID()
        const createdAt = at()
        database.prepare(`
          INSERT INTO tasks
            (id, chat_id, number, title, description, acceptance, kind, status, created_by_role_id,
             assignee_role_id, captain_assignment_id, parent_task_id, blocked_by_task_ids_json,
             optional, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'task', 'todo', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId, chatId, next, title, description ?? '', acceptance ?? '', roleId, assignee,
          captainAssignmentId, parentTaskId, JSON.stringify(blockedBy ?? []), optional ? 1 : 0,
          createdAt, createdAt,
        )
        const run = enqueueRunInternal({ taskId, roleId: assignee })
        return { taskId, runId: run.id }
      })
    },

    enqueueRun(input) {
      return roomDb.withTransaction(() => enqueueRunInternal(input))
    },

    listRuns(taskId) {
      return database.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY queued_at ASC, rowid ASC')
        .all(taskId).map(runView)
    },

    getLane({ taskId, roleId, kind = 'executor' }) {
      const row = database.prepare(`
        SELECT * FROM task_lanes WHERE task_id = ? AND role_id = ? AND kind = ?
      `).get(taskId, roleId, kind)
      return laneView(row)
    },

    getTask,

    async pump({ roomId }) {
      if (typeof startRun !== 'function') throw new Error('ROOM_TASK_RUNTIME_REQUIRED')
      const candidates = database.prepare(`
        SELECT r.*, t.chat_id, t.status AS task_status, t.title, t.description, t.acceptance,
               t.number, t.assignee_role_id, l.kind AS lane_kind
        FROM task_runs r
        JOIN tasks t ON t.id = r.task_id
        JOIN chats c ON c.id = t.chat_id
        JOIN task_lanes l ON l.id = r.lane_id
        WHERE c.room_id = ? AND r.status = 'queued' AND l.active = 1
          AND t.status NOT IN ('done', 'cancelled')
        ORDER BY r.queued_at ASC, r.rowid ASC
      `).all(roomId)
      const started = []
      for (const candidate of candidates) {
        const laneBusy = database.prepare(`
          SELECT 1 AS busy FROM task_runs WHERE lane_id = ? AND status IN ('starting', 'running') LIMIT 1
        `).get(candidate.lane_id)
        if (laneBusy) continue
        const writeScopes = parseJson(candidate.write_scopes_json, [])
        if (writeScopes.length > 0) {
          const writeBusy = database.prepare(`
            SELECT 1 AS busy FROM task_runs r
            JOIN tasks t ON t.id = r.task_id
            JOIN chats c ON c.id = t.chat_id
            JOIN task_lanes l ON l.id = r.lane_id
            WHERE c.room_id = ? AND r.write_scopes_json != '[]'
              AND (r.status IN ('starting', 'running')
                OR (l.active = 0 AND r.status = 'interrupted'))
            LIMIT 1
          `).get(roomId)
          if (writeBusy) continue
        }
        const effect = outbox.findByIdempotencyKey(`start_run:${candidate.id}`)
        if (!effect) continue
        const claimed = outbox.claim(effect.id)
        if (!claimed) continue
        database.prepare("UPDATE task_runs SET status = 'starting', started_at = ? WHERE id = ?")
          .run(at(), candidate.id)
        // A mention-lane comment must not reopen a task that is already
        // in_review/blocked; only an executor run moves it to in_progress.
        if (candidate.lane_kind === 'executor') {
          database.prepare(`
            UPDATE tasks SET status = 'in_progress', updated_at = ?
            WHERE id = ? AND status IN ('todo', 'backlog', 'in_review', 'blocked')
          `).run(at(), candidate.task_id)
        }
        const run = runView(database.prepare('SELECT * FROM task_runs WHERE id = ?').get(candidate.id))
        try {
          await startRun(run, {
            id: candidate.task_id,
            chatId: candidate.chat_id,
            number: candidate.number,
            title: candidate.title,
            description: candidate.description,
            acceptance: candidate.acceptance,
            assigneeRoleId: candidate.assignee_role_id,
            laneKind: candidate.lane_kind,
          })
          // A very fast run may have settled before startRun resolves; never
          // overwrite a completed/interrupted run with "running".
          database.prepare("UPDATE task_runs SET status = 'running' WHERE id = ? AND status = 'starting'").run(run.id)
          outbox.succeed(effect.id)
          started.push(runView(database.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id)))
        } catch (error) {
          const message = error?.message ?? String(error)
          database.prepare("UPDATE task_runs SET status = 'failed', ended_at = ?, reason = ? WHERE id = ?")
            .run(at(), message, run.id)
          database.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?")
            .run(at(), candidate.task_id)
          outbox.fail(effect.id, error)
        }
      }
      return started
    },
  }

  return queue
}

module.exports = { createTaskQueue }
