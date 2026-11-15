function assertId(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(code)
}

function createSessionSupervisor({ roomDb, repository, now = () => new Date() }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) {
    throw new TypeError('ROOM_SESSION_SUPERVISOR_DEPENDENCIES_REQUIRED')
  }

  function assignmentContext(assignmentId, chatId) {
    assertId(assignmentId, 'ROOM_ASSIGNMENT_ID_INVALID')
    const row = roomDb.database.prepare(`
      SELECT a.id AS assignment_id, a.task_id, t.chat_id, c.room_id
      FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN chats c ON c.id = t.chat_id
      WHERE a.id = ?`).get(assignmentId)
    if (!row || (chatId && row.chat_id !== chatId)) throw new Error('ROOM_ASSIGNMENT_NOT_FOUND')
    return row
  }

  function append({ assignmentId, chatId, actorId = 'supervisor', type, payload }) {
    const context = assignmentContext(assignmentId, chatId)
    const observedAt = payload.observedAt || now().toISOString()
    return roomDb.withTransaction(() => repository.appendEvent({
      roomId: context.room_id,
      chatId: context.chat_id,
      actorId,
      type,
      payload: { ...payload, assignmentId, taskId: context.task_id, observedAt },
    }))
  }

  function started(input) {
    assertId(input.runId, 'ROOM_RUN_ID_INVALID')
    return append({ ...input, type: 'session_started', payload: { runId: input.runId, state: 'running', observedAt: input.observedAt } })
  }

  function liveness(input) {
    if (!['running', 'idle', 'stopping'].includes(input.state)) throw new TypeError('ROOM_SESSION_STATE_INVALID')
    return append({ ...input, type: 'session_liveness', payload: { state: input.state, observedAt: input.observedAt } })
  }

  function exited(input) {
    assertId(input.runId, 'ROOM_RUN_ID_INVALID')
    return append({ ...input, type: 'session_exited', payload: { runId: input.runId, exitCode: input.exitCode ?? null, reason: input.reason ?? null, observedAt: input.observedAt } })
  }

  function listStale({ roomId, timeoutMs, at = now() }) {
    assertId(roomId, 'ROOM_ID_INVALID')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('ROOM_SESSION_TIMEOUT_INVALID')
    const rows = roomDb.database.prepare(`SELECT id, chat_id, sequence, payload_json, created_at FROM events
      WHERE room_id = ? AND type = 'session_liveness' ORDER BY sequence`).all(roomId)
    const latest = new Map()
    for (const row of rows) {
      let payload
      try { payload = JSON.parse(row.payload_json) } catch { continue }
      const previous = latest.get(payload.assignmentId)
      if (!previous || row.sequence > previous.sequence) latest.set(payload.assignmentId, { ...payload, sequence: row.sequence, createdAt: row.created_at, chatId: row.chat_id })
    }
    const cutoff = at.getTime() - timeoutMs
    return [...latest.values()].filter((entry) => entry.state === 'running' && Date.parse(entry.observedAt) < cutoff)
  }

  return { started, liveness, exited, listStale }
}

module.exports = { createSessionSupervisor }
