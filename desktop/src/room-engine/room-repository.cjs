const crypto = require('node:crypto')

const { encode } = require('./room-db.cjs')
const { normalizeSkillHint } = require('../workspace/local-workspace-message-records.cjs')

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

function normalizeSkillBindings(value) {
  if (!Array.isArray(value) || value.length > 4) throw new TypeError('ROOM_SKILL_BINDINGS_INVALID')
  const normalized = value.map(normalizeSkillHint)
  if (normalized.some(skill => !skill || !skill.snapshotRef)) throw new TypeError('ROOM_SKILL_BINDINGS_MUST_BE_SNAPSHOTS')
  const keys = normalized.map(skill => `${skill.targetKind}:${skill.namespace}:${skill.slug}`)
  if (new Set(keys).size !== keys.length) throw new TypeError('ROOM_SKILL_BINDINGS_DUPLICATE')
  return normalized
}

function publicSkillBindings(value) {
  return normalizeSkillBindings(value).map(({ targetKind, namespace, slug, name, snapshotId, manifestHash }) => ({
    targetKind, namespace, slug, name, snapshotId, manifestHash,
  }))
}

const REPORT_KINDS = new Set(['progress', 'ready', 'waiting', 'blocked', 'failed', 'handoff'])

function createRoomRepository(roomDb) {
  const db = roomDb.database
  return {
    listRooms() {
      return db.prepare('SELECT id, name, workspace, primary_chat_id, updated_at FROM rooms ORDER BY updated_at DESC, id').all().map(plain)
    },
    createRoom({ roomId = id('room'), name, workspace, providers = [], allowedCapabilities = [] }) {
      const timestamp = now()
      db.prepare(`INSERT INTO rooms
        (id, name, workspace, providers_json, allowed_capabilities_json, write_authorized_root, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(roomId, name, workspace, encode(providers), encode(allowedCapabilities), null, timestamp, timestamp)
      return roomId
    },
    createChat({ chatId = id('chat'), roomId, title, isPrimary = false, engineVersion = 'v2', contextRevision = 0, skillBindings = null }) {
      const timestamp = now()
      db.prepare(`INSERT INTO chats
        (id, room_id, title, status, is_primary, engine_version, context_revision, skill_bindings_json, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
        .run(chatId, roomId, title, isPrimary ? 1 : 0, engineVersion, contextRevision,
          skillBindings === null ? null : encode(normalizeSkillBindings(skillBindings)), timestamp, timestamp)
      if (isPrimary) db.prepare('UPDATE rooms SET primary_chat_id = ?, updated_at = ? WHERE id = ?').run(chatId, timestamp, roomId)
      return chatId
    },
    getChat(chatId) {
      return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId)
    },
    getChatContext(chatId, revision = null) {
      const chat = db.prepare('SELECT id, room_id, context_revision, status FROM chats WHERE id = ?').get(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const targetRevision = revision === null ? chat.context_revision : revision
      const context = db.prepare(`SELECT * FROM chat_context_revisions WHERE chat_id = ? AND revision = ?`).get(chatId, targetRevision)
      return { chat, revision: targetRevision, context: context ? { ...context, changes: decode(context.changes_json) } : null }
    },
    createChatContextRevision({ chatId, instructions = '', changes = {}, createdBy }) {
      const chat = db.prepare('SELECT context_revision FROM chats WHERE id = ?').get(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const revision = chat.context_revision + 1
      const timestamp = now()
      const revisionId = id('context')
      db.prepare(`INSERT INTO chat_context_revisions
        (id, chat_id, revision, instructions, changes_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(revisionId, chatId, revision, instructions, encode(changes), createdBy, timestamp)
      db.prepare('UPDATE chats SET context_revision = ?, updated_at = ? WHERE id = ?').run(revision, timestamp, chatId)
      return { revisionId, chatId, revision }
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
    createAgentRole({ roleId = id('role'), chatId, displayName, responsibilities = '', capabilities = [], provider, promptRevision = 0, createdBy, creationReason = null, status = 'active', skillBindings = null }) {
      const timestamp = now()
      db.prepare(`INSERT INTO agent_roles
        (id, chat_id, display_name, responsibilities, capabilities_json, provider, prompt_revision, skill_bindings_json,
         created_by, creation_reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        roleId, chatId, displayName, responsibilities, encode(capabilities), provider, promptRevision,
        skillBindings === null ? null : encode(normalizeSkillBindings(skillBindings)),
        createdBy, creationReason, status, timestamp, timestamp,
      )
      return roleId
    },
    createRolePromptRevision({ roleId, prompt, createdBy }) {
      const role = db.prepare('SELECT prompt_revision FROM agent_roles WHERE id = ?').get(roleId)
      if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
      const revision = role.prompt_revision + 1
      const revisionId = id('role-prompt')
      const timestamp = now()
      db.prepare(`INSERT INTO role_prompt_revisions (id, role_id, revision, prompt, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(revisionId, roleId, revision, prompt, createdBy, timestamp)
      db.prepare('UPDATE agent_roles SET prompt_revision = ?, updated_at = ? WHERE id = ?').run(revision, timestamp, roleId)
      return { revisionId, roleId, revision }
    },
    getRolePrompt(roleId, revision = null) {
      const role = db.prepare('SELECT prompt_revision FROM agent_roles WHERE id = ?').get(roleId)
      if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
      const targetRevision = revision === null ? role.prompt_revision : revision
      const row = db.prepare('SELECT * FROM role_prompt_revisions WHERE role_id = ? AND revision = ?').get(roleId, targetRevision)
      return row ? { ...row } : null
    },
    listAgentRoles(chatId, { includeArchived = false } = {}) {
      const rows = includeArchived
        ? db.prepare('SELECT * FROM agent_roles WHERE chat_id = ? ORDER BY created_at, id').all(chatId)
        : db.prepare("SELECT * FROM agent_roles WHERE chat_id = ? AND status != 'archived' ORDER BY created_at, id").all(chatId)
      return rows.map(row => ({ ...row, capabilities: decode(row.capabilities_json) }))
    },
    createAssignment({ assignmentId = id('assignment'), taskId, roleId, nativeSessionId = null, runId = null, workspaceRef = null, writeScopes = [], required = true, attempt = 1, previousAssignmentId = null, status = 'queued', skillHints = undefined }) {
      const role = db.prepare('SELECT prompt_revision, skill_bindings_json FROM agent_roles WHERE id = ?').get(roleId)
      if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
      const task = db.prepare('SELECT chat_id FROM tasks WHERE id = ?').get(taskId)
      if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
      const chat = db.prepare('SELECT skill_bindings_json FROM chats WHERE id = ?').get(task.chat_id)
      const source = skillHints === undefined
        ? (role.skill_bindings_json !== null ? JSON.parse(role.skill_bindings_json) : (chat?.skill_bindings_json ? JSON.parse(chat.skill_bindings_json) : []))
        : skillHints
      const frozenSkills = normalizeSkillBindings(source)
      const timestamp = now()
      db.prepare(`INSERT INTO assignments
        (id, task_id, role_id, native_session_id, run_id, workspace_ref, write_scopes_json,
         required, attempt, previous_assignment_id, role_prompt_revision, skill_hints_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        assignmentId, taskId, roleId, nativeSessionId, runId, workspaceRef, encode(writeScopes),
        required ? 1 : 0, attempt, previousAssignmentId, role.prompt_revision, encode(frozenSkills), status, timestamp, timestamp,
      )
      return assignmentId
    },
    setChatSkillBindings({ chatId, skillBindings }) {
      const normalized = normalizeSkillBindings(skillBindings)
      const result = db.prepare('UPDATE chats SET skill_bindings_json = ?, updated_at = ? WHERE id = ?').run(encode(normalized), now(), chatId)
      if (result.changes !== 1) throw new Error('ROOM_CHAT_NOT_FOUND')
      return normalized
    },
    setRoleSkillBindings({ roleId, skillBindings }) {
      const normalized = skillBindings === null ? null : normalizeSkillBindings(skillBindings)
      const result = db.prepare('UPDATE agent_roles SET skill_bindings_json = ?, updated_at = ? WHERE id = ?').run(normalized === null ? null : encode(normalized), now(), roleId)
      if (result.changes !== 1) throw new Error('ROOM_ROLE_NOT_FOUND')
      return normalized
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
    getAssignmentLatestReport(assignmentId) {
      return decodeRow(db.prepare('SELECT * FROM reports WHERE assignment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(assignmentId), ['evidence_json', 'artifact_ids_json', 'next_request_json'])
    },
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
    listMessagesPage(chatId, { beforeSequence = null, limit = 100 } = {}) {
      const bounded = Math.max(1, Math.min(200, Number(limit) || 100))
      const rows = beforeSequence === null
        ? db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY sequence DESC LIMIT ?').all(chatId, bounded + 1)
        : db.prepare('SELECT * FROM messages WHERE chat_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(chatId, beforeSequence, bounded + 1)
      const hasMore = rows.length > bounded
      const page = rows.slice(0, bounded).reverse()
      return { messages: page.map(row => decodeRow(row, ['mentions_json', 'attachment_ids_json'])), hasMore,
        nextBeforeSequence: page.length ? page[0].sequence : null }
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
    getAssignmentByRunId(runId) {
      return db.prepare(`SELECT a.*, t.chat_id, t.objective, t.context_revision, c.room_id,
        room.workspace, r.display_name, r.provider, r.status AS role_status
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN chats c ON c.id = t.chat_id
        JOIN rooms room ON room.id = c.room_id
        JOIN agent_roles r ON r.id = a.role_id
        WHERE a.run_id = ? ORDER BY a.updated_at DESC LIMIT 1`).get(runId)
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
    getRoomSnapshot(roomId, { messageLimit = null } = {}) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
      if (!room) throw new Error('ROOM_NOT_FOUND')
      const chats = db.prepare('SELECT * FROM chats WHERE room_id = ? ORDER BY created_at, id').all(roomId)
        .map(row => {
          const context = db.prepare(`SELECT revision, instructions, changes_json, created_by, created_at
            FROM chat_context_revisions WHERE chat_id = ? AND revision = ?`).get(row.id, row.context_revision)
          const chat = decodeRow(row, ['skill_bindings_json'])
          chat.skill_bindings_json = publicSkillBindings(chat.skill_bindings_json || [])
          return { ...chat, current_context: context ? {
            revision: context.revision,
            instructions: context.instructions,
            changes: decode(context.changes_json),
            created_by: context.created_by,
            created_at: context.created_at,
          } : null }
        })
      const chatIds = chats.map(chat => chat.id)
      const messagePages = messageLimit === null
        ? null
        : Object.fromEntries(chatIds.map(chatId => [chatId, this.listMessagesPage(chatId, { limit: messageLimit || 100 })]))
      const messages = messagePages
        ? Object.values(messagePages).flatMap(page => page.messages)
        : chatIds.length
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
        messages_have_older: messagePages ? Object.keys(messagePages).filter(chatId => messagePages[chatId].hasMore) : [],
        messages: messagePages ? messages : messages.map(row => decodeRow(row, ['mentions_json', 'attachment_ids_json'])),
        tasks: tasks.map(row => decodeRow(row, ['source_message_ids_json', 'blocked_by_task_ids_json', 'required_artifact_ids_json', 'inputs_json'])),
        assignments: assignments.map(row => {
          const assignment = decodeRow(row, ['write_scopes_json', 'skill_hints_json'])
          assignment.skill_hints_json = publicSkillBindings(assignment.skill_hints_json || [])
          return assignment
        }),
        attentions: attentions.map(row => decodeRow(row, ['options_json'])),
        roles: chatIds.length ? db.prepare(`SELECT r.*, p.prompt AS current_prompt
          FROM agent_roles r
          LEFT JOIN role_prompt_revisions p ON p.role_id = r.id AND p.revision = r.prompt_revision
          WHERE r.chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY r.created_at, r.id`).all(...chatIds)
          .map(row => {
            const role = decodeRow(row, ['capabilities_json', 'skill_bindings_json'])
            role.skill_bindings_json = role.skill_bindings_json === null ? null : publicSkillBindings(role.skill_bindings_json)
            return role
          }) : [],
        reports: taskIds.length ? db.prepare(`SELECT * FROM reports WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...taskIds)
          .map(row => decodeRow(row, ['evidence_json', 'artifact_ids_json', 'next_request_json'])) : [],
        artifacts: db.prepare('SELECT * FROM artifacts WHERE room_id=? ORDER BY created_at, id').all(roomId).map(plain),
      }
    },
  }
}

module.exports = { createRoomRepository }
