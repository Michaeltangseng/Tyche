const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function timestamp() {
  return new Date().toISOString()
}

function roomView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    writeAuthorizedRoot: row.write_authorized_root,
    providers: parseJson(row.providers_json, []),
    allowedCapabilities: parseJson(row.allowed_capabilities_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function chatView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    status: row.status,
    lastSeq: row.last_seq,
    activitySeq: row.activity_seq,
    captainReviewedSeq: row.captain_reviewed_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function roleView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    displayName: row.display_name,
    responsibilities: row.responsibilities,
    provider: row.provider,
    model: row.model,
    capabilities: parseJson(row.capabilities_json, []),
    nativePermission: row.native_permission,
    isCaptain: row.is_captain === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function participantView(row) {
  if (!row) return undefined
  return {
    chatId: row.chat_id,
    roleId: row.role_id,
    sessionId: row.session_id,
    lastSeq: row.last_seq,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    displayName: row.display_name,
    provider: row.provider,
    isCaptain: row.is_captain === 1,
  }
}

function createRoomRepository(roomDb) {
  const { database } = roomDb

  function requireRoom(roomId) {
    const row = database.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId)
    if (!row) throw new Error('ROOM_NOT_FOUND')
  }

  function requireChat(chatId) {
    const row = database.prepare('SELECT id FROM chats WHERE id = ?').get(chatId)
    if (!row) throw new Error('ROOM_CHAT_NOT_FOUND')
  }

  function requireRole(roleId) {
    const row = database.prepare('SELECT * FROM chat_roles WHERE id = ?').get(roleId)
    if (!row) throw new Error('ROOM_ROLE_NOT_FOUND')
    return row
  }

  return {
    createRoom({ name, workspace, providers = [], allowedCapabilities = [] }) {
      if (typeof name !== 'string' || name.length === 0) throw new TypeError('ROOM_NAME_REQUIRED')
      if (typeof workspace !== 'string' || workspace.length === 0) throw new TypeError('ROOM_WORKSPACE_REQUIRED')
      const id = crypto.randomUUID()
      const at = timestamp()
      database.prepare(`
        INSERT INTO rooms (id, name, workspace, providers_json, allowed_capabilities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, workspace, JSON.stringify(providers), JSON.stringify(allowedCapabilities), at, at)
      return id
    },

    getRoom(roomId) {
      return roomView(database.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId))
    },

    createChat({ roomId, title, status = 'active' }) {
      if (typeof title !== 'string' || title.length === 0) throw new TypeError('ROOM_CHAT_TITLE_REQUIRED')
      requireRoom(roomId)
      const id = crypto.randomUUID()
      const at = timestamp()
      database.prepare(`
        INSERT INTO chats (id, room_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, roomId, title, status, at, at)
      return id
    },

    getChat(chatId) {
      return chatView(database.prepare('SELECT * FROM chats WHERE id = ?').get(chatId))
    },

    createRole({
      chatId, displayName, provider, prompt, isCaptain = false, nativePermission = 'read-only',
      capabilities = [], model = null, responsibilities = '', portrait = '', createdBy = 'user',
    }) {
      if (typeof displayName !== 'string' || displayName.length === 0) throw new TypeError('ROOM_ROLE_NAME_REQUIRED')
      if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('ROOM_ROLE_PROVIDER_REQUIRED')
      if (typeof prompt !== 'string') throw new TypeError('ROOM_ROLE_PROMPT_REQUIRED')
      requireChat(chatId)
      const duty = typeof responsibilities === 'string' ? responsibilities.slice(0, 4000) : ''
      const writer = typeof createdBy === 'string' && createdBy.length > 0 && createdBy.length <= 120 && !createdBy.includes('\u0000')
        ? createdBy
        : 'user'
      const id = crypto.randomUUID()
      const at = timestamp()
      roomDb.withTransaction(() => {
        database.prepare(`
          INSERT INTO chat_roles
            (id, chat_id, display_name, responsibilities, provider, model, capabilities_json, native_permission, portrait, is_captain, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, chatId, displayName, duty, provider, model, JSON.stringify(capabilities), nativePermission, typeof portrait === 'string' ? portrait.slice(0, 40) : '', isCaptain ? 1 : 0, at, at)
        database.prepare(`
          INSERT INTO role_prompt_revisions (id, role_id, revision, prompt, created_by, created_at)
          VALUES (?, ?, 1, ?, ?, ?)
        `).run(crypto.randomUUID(), id, prompt, writer, at)
      })
      return id
    },

    getRole(roleId) {
      return roleView(database.prepare('SELECT * FROM chat_roles WHERE id = ?').get(roleId))
    },

    addParticipant({ chatId, roleId }) {
      requireChat(chatId)
      const role = requireRole(roleId)
      if (role.chat_id !== chatId) throw new Error('ROOM_ROLE_NOT_IN_CHAT')
      const existing = database.prepare('SELECT chat_id FROM chat_participants WHERE chat_id = ? AND role_id = ?').get(chatId, roleId)
      if (existing) throw new Error('ROOM_PARTICIPANT_EXISTS')
      database.prepare(`
        INSERT INTO chat_participants (chat_id, role_id, last_seq, joined_at)
        VALUES (?, ?, 0, ?)
      `).run(chatId, roleId, timestamp())
      return { chatId, roleId }
    },

    getParticipant(chatId, roleId) {
      const row = database.prepare(`
        SELECT p.*, r.display_name, r.provider, r.is_captain
        FROM chat_participants p
        JOIN chat_roles r ON r.id = p.role_id
        WHERE p.chat_id = ? AND p.role_id = ?
      `).get(chatId, roleId)
      return participantView(row)
    },

    listParticipants(chatId) {
      return database.prepare(`
        SELECT p.*, r.display_name, r.provider, r.is_captain
        FROM chat_participants p
        JOIN chat_roles r ON r.id = p.role_id
        WHERE p.chat_id = ? AND p.left_at IS NULL
        ORDER BY p.joined_at ASC
      `).all(chatId).map(participantView)
    },
  }
}

module.exports = { createRoomRepository }
