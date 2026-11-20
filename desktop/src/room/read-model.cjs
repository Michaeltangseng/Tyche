/**
 * Display-safe read model for the new room domain.
 *
 * The renderer receives no absolute workspace paths, session ids, native
 * session refs, process ids or raw tool activity. Message data is reduced to
 * an allowlist of display flags; trace details belong to a separately
 * authorized trace endpoint.
 *
 * Field names are snake_case so the room UI consumes the domain ledger
 * directly.
 */
const path = require('node:path')
const { safeUsage } = require('./runtime-event-view.cjs')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function boundedLimit(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(max, Math.floor(number))
}

function workspaceLabel(room) {
  return room?.workspace ? (path.basename(room.workspace) || 'workspace') : 'workspace'
}

/** Keep workspace paths out of display text even when an Agent quotes them. */
function scrubWorkspace(value, room) {
  if (typeof value !== 'string' || !room?.workspace) return value
  return value.split(room.workspace).join(workspaceLabel(room))
}

function scrubEvidence(values, room) {
  return Array.isArray(values)
    ? values.map(value => scrubWorkspace(value, room))
    : []
}

function roomView(row, chats) {
  return {
    id: row.id,
    name: row.name,
    workspace_label: path.basename(row.workspace),
    write_authorized: typeof row.write_authorized_root === 'string' && row.write_authorized_root.length > 0,
    providers: parseJson(row.providers_json, []),
    allowed_capabilities: parseJson(row.allowed_capabilities_json, []),
    primary_chat_id: chats[0]?.id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function chatView(row) {
  return {
    id: row.id,
    room_id: row.room_id,
    title: row.title,
    status: row.status,
    last_seq: row.last_seq,
    activity_seq: row.activity_seq,
    captain_reviewed_seq: row.captain_reviewed_seq,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function roleView(row, prompt) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    display_name: row.display_name,
    responsibilities: row.responsibilities,
    provider: row.provider,
    model: row.model,
    capabilities: parseJson(row.capabilities_json, []),
    native_permission: row.native_permission,
    is_captain: row.is_captain === 1,
    status: row.status,
    prompt: prompt?.prompt ?? '',
    prompt_revision: prompt?.revision ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function safeTrace(steps, room) {
  if (!Array.isArray(steps)) return null
  const safe = []
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue
    const name = scrubWorkspace(typeof step.name === 'string' ? step.name.slice(0, 120) : '', room)
    if (!name) continue
    const item = {
      callId: typeof step.callId === 'string' && step.callId ? step.callId.slice(0, 160) : name,
      name,
      input: scrubWorkspace(typeof step.input === 'string' ? step.input.slice(0, 4096) : '', room),
      output: scrubWorkspace(typeof step.output === 'string' ? step.output.slice(0, 2000) : '', room),
      status: step.status === 'failed' || step.status === 'running' ? step.status : 'completed',
    }
    if (Number.isInteger(step.exitCode)) item.exitCode = step.exitCode
    safe.push(item)
  }
  return safe.length > 0 ? safe : null
}

function safeMessageData(data, room = null) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const safe = {}
  if (data.reviewReply === true) safe.reviewReply = true
  if (Array.isArray(data.reviewIds)) safe.reviewIds = data.reviewIds.filter(id => typeof id === 'string')
  if (Array.isArray(data.roleIds)) {
    safe.roleIds = data.roleIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 120)
  }
  if (Number.isInteger(data.checkpoint)) safe.checkpoint = data.checkpoint
  if (typeof data.reportId === 'string') safe.reportId = data.reportId
  if (typeof data.reportKind === 'string') safe.reportKind = data.reportKind
  if (typeof data.thinking === 'string' && data.thinking.length > 0) {
    safe.thinking = scrubWorkspace(data.thinking, room)
  }
  const usage = safeUsage(data.usage)
  if (usage) safe.usage = usage
  const trace = safeTrace(data.trace, room)
  if (trace) safe.trace = trace
  return Object.keys(safe).length > 0 ? safe : null
}

function messageView(row, roleNames, room) {
  const authorName = row.author_type === 'user'
    ? 'user'
    : row.author_type === 'system'
      ? 'system'
      : roleNames.get(row.author_id) ?? row.author_id
  return {
    id: row.id,
    chat_id: row.chat_id,
    sequence: row.seq,
    client_id: row.client_id ?? null,
    revision: row.revision,
    audience: row.audience,
    author_type: row.author_type,
    author_id: row.author_id,
    author_name: authorName,
    kind: row.kind,
    content: scrubWorkspace(row.content, room),
    mentions: parseJson(row.mentions_json, []),
    reply_to: row.reply_to,
    task_id: row.task_id,
    root_message_id: row.root_message_id,
    captain_assignment_id: row.captain_assignment_id,
    status: row.status,
    data: safeMessageData(parseJson(row.data_json, null), room),
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at ?? null,
  }
}

function taskView(row, roleNames, room = null) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    number: row.number,
    title: scrubWorkspace(row.title, room),
    description: scrubWorkspace(row.description, room),
    acceptance: scrubWorkspace(row.acceptance, room),
    kind: row.kind,
    status: row.status,
    created_by_role_id: row.created_by_role_id,
    assignee_role_id: row.assignee_role_id,
    assignee_name: roleNames.get(row.assignee_role_id) ?? row.assignee_role_id,
    captain_assignment_id: row.captain_assignment_id,
    parent_task_id: row.parent_task_id,
    optional: row.optional === 1,
    required_artifact_ids: parseJson(row.required_artifact_ids_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function runView(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    lane_id: row.lane_id,
    lane_kind: row.lane_kind ?? null,
    role_id: row.role_id,
    status: row.status,
    outcome: row.outcome,
    snapshot_state: row.snapshot_state,
    required: row.required === 1,
    continues_run_id: row.continues_run_id,
    previous_run_id: row.previous_run_id,
    captain_assignment_id: row.captain_assignment_id,
    queued_at: row.queued_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    reason: row.reason,
  }
}

function reportView(row, room = null) {
  return {
    id: row.id,
    task_id: row.task_id,
    run_id: row.run_id,
    lane_id: row.lane_id,
    kind: row.kind,
    summary: scrubWorkspace(row.summary, room),
    evidence: scrubEvidence(parseJson(row.evidence_json, []), room),
    artifact_ids: parseJson(row.artifact_ids_json, []),
    next_request: parseJson(row.next_request_json, null),
    attention_id: row.attention_id,
    created_at: row.created_at,
  }
}

function attentionView(row, room = null) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    task_id: row.task_id,
    type: row.type,
    question: scrubWorkspace(row.question, room),
    options: parseJson(row.options_json, []),
    status: row.status,
    requested_by: row.requested_by,
    answered_by: row.answered_by,
    resolution: parseJson(row.resolution_json, null),
    created_at: row.created_at,
    answered_at: row.answered_at,
  }
}

