const crypto = require('node:crypto')

function createSessionStore({ roomDb, repository, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function participantRow(chatId, roleId) {
    return database.prepare('SELECT * FROM chat_participants WHERE chat_id = ? AND role_id = ?').get(chatId, roleId)
  }

  function laneRow(taskId, roleId, kind) {
    return database.prepare('SELECT * FROM task_lanes WHERE task_id = ? AND role_id = ? AND kind = ?')
      .get(taskId, roleId, kind)
  }

  function sameConfiguration(row, input, skillBindingsJson) {
    return row.provider === input.provider
      && row.prompt_revision === input.promptRevision
      && row.permission_mode === input.permissionMode
      && row.workspace_ref === input.workspaceRef
      && row.skill_bindings_json === skillBindingsJson
      && (row.model ?? null) === (input.model ?? null)
      && (row.thinking_level ?? null) === (input.thinkingLevel ?? null)
  }

  return {
    ensureSession(input) {
      const {
        scopeType, scopeId, roleId, provider, promptRevision, permissionMode,
        workspaceRef, skillBindings = [], model = null, thinkingLevel = null,
        laneKind = 'executor', created = () => {},
      } = input
      if (scopeType !== 'chat' && scopeType !== 'task') throw new Error('ROOM_SESSION_SCOPE_UNSUPPORTED')
      if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('ROOM_SESSION_PROVIDER_REQUIRED')
      if (typeof workspaceRef !== 'string' || workspaceRef.length === 0) throw new TypeError('ROOM_SESSION_WORKSPACE_REQUIRED')
      const scope = scopeType === 'chat'
        ? participantRow(scopeId, roleId)
        : laneRow(scopeId, roleId, laneKind)
      if (!scope) throw new Error(scopeType === 'chat' ? 'ROOM_PARTICIPANT_NOT_FOUND' : 'ROOM_TASK_LANE_NOT_FOUND')
      const skillBindingsJson = JSON.stringify(skillBindings ?? [])
      const active = database.prepare(`
        SELECT * FROM sessions
        WHERE scope_type = ? AND scope_id = ? AND role_id = ? AND state = 'active'
      `).all(scopeType, scopeId, roleId)
      const match = active.find(row => sameConfiguration(row, input, skillBindingsJson))
      if (match) return { sessionId: match.id, reused: true, baselineSeq: match.baseline_seq }

      const sessionId = crypto.randomUUID()
      const createdAt = at()
      const baselineSeq = scope.last_seq
      roomDb.withTransaction(() => {
        database.prepare(`
          UPDATE sessions SET state = 'rotated', rotated_at = ?, rotate_reason = 'configuration-changed'
          WHERE scope_type = ? AND scope_id = ? AND role_id = ? AND state = 'active'
        `).run(createdAt, scopeType, scopeId, roleId)
        database.prepare(`
          INSERT INTO sessions
            (id, scope_type, scope_id, role_id, provider, baseline_seq, prompt_revision, permission_mode,
             workspace_ref, skill_bindings_json, model, thinking_level, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `).run(
          sessionId, scopeType, scopeId, roleId, provider, baselineSeq, promptRevision, permissionMode,
          workspaceRef, skillBindingsJson, model ?? null, thinkingLevel ?? null, createdAt,
        )
        if (scopeType === 'chat') {
          database.prepare('UPDATE chat_participants SET session_id = ? WHERE chat_id = ? AND role_id = ?')
            .run(sessionId, scopeId, roleId)
        } else {
          database.prepare(`
            UPDATE task_lanes SET session_id = ? WHERE task_id = ? AND role_id = ? AND kind = ?
          `).run(sessionId, scopeId, roleId, laneKind)
        }
      })
      created(sessionId)
      return { sessionId, reused: false, baselineSeq }
    },

    saveNativeRef({ sessionId, nativeSessionRef }) {
      const result = database.prepare('UPDATE sessions SET native_session_ref = ? WHERE id = ?')
        .run(nativeSessionRef ?? null, sessionId)
      if (result.changes === 0) throw new Error('ROOM_SESSION_NOT_FOUND')
    },

    rotateSession({ sessionId, reason = null }) {
      roomDb.withTransaction(() => {
        const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
        if (!row) throw new Error('ROOM_SESSION_NOT_FOUND')
        if (row.state !== 'active') return
        database.prepare("UPDATE sessions SET state = 'rotated', rotated_at = ?, rotate_reason = ? WHERE id = ?")
          .run(at(), reason, sessionId)
        if (row.scope_type === 'chat') {
          database.prepare('UPDATE chat_participants SET session_id = NULL WHERE chat_id = ? AND role_id = ? AND session_id = ?')
            .run(row.scope_id, row.role_id, sessionId)
        } else if (row.scope_type === 'task') {
          database.prepare('UPDATE task_lanes SET session_id = NULL WHERE task_id = ? AND role_id = ? AND session_id = ?')
            .run(row.scope_id, row.role_id, sessionId)
        }
      })
    },

    getParticipantLastSeq({ chatId, roleId }) {
      const row = participantRow(chatId, roleId)
      if (!row) throw new Error('ROOM_PARTICIPANT_NOT_FOUND')
      return row.last_seq
    },

    setParticipantLastSeq({ chatId, roleId, seq }) {
      const result = database.prepare(`
        UPDATE chat_participants SET last_seq = MAX(last_seq, ?) WHERE chat_id = ? AND role_id = ?
      `).run(seq, chatId, roleId)
      if (result.changes === 0) throw new Error('ROOM_PARTICIPANT_NOT_FOUND')
    },

    getLaneLastSeq({ taskId, roleId, kind = 'executor' }) {
      const row = laneRow(taskId, roleId, kind)
      if (!row) throw new Error('ROOM_TASK_LANE_NOT_FOUND')
      return row.last_seq
    },

    setLaneLastSeq({ taskId, roleId, kind = 'executor', seq }) {
      const result = database.prepare(`
        UPDATE task_lanes SET last_seq = MAX(last_seq, ?) WHERE task_id = ? AND role_id = ? AND kind = ?
      `).run(seq, taskId, roleId, kind)
      if (result.changes === 0) throw new Error('ROOM_TASK_LANE_NOT_FOUND')
    },
  }
}

module.exports = { createSessionStore }
