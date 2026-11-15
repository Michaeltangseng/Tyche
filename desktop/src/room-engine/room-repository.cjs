const crypto = require('node:crypto')

const { encode } = require('./room-db.cjs')

function now() { return new Date().toISOString() }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}` }

function plain(row) { return row ? { ...row } : row }
function decode(value, fallback = null) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value) } catch { return fallback }
}

function decodeRow(row, fields) {
  if (!row) return row
  const result = { ...row }
  for (const field of fields) result[field] = decode(result[field], [])
  return result
}

const REPORT_KINDS = new Set(['progress', 'ready', 'waiting', 'blocked', 'failed', 'handoff'])

function createRoomRepository(roomDb) {
  const db = roomDb.database
  return {
    createRoom({ roomId = id('room'), name, workspace, providers = [], allowedCapabilities = [] }) {
      const timestamp = now()
      db.prepare(`INSERT INTO rooms
        (id, name, workspace, providers_json, allowed_capabilities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(roomId, name, workspace, encode(providers), encode(allowedCapabilities), timestamp, timestamp)
      return roomId
    },
    createChat({ chatId = id('chat'), roomId, title, isPrimary = false, engineVersion = 'v2', contextRevision = 0 }) {
      const timestamp = now()
      db.prepare(`INSERT INTO chats
        (id, room_id, title, status, is_primary, engine_version, context_revision, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(chatId, roomId, title, isPrimary ? 1 : 0, engineVersion, contextRevision, timestamp, timestamp)
      if (isPrimary) db.prepare('UPDATE rooms SET primary_chat_id = ?, updated_at = ? WHERE id = ?').run(chatId, timestamp, roomId)
      return chatId
    },
    appendMessage({ messageId = id('msg'), chatId, authorType, authorId, content, mentions = [], attachmentIds = [], replyTo = null, taskId = null }) {
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE chat_id = ?').get(chatId).next
      const timestamp = now()
      db.prepare(`INSERT INTO messages
        (id, chat_id, sequence, author_type, author_id, content, mentions_json, attachment_ids_json, reply_to, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, chatId, sequence, authorType, authorId, content, encode(mentions), encode(attachmentIds), replyTo, taskId, timestamp)
      return { messageId, sequence, createdAt: timestamp }
    },
    getMessage(messageId) {
      return plain(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId))
    },
    editMessage({ messageId, content, mentions = [], attachmentIds = [] }) {
      const timestamp = now()
      const result = db.prepare(`UPDATE messages
        SET content = ?, mentions_json = ?, attachment_ids_json = ?, edited_at = ?
        WHERE id = ? AND deleted_at IS NULL`).run(content, encode(mentions), encode(attachmentIds), timestamp, messageId)
      if (result.changes !== 1) throw new Error('ROOM_MESSAGE_NOT_EDITABLE')
      return { messageId, editedAt: timestamp }
    },
    deleteMessage({ messageId }) {
      const timestamp = now()
      const result = db.prepare(`UPDATE messages SET deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL`).run(timestamp, messageId)
      if (result.changes !== 1) throw new Error('ROOM_MESSAGE_NOT_DELETABLE')
      return { messageId, deletedAt: timestamp }
    },
    appendEvent({ eventId = id('event'), roomId, chatId = null, actorId, type, reportId = null, actionId = null, payload = {} }) {
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE room_id = ?').get(roomId).next
      const timestamp = now()
      db.prepare(`INSERT INTO events
        (id, room_id, chat_id, sequence, actor_id, type, report_id, action_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        eventId, roomId, chatId, sequence, actorId, type, reportId, actionId, encode(payload), timestamp,
      )
      return { eventId, sequence, createdAt: timestamp }
    },
    listEvents(roomId, { chatId = null } = {}) {
      const rows = chatId === null
        ? db.prepare('SELECT * FROM events WHERE room_id = ? ORDER BY sequence').all(roomId)
        : db.prepare('SELECT * FROM events WHERE room_id = ? AND chat_id = ? ORDER BY sequence').all(roomId, chatId)
      return rows.map(plain)
    },
    createTask({ taskId = id('task'), chatId, objective, kind = 'general', createdBy, sourceMessageIds = [], blockedByTaskIds = [], requiredArtifactIds = [], optional = false, parentTaskId = null, contextRevision = 0, inputs = [] }) {
      const timestamp = now()
      db.prepare(`INSERT INTO tasks
        (id, chat_id, objective, kind, status, created_by, source_message_ids_json, parent_task_id,
         blocked_by_task_ids_json, required_artifact_ids_json, optional, context_revision, inputs_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, chatId, objective, kind, createdBy, encode(sourceMessageIds), parentTaskId, encode(blockedByTaskIds), encode(requiredArtifactIds), optional ? 1 : 0, contextRevision, encode(inputs), timestamp, timestamp)
      return taskId
    },
    createAgentRole({ roleId = id('role'), chatId, displayName, responsibilities = '', capabilities = [], provider, promptRevision = 0, createdBy, creationReason = null, status = 'active' }) {
      const timestamp = now()
      db.prepare(`INSERT INTO agent_roles
        (id, chat_id, display_name, responsibilities, capabilities_json, provider, prompt_revision,
         created_by, creation_reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        roleId, chatId, displayName, responsibilities, encode(capabilities), provider, promptRevision,
        createdBy, creationReason, status, timestamp, timestamp,
      )
      return roleId
    },
    createAssignment({ assignmentId = id('assignment'), taskId, roleId, nativeSessionId = null, runId = null, workspaceRef = null, writeScopes = [], required = true, attempt = 1, previousAssignmentId = null, status = 'queued' }) {
      const timestamp = now()
      db.prepare(`INSERT INTO assignments
        (id, task_id, role_id, native_session_id, run_id, workspace_ref, write_scopes_json,
         required, attempt, previous_assignment_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        assignmentId, taskId, roleId, nativeSessionId, runId, workspaceRef, encode(writeScopes),
        required ? 1 : 0, attempt, previousAssignmentId, status, timestamp, timestamp,
      )
      return assignmentId
    },
    createReport({ reportId = id('report'), taskId, assignmentId, kind, summary, evidence = [], artifactIds = [], nextRequest = null, attentionId = null }) {
      if (!REPORT_KINDS.has(kind)) throw new TypeError('ROOM_REPORT_KIND_INVALID')
      const timestamp = now()
      db.prepare(`INSERT INTO reports
        (id, task_id, assignment_id, kind, summary, evidence_json, artifact_ids_json, next_request_json, attention_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        reportId, taskId, assignmentId, kind, summary, encode(evidence), encode(artifactIds), encode(nextRequest), attentionId, timestamp,
      )
      db.prepare('UPDATE tasks SET latest_report_id = ?, updated_at = ? WHERE id = ?').run(reportId, timestamp, taskId)
      return reportId
    },
    createArtifact({ artifactId = id('artifact'), roomId, sourceTaskId = null, sourceAssignmentId = null, path: artifactPath, kind, version, status = 'published', supersedesArtifactId = null }) {
      const timestamp = now()
      db.prepare(`INSERT INTO artifacts
        (id, room_id, source_task_id, source_assignment_id, path, kind, version, status, supersedes_artifact_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        artifactId, roomId, sourceTaskId, sourceAssignmentId, artifactPath, kind, version, status, supersedesArtifactId, timestamp, timestamp,
      )
      return artifactId
    },
    createAttention({ attentionId = id('attention'), chatId, taskId = null, type, question, options = [], requestedBy, status = 'open' }) {
      const timestamp = now()
      db.prepare(`INSERT INTO attentions
        (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        attentionId, chatId, taskId, type, question, encode(options), status, requestedBy, timestamp,
      )
      return attentionId
    },
    getReport(reportId) { return plain(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)) },
    listAssignments(taskId) { return db.prepare('SELECT * FROM assignments WHERE task_id = ? ORDER BY created_at, id').all(taskId).map(plain) },
    createEffect({ effectId = id('effect'), chatId, actionId = null, kind, payload = {}, idempotencyKey }) {
      const timestamp = now()
      db.prepare(`INSERT INTO effects
        (id, chat_id, action_id, kind, status, payload_json, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(effectId, chatId, actionId, kind, encode(payload), idempotencyKey, timestamp)
      return effectId
    },
    getControllerDecision({ chatId, batchId }) {
      return plain(db.prepare('SELECT * FROM controller_decisions WHERE chat_id = ? AND batch_id = ?').get(chatId, batchId))
    },
    createControllerDecision({ decisionId = id('decision'), chatId, batchId, contextRevision, inputIds = [], actionIds = [], results = [], model = null, latencyMs = null, cost = null }) {
      const timestamp = now()
      db.prepare(`INSERT INTO controller_decisions
        (id, chat_id, batch_id, context_revision, input_ids_json, action_ids_json, results_json, model, latency_ms, cost, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        decisionId, chatId, batchId, contextRevision, encode(inputIds), encode(actionIds), encode(results), model, latencyMs, cost, timestamp,
      )
      return decisionId
    },
    listMessages(chatId) {
      return db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY sequence').all(chatId)
    },
    getTask(taskId) { return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) },
    getEffect(effectId) { return db.prepare('SELECT * FROM effects WHERE id = ?').get(effectId) },
    getAssignmentContext(assignmentId) {
      return db.prepare(`SELECT a.*, t.chat_id, t.objective, t.context_revision, c.room_id,
        room.workspace, r.display_name, r.provider, r.status AS role_status
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN chats c ON c.id = t.chat_id
        JOIN rooms room ON room.id = c.room_id
        JOIN agent_roles r ON r.id = a.role_id
        WHERE a.id = ?`).get(assignmentId)
    },
    markAssignmentStarted({ assignmentId, runId, nativeSessionId }) {
      const timestamp = now()
      const result = db.prepare(`UPDATE assignments
        SET run_id = ?, native_session_id = ?, status = 'running', updated_at = ?
        WHERE id = ? AND status = 'queued'`).run(runId, nativeSessionId, timestamp, assignmentId)
      if (result.changes !== 1) throw new Error('ROOM_ASSIGNMENT_NOT_QUEUED')
      return { assignmentId, runId, nativeSessionId, startedAt: timestamp }
    },
    markAssignmentExited({ assignmentId, status, endedReason = null, outcome = null }) {
      const timestamp = now()
      const result = db.prepare(`UPDATE assignments
        SET status = ?, ended_reason = ?, outcome = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`).run(status, endedReason, outcome, timestamp, assignmentId)
      if (result.changes !== 1) throw new Error('ROOM_ASSIGNMENT_NOT_RUNNING')
      return { assignmentId, status, endedAt: timestamp }
    },
    getRoomSnapshot(roomId) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
      if (!room) throw new Error('ROOM_NOT_FOUND')
      const chats = db.prepare('SELECT * FROM chats WHERE room_id = ? ORDER BY created_at, id').all(roomId)
        .map(row => row)
      const chatIds = chats.map(chat => chat.id)
      const messages = chatIds.length
        ? db.prepare(`SELECT * FROM messages WHERE chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY chat_id, sequence`).all(...chatIds)
        : []
      const tasks = chatIds.length
        ? db.prepare(`SELECT * FROM tasks WHERE chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...chatIds)
        : []
      const taskIds = tasks.map(task => task.id)
      const assignments = taskIds.length
        ? db.prepare(`SELECT * FROM assignments WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...taskIds)
        : []
      const attentions = chatIds.length
        ? db.prepare(`SELECT * FROM attentions WHERE chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...chatIds)
        : []
      return {
        room: decodeRow(room, ['providers_json', 'allowed_capabilities_json']),
        chats,
        messages: messages.map(row => decodeRow(row, ['mentions_json', 'attachment_ids_json'])),
        tasks: tasks.map(row => decodeRow(row, ['source_message_ids_json', 'blocked_by_task_ids_json', 'required_artifact_ids_json', 'inputs_json'])),
        assignments: assignments.map(row => decodeRow(row, ['write_scopes_json'])),
        attentions: attentions.map(row => decodeRow(row, ['options_json'])),
      }
    },
  }
}

module.exports = { createRoomRepository }