function reviewView(row) {
  // Review bodies are Captain-only observations and contain internal ids.
  // The UI shows kind/status/timestamps; the Captain reads the body itself.
  return {
    id: row.id,
    chat_id: row.chat_id,
    kind: row.kind,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function artifactView(row) {
  return {
    id: row.id,
    task_id: row.task_id ?? null,
    run_id: row.run_id ?? null,
    path: row.path,
    kind: row.kind,
    version: row.version,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function assignmentView(row) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    message_id: row.message_id,
    root_message_id: row.root_message_id,
    target_role_ids: parseJson(row.target_role_ids_json, []),
    target_reply_ids: parseJson(row.target_reply_ids_json, []),
    status: row.status,
    created_at: row.created_at,
  }
}

function createRoomReadModel({ roomDb } = {}) {
  if (!roomDb) throw new TypeError('ROOM_READ_MODEL_DATABASE_REQUIRED')
  const { database } = roomDb

  function roomRow(roomId) {
    if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('ROOM_READ_MODEL_ROOM_REQUIRED')
    const room = database.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
    if (!room) throw new Error('ROOM_NOT_FOUND')
    return room
  }

  function chatsOf(roomId) {
    return database.prepare(`
      SELECT * FROM chats WHERE room_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(roomId)
  }

  function roleRows(roomId) {
    return database.prepare(`
      SELECT r.* FROM chat_roles r
      JOIN chats c ON c.id = r.chat_id
      WHERE c.room_id = ?
      ORDER BY r.created_at ASC, r.rowid ASC
    `).all(roomId)
  }

  function rolePrompt(roleId) {
    return database.prepare(`
      SELECT revision, prompt FROM role_prompt_revisions
      WHERE role_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1
    `).get(roleId)
  }

  function roleNameMap(roles) {
    return new Map(roles.map(role => [role.id, role.display_name]))
  }

  function messageRows(chatId, { limit, beforeSeq = null, includeCaptain = false } = {}) {
    // Captain review system rows are internal observations, not chat messages.
    const clauses = ["chat_id = ?", "kind != 'captain_review'"]
    const parameters = [chatId]
    if (!includeCaptain) clauses.push("audience = 'chat'")
    if (Number.isInteger(beforeSeq) && beforeSeq > 0) {
      clauses.push('seq < ?')
      parameters.push(beforeSeq)
    }
    const rows = database.prepare(`
      SELECT * FROM messages WHERE ${clauses.join(' AND ')}
      ORDER BY seq DESC LIMIT ?
    `).all(...parameters, limit + 1)
    const hasMore = rows.length > limit
    return { rows: rows.slice(0, limit).reverse(), hasMore }
  }

  function chatMembers(chatId) {
    return database.prepare(`
      SELECT display_name, provider, is_captain
      FROM chat_roles
      WHERE chat_id = ? AND status = 'active'
      ORDER BY is_captain DESC, created_at ASC, rowid ASC
    `).all(chatId).map(role => ({
      name: role.display_name,
      provider: role.provider,
      is_captain: role.is_captain === 1,
    }))
  }

  function chatActivity(chatId, room) {
    const message = database.prepare(`
      SELECT author_type, author_id, content, status, created_at
      FROM messages
      WHERE chat_id = ? AND deleted_at IS NULL AND audience = 'chat' AND kind != 'captain_review'
      ORDER BY seq DESC LIMIT 1
    `).get(chatId)
    if (!message) return null
    const role = message.author_type === 'agent'
      ? database.prepare('SELECT display_name FROM chat_roles WHERE id = ?').get(message.author_id)
      : null
    const text = scrubWorkspace(String(message.content || '').replace(/\s+/g, ' ').trim(), room).slice(0, 80)
    return {
      name: role?.display_name || '',
      status: message.status,
      text,
      created_at: message.created_at,
    }
  }

  function listRooms() {
    return database.prepare('SELECT * FROM rooms ORDER BY created_at ASC, rowid ASC').all().map(row => {
      const chats = chatsOf(row.id)
      return {
        ...roomView(row, chats),
        chat_count: chats.length,
        chats: chats.map(chat => ({
          ...chatView(chat),
          members: chatMembers(chat.id),
          activity: chatActivity(chat.id, row),
        })),
      }
    })
  }

  function snapshot({ roomId, messageLimit = 200, includeCaptain = false } = {}) {
    const room = roomRow(roomId)
    const chats = chatsOf(room.id)
    const roles = roleRows(room.id)
    const roleNames = roleNameMap(roles)
    const limit = boundedLimit(messageLimit, 200, 500)

    const messages = []
    const older = []
    for (const chat of chats) {
      const page = messageRows(chat.id, { limit, includeCaptain })
      messages.push(...page.rows.map(row => messageView(row, roleNames, room)))
      if (page.hasMore) older.push(chat.id)
    }

    const chatIds = chats.map(chat => chat.id)
    const placeholders = chatIds.map(() => '?').join(',')
    const tasks = chatIds.length === 0
      ? []
      : database.prepare(`
          SELECT * FROM tasks WHERE chat_id IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC
        `).all(...chatIds)
    const taskIds = tasks.map(task => task.id)
    const taskPlaceholders = taskIds.map(() => '?').join(',')
    const runs = taskIds.length === 0
      ? []
      : database.prepare(`
          SELECT r.*, l.kind AS lane_kind
          FROM task_runs r JOIN task_lanes l ON l.id = r.lane_id
          WHERE r.task_id IN (${taskPlaceholders})
          ORDER BY r.queued_at ASC, r.rowid ASC
        `).all(...taskIds)
    const reports = taskIds.length === 0
      ? []
      : database.prepare(`
          SELECT * FROM reports WHERE task_id IN (${taskPlaceholders})
          ORDER BY created_at ASC, rowid ASC
        `).all(...taskIds)
    const attentions = chatIds.length === 0
      ? []
      : database.prepare(`
          SELECT * FROM attentions WHERE chat_id IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC
        `).all(...chatIds)
    const reviews = chatIds.length === 0
      ? []
      : database.prepare(`
          SELECT * FROM captain_reviews WHERE chat_id IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC
        `).all(...chatIds)
    const assignments = chatIds.length === 0
      ? []
      : database.prepare(`
          SELECT * FROM captain_assignments WHERE chat_id IN (${placeholders})
          ORDER BY created_at ASC, rowid ASC
        `).all(...chatIds)
    const artifacts = database.prepare(`
      SELECT * FROM artifacts WHERE room_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(room.id)

    return {
      room: roomView(room, chats),
      chats: chats.map(chatView),
      roles: roles.map(role => roleView(role, rolePrompt(role.id))),
      messages,
      messages_have_older: older,
      tasks: tasks.map(task => taskView(task, roleNames, room)),
      runs: runs.map(runView),
      reports: reports.map(report => reportView(report, room)),
      attentions: attentions.map(attention => attentionView(attention, room)),
      reviews: reviews.map(reviewView),
      assignments: assignments.map(assignmentView),
      artifacts: artifacts.map(artifactView),
    }
  }

  function chatMessages({ chatId, beforeSeq = null, limit = 100, includeCaptain = false } = {}) {
    if (typeof chatId !== 'string' || chatId.length === 0) throw new TypeError('ROOM_READ_MODEL_CHAT_REQUIRED')
    const chat = database.prepare('SELECT * FROM chats WHERE id = ?').get(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    const room = roomRow(chat.room_id)
    const roomRoles = roleRows(chat.room_id)
    const roleNames = roleNameMap(roomRoles)
    const page = messageRows(chatId, {
      limit: boundedLimit(limit, 100, 500),
      beforeSeq: Number.isInteger(beforeSeq) ? beforeSeq : null,
      includeCaptain,
    })
    return {
      messages: page.rows.map(row => messageView(row, roleNames, room)),
      hasMore: page.hasMore,
    }
  }

  return { listRooms, snapshot, chatMessages }
}

module.exports = { createRoomReadModel }
