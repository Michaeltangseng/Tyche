/**
 * Production host for the new room domain.
 *
 * This is the only place that opens the room SQLite file, assembles the room
 * service, and turns renderer commands into domain operations. The renderer
 * never sees the workspace path, session refs, PIDs, or raw runtime activity;
 * read-model DTOs are display-safe by construction.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { openRoomDatabase } = require('./db.cjs')
const { createRoomRepository } = require('./repository.cjs')
const { createRoomReadModel } = require('./read-model.cjs')
const { createRoomService } = require('./room-service.cjs')
const { createOarRuntimeAdapter } = require('./runtime-adapter.cjs')
const { sanitizeRuntimeEvent, sanitizeStoredEvent } = require('./runtime-event-view.cjs')
const {
  classifyContent,
  imageMime,
  listDirectory,
  resolveForRead,
  trimUtf8Buffer,
} = require('./workdir-access.cjs')
const { resolveRoot } = require('../runs/path-claims.cjs')

const MAX_MESSAGE_LENGTH = 100_000
const MAX_FILES_READ_BYTES = 512 * 1024
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const DEFAULT_CAPTAIN_PROMPT = [
  'You are the Captain of this chat.',
  'Use assign_in_group to give work to other roles.',
  'Reply directly for normal answers; use post_in_chat only for a separate public notice, without duplicating your reply.',
  'Do not create tasks yourself; the assigned role owns its task.',
  'Keep replies short and quote task numbers when useful.',
].join(' ')
const DEFAULT_WORKER_PROMPT = [
  'You execute tasks assigned to you in this chat.',
  'For work that changes files or needs several steps, create a task with create_task before doing it.',
  'When the task is complete, call finish_task with status ready and a short summary.',
  'Use comment_task for short comments on an existing task.',
  'Keep replies short.',
].join(' ')
// Kept so rooms created by earlier builds repair their untouched defaults.
const LEGACY_CAPTAIN_PROMPT = [
  'You are the Captain of this chat.',
  'Use assign_in_group to give work to other roles, and post_in_chat for public updates.',
  'Do not create tasks yourself; the assigned role owns its task.',
  'Keep replies short and quote task numbers when useful.',
].join(' ')

function isCaptainPrompt(value) {
  return value === DEFAULT_CAPTAIN_PROMPT || value === LEGACY_CAPTAIN_PROMPT
}

function hostError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function cleanText(value, max, label) {
  if (typeof value !== 'string') throw hostError('TEAM_ROOM_INPUT_INVALID', `${label} is required`)
  const text = value.trim()
  if (!text || text.length > max || text.includes('\u0000')) {
    throw hostError('TEAM_ROOM_INPUT_INVALID', `${label} is invalid`)
  }
  return text
}

function optionalText(value, max, label) {
  if (value === undefined || value === null) return ''
  return cleanText(value, max, label)
}

function roomIdOf(value) {
  const id = cleanText(value, 120, 'roomId')
  if (!ROOM_ID.test(id)) throw hostError('TEAM_ROOM_INPUT_INVALID', 'roomId is invalid')
  return id
}

function workspacePath(value) {
  const raw = cleanText(value, 4096, 'workspace')
  if (!path.isAbsolute(raw)) throw hostError('TEAM_ROOM_WORKSPACE_INVALID')
  let real
  try {
    real = fs.realpathSync.native(path.resolve(raw))
  } catch {
    throw hostError('TEAM_ROOM_WORKSPACE_INVALID')
  }
  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    throw hostError('TEAM_ROOM_WORKSPACE_INVALID')
  }
  if (!stat.isDirectory()) throw hostError('TEAM_ROOM_WORKSPACE_INVALID')
  return real
}

function providerList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw hostError('TEAM_ROOM_INPUT_INVALID', 'providers are required')
  }
  const providers = []
  for (const item of value) {
    const provider = cleanText(item, 40, 'provider')
    if (!PROVIDER.test(provider)) throw hostError('TEAM_ROOM_INPUT_INVALID', 'provider is invalid')
    if (!providers.includes(provider)) providers.push(provider)
  }
  return providers
}

function stringList(value, maxItems, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maxItems) {
    throw hostError('TEAM_ROOM_INPUT_INVALID', `${label} is invalid`)
  }
  return value.map(item => cleanText(item, 200, label))
}

function defaultNativePermission(provider) {
  if (provider === 'claude') return 'bypassPermissions'
  if (provider === 'codex') return 'danger-full-access'
  return 'read-only'
}

function normalizeRole(input, index, providers) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw hostError('TEAM_ROOM_INPUT_INVALID', `roles[${index}] is invalid`)
  }
  const displayName = cleanText(input.displayName, 120, `roles[${index}].displayName`)
  const provider = cleanText(input.provider, 40, `roles[${index}].provider`)
  if (!PROVIDER.test(provider) || !providers.includes(provider)) {
    throw hostError('TEAM_ROOM_ROLE_PROVIDER_NOT_ALLOWED')
  }
  return {
    displayName,
    provider,
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 100_000) : '',
    isCaptain: input.isCaptain === true,
    nativePermission: input.nativePermission === undefined
      ? defaultNativePermission(provider)
      : cleanText(input.nativePermission, 80, `roles[${index}].nativePermission`),
    capabilities: stringList(input.capabilities, 16, `roles[${index}].capabilities`),
    model: input.model === undefined || input.model === null
      ? null
      : cleanText(input.model, 120, `roles[${index}].model`),
  }
}

function runtimeWrapperFile() {
  const directory = __dirname.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
  return path.join(directory, 'tyche-runtime-wrapper.sh')
}

function createRoomHost({
  privateRoot,
  env = process.env,
  runtimeWrapperPath = runtimeWrapperFile(),
  adapterFactory = null,
  liveness = true,
  now = () => Date.now(),
  onChanged = () => {},
  onRuntimeEvent = () => {},
} = {}) {
  if (typeof privateRoot !== 'string' || !path.isAbsolute(privateRoot)) {
    throw new TypeError('ROOM_HOST_PRIVATE_ROOT_REQUIRED')
  }
  const directory = path.join(privateRoot, 'room')
  const runtimeStateDir = path.join(directory, 'runtime')
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const readModel = createRoomReadModel({ roomDb })
  const service = createRoomService({
    roomDb,
    repository,
    recoverOnOpen: true,
    liveness,
    now,
    onEvent: (payload) => {
      const view = sanitizeRuntimeEvent(payload)
      if (!view) return
      try { onRuntimeEvent(view) } catch { /* event observers are best-effort */ }
    },
    adapterFactory: adapterFactory || (deps => createOarRuntimeAdapter({
      ...deps,
      env,
      now,
    })),
    runtimeWrapperPath,
    runtimeStateDir,
  })
  let started = null
  let closed = false
  const unsubscribeCommit = roomDb.onCommit(() => {
    try { onChanged() } catch { /* observers are best-effort */ }
  })

  function requireChat(chatId, roomId = null) {
    const id = cleanText(chatId, 120, 'chatId')
    const chat = repository.getChat(id)
    if (!chat) throw hostError('ROOM_CHAT_NOT_FOUND')
    if (roomId && chat.roomId !== roomId) throw hostError('ROOM_CHAT_NOT_FOUND')
    return chat
  }

  function requireRoom(roomId) {
    const room = repository.getRoom(roomIdOf(roomId))
    if (!room) throw hostError('ROOM_NOT_FOUND')
    return room
  }

  function listRooms() {
    return readModel.listRooms()
  }

  function snapshot(input = {}) {
    const roomId = roomIdOf(input.roomId)
    return readModel.snapshot({
      roomId,
      messageLimit: input.messageLimit,
      includeCaptain: input.includeCaptain === true,
    })
  }

  function chatMessages(input = {}) {
    const chat = requireChat(input.chatId, input.roomId ? roomIdOf(input.roomId) : null)
    return readModel.chatMessages({
      chatId: chat.id,
      beforeSeq: input.beforeSeq,
      limit: input.limit,
      includeCaptain: input.includeCaptain === true,
    })
  }

  function bootstrap(input = {}) {
    const name = cleanText(input.name, 120, 'name')
    const workspace = workspacePath(input.workspace)
    const providers = providerList(input.providers)
    const allowedCapabilities = stringList(input.allowedCapabilities, 32, 'allowedCapabilities')
    const title = optionalText(input.title, 120, 'title') || name
    const rawRoles = Array.isArray(input.roles) && input.roles.length > 0
      ? input.roles
      : [{ displayName: 'Captain', provider: providers[0], prompt: DEFAULT_CAPTAIN_PROMPT, isCaptain: true }]
    if (rawRoles.length > 32) throw hostError('TEAM_ROOM_INPUT_INVALID', 'too many roles')
    const roles = rawRoles.map((role, index) => normalizeRole(role, index, providers))
    const captainCount = roles.filter(role => role.isCaptain).length
    if (captainCount > 1) throw hostError('ROOM_ROLE_CAPTAIN_CONFLICT')
    if (captainCount === 0) roles[0].isCaptain = true
    for (const role of roles) {
      if (role.prompt) continue
      role.prompt = role.isCaptain ? DEFAULT_CAPTAIN_PROMPT : DEFAULT_WORKER_PROMPT
    }
    return roomDb.withTransaction(() => {
      const roomId = repository.createRoom({
        name,
        workspace,
        providers,
        allowedCapabilities,
      })
      const chatId = repository.createChat({ roomId, title })
      for (const role of roles) {
        const roleId = repository.createRole({ chatId, ...role })
        repository.addParticipant({ chatId, roleId })
      }
      return { roomId, chatId }
    })
  }

  function createChat(input = {}) {
    const room = requireRoom(input.roomId)
    const title = cleanText(input.title, 120, 'title')
    let source = null
    if (input.sourceChatId) {
      source = requireChat(input.sourceChatId, room.id)
    } else {
      const firstChatId = roomDb.database.prepare(
        'SELECT id FROM chats WHERE room_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
      ).get(room.id)?.id
      source = firstChatId ? repository.getChat(firstChatId) : null
    }
    const sourceRoles = source
      ? roomDb.database.prepare(`
          SELECT r.*, p.prompt
          FROM chat_roles r
          LEFT JOIN role_prompt_revisions p
            ON p.role_id = r.id
           AND p.revision = (SELECT MAX(revision) FROM role_prompt_revisions WHERE role_id = r.id)
          WHERE r.chat_id = ? AND r.status = 'active'
          ORDER BY r.created_at ASC, r.rowid ASC
        `).all(source.id)
      : []
    return roomDb.withTransaction(() => {
      const chatId = repository.createChat({ roomId: room.id, title })
      for (const role of sourceRoles) {
        const isCaptain = role.is_captain === 1
        let prompt = role.prompt || ''
        if (!isCaptain && isCaptainPrompt(prompt)) prompt = DEFAULT_WORKER_PROMPT
        else if (isCaptain && prompt === DEFAULT_WORKER_PROMPT) prompt = DEFAULT_CAPTAIN_PROMPT
        if (!prompt) prompt = isCaptain ? DEFAULT_CAPTAIN_PROMPT : DEFAULT_WORKER_PROMPT
        const roleId = repository.createRole({
          chatId,
          displayName: role.display_name,
          provider: role.provider,
          prompt,
          isCaptain,
          nativePermission: role.native_permission,
          capabilities: JSON.parse(role.capabilities_json || '[]'),
          model: role.model,
        })
        repository.addParticipant({ chatId, roleId })
      }
      return { roomId: room.id, chatId }
    })
  }

  function deleteChat(input = {}) {
    const room = requireRoom(input.roomId)
    const chat = requireChat(input.chatId, room.id)
    const primaryChatId = roomDb.database.prepare(
      'SELECT id FROM chats WHERE room_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
    ).get(room.id)?.id
    if (chat.id === primaryChatId) throw hostError('ROOM_PRIMARY_CHAT_UNDELETABLE')
    const busyReply = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE chat_id = ? AND author_type = 'agent'
        AND status IN ('queued', 'working', 'waiting_for_input', 'stopping')
    `).get(chat.id).n
    const busyRun = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM task_runs r
      JOIN tasks t ON t.id = r.task_id
      WHERE t.chat_id = ? AND r.status IN ('queued', 'starting', 'running', 'stopping')
    `).get(chat.id).n
    if (busyReply > 0 || busyRun > 0) throw hostError('ROOM_CHAT_BUSY')
    roomDb.database.prepare('DELETE FROM chats WHERE id = ?').run(chat.id)
    return { deleted: true, chatId: chat.id }
  }

  function deleteRoom(input = {}) {
    const room = requireRoom(input.roomId)
    const busyReply = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.room_id = ? AND m.author_type = 'agent'
        AND m.status IN ('queued', 'working', 'waiting_for_input', 'stopping')
    `).get(room.id).n
    const busyRun = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM task_runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN chats c ON c.id = t.chat_id
      WHERE c.room_id = ? AND r.status IN ('queued', 'starting', 'running', 'stopping')
    `).get(room.id).n
    if (busyReply > 0 || busyRun > 0) throw hostError('ROOM_ROOM_BUSY')
    roomDb.database.prepare('DELETE FROM rooms WHERE id = ?').run(room.id)
    return { deleted: true, roomId: room.id }
  }

  function roleBusy(roleId) {
    const reply = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE author_id = ? AND author_type = 'agent'
        AND status IN ('queued', 'working', 'waiting_for_input', 'stopping')
    `).get(roleId).n
    const run = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM task_runs
      WHERE role_id = ? AND status IN ('queued', 'starting', 'running', 'stopping')
    `).get(roleId).n
    return reply > 0 || run > 0
  }

  function roleContext(input) {
    const room = requireRoom(input.roomId)
    const role = repository.getRole(cleanText(input.roleId, 120, 'roleId'))
    if (!role) throw hostError('ROOM_ROLE_NOT_FOUND')
    const chat = requireChat(role.chatId, room.id)
    return { room, role, chat }
  }

  function latestPrompt(roleId) {
    return roomDb.database.prepare(`
      SELECT prompt FROM role_prompt_revisions
      WHERE role_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1
    `).get(roleId)?.prompt ?? ''
  }

  function insertPromptRevision(roleId, prompt) {
    const revision = (roomDb.database.prepare(
      'SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?',
    ).get(roleId)?.revision || 0) + 1
    roomDb.database.prepare(`
      INSERT INTO role_prompt_revisions (id, role_id, revision, prompt, created_by, created_at)
      VALUES (?, ?, ?, ?, 'system', ?)
    `).run(crypto.randomUUID(), roleId, revision, prompt, new Date(now()).toISOString())
  }

  /**
   * Earlier builds gave every role the Captain prompt and kept it after a
   * demotion. Repair the untouched defaults without overwriting custom prompts.
   */
  function repairDefaultPrompts() {
    const roles = roomDb.database.prepare("SELECT id, is_captain FROM chat_roles WHERE status = 'active'").all()
    for (const role of roles) {
      const prompt = latestPrompt(role.id)
      if (role.is_captain === 1 && (prompt === DEFAULT_WORKER_PROMPT || prompt === LEGACY_CAPTAIN_PROMPT)) {
        insertPromptRevision(role.id, DEFAULT_CAPTAIN_PROMPT)
      } else if (role.is_captain !== 1 && isCaptainPrompt(prompt)) {
        insertPromptRevision(role.id, DEFAULT_WORKER_PROMPT)
      }
    }
  }

  function createRole(input = {}) {
    const room = requireRoom(input.roomId)
    const chat = requireChat(input.chatId, room.id)
    if (typeof input.displayName !== 'string' || !input.displayName.trim()) {
      throw hostError('ROOM_ROLE_NAME_REQUIRED')
    }
    if (!room.providers.includes(input.provider)) throw hostError('ROOM_ROLE_PROVIDER_NOT_ALLOWED')
    if (input.isCaptain === true) {
      const captain = roomDb.database.prepare(
        "SELECT id FROM chat_roles WHERE chat_id = ? AND is_captain = 1 AND status = 'active'",
      ).get(chat.id)
      if (captain) throw hostError('ROOM_ROLE_CAPTAIN_CONFLICT')
    }
    const prompt = typeof input.prompt === 'string' && input.prompt.length > 0
      ? input.prompt.slice(0, 100_000)
      : (input.isCaptain === true ? DEFAULT_CAPTAIN_PROMPT : DEFAULT_WORKER_PROMPT)
    return roomDb.withTransaction(() => {
      const roleId = repository.createRole({
        chatId: chat.id,
        displayName: input.displayName.trim(),
        provider: input.provider,
        prompt,
        isCaptain: input.isCaptain === true,
        nativePermission: input.nativePermission === undefined
          ? defaultNativePermission(input.provider)
          : cleanText(input.nativePermission, 80, 'nativePermission'),
        capabilities: stringList(input.capabilities, 16, 'capabilities'),
        model: input.model === undefined || input.model === null
          ? null
          : cleanText(input.model, 120, 'model'),
      })
      repository.addParticipant({ chatId: chat.id, roleId })
      return { roomId: room.id, chatId: chat.id, roleId }
    })
  }

  function updateRole(input = {}) {
    const { room, role, chat } = roleContext(input)
    if (roleBusy(role.id)) throw hostError('ROOM_ROLE_BUSY')
    if (input.provider !== undefined && !room.providers.includes(input.provider)) {
      throw hostError('ROOM_ROLE_PROVIDER_NOT_ALLOWED')
    }
    if (input.isCaptain === true && role.isCaptain !== true) {
      const captain = roomDb.database.prepare(
        "SELECT id FROM chat_roles WHERE chat_id = ? AND is_captain = 1 AND status = 'active'",
      ).get(chat.id)
      if (captain) throw hostError('ROOM_ROLE_CAPTAIN_CONFLICT')
    }
    const currentPrompt = latestPrompt(role.id)
    const nextCaptain = input.isCaptain === undefined ? role.isCaptain : input.isCaptain === true
    let promptToWrite = input.prompt
    if (promptToWrite === undefined && nextCaptain !== role.isCaptain) {
      if (nextCaptain && currentPrompt === DEFAULT_WORKER_PROMPT) promptToWrite = DEFAULT_CAPTAIN_PROMPT
      else if (!nextCaptain && isCaptainPrompt(currentPrompt)) promptToWrite = DEFAULT_WORKER_PROMPT
    }
    return roomDb.withTransaction(() => {
      const assignments = []
      const values = []
      if (input.displayName !== undefined) {
        const displayName = cleanText(input.displayName, 120, 'displayName')
        assignments.push('display_name = ?')
        values.push(displayName)
      }
      if (input.provider !== undefined) {
        assignments.push('provider = ?')
        values.push(cleanText(input.provider, 40, 'provider'))
      }
      if (input.model !== undefined) {
        assignments.push('model = ?')
        values.push(input.model === null ? null : cleanText(input.model, 120, 'model'))
      }
      if (input.nativePermission !== undefined) {
        assignments.push('native_permission = ?')
        values.push(cleanText(input.nativePermission, 80, 'nativePermission'))
      }
      if (input.capabilities !== undefined) {
        assignments.push('capabilities_json = ?')
        values.push(JSON.stringify(stringList(input.capabilities, 16, 'capabilities')))
      }
      if (input.responsibilities !== undefined) {
        const responsibilities = typeof input.responsibilities === 'string'
          ? input.responsibilities.slice(0, 4000)
          : ''
        assignments.push('responsibilities = ?')
        values.push(responsibilities)
      }
      if (input.isCaptain !== undefined) {
        assignments.push('is_captain = ?')
        values.push(input.isCaptain === true ? 1 : 0)
      }
      if (assignments.length > 0) {
        assignments.push('updated_at = ?')
        values.push(new Date(now()).toISOString(), role.id)
        roomDb.database.prepare(
          `UPDATE chat_roles SET ${assignments.join(', ')} WHERE id = ?`,
        ).run(...values)
      }
      if (promptToWrite !== undefined) {
        if (typeof promptToWrite !== 'string' || promptToWrite.length > 100_000) {
          throw hostError('ROOM_ROLE_PROMPT_REQUIRED')
        }
        const revision = (roomDb.database.prepare(
          'SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?',
        ).get(role.id)?.revision || 0) + 1
        roomDb.database.prepare(`
          INSERT INTO role_prompt_revisions (id, role_id, revision, prompt, created_by, created_at)
          VALUES (?, ?, ?, ?, 'user', ?)
        `).run(crypto.randomUUID(), role.id, revision, promptToWrite, new Date(now()).toISOString())
      }
      return { roomId: room.id, chatId: chat.id, roleId: role.id }
    })
  }

  /**
   * Captain is a chat-level singleton. Swapping it is one transaction so the
   * UI never has to demote the old Captain and promote the new one in two
   * separate saves.
   */
  function setCaptain(input = {}) {
    const { room, role, chat } = roleContext(input)
    if (roleBusy(role.id)) throw hostError('ROOM_ROLE_BUSY')
    const previous = roomDb.database.prepare(
      "SELECT id FROM chat_roles WHERE chat_id = ? AND is_captain = 1 AND status = 'active'",
    ).get(chat.id)
    if (previous?.id === role.id) {
      return { roomId: room.id, chatId: chat.id, roleId: role.id, previousRoleId: previous.id }
    }
    if (previous && roleBusy(previous.id)) throw hostError('ROOM_ROLE_BUSY')
    return roomDb.withTransaction(() => {
      roomDb.database.prepare(
        'UPDATE chat_roles SET is_captain = 0, updated_at = ? WHERE chat_id = ? AND is_captain = 1',
      ).run(new Date(now()).toISOString(), chat.id)
      roomDb.database.prepare(
        'UPDATE chat_roles SET is_captain = 1, updated_at = ? WHERE id = ?',
      ).run(new Date(now()).toISOString(), role.id)
      if (previous && isCaptainPrompt(latestPrompt(previous.id))) {
        insertPromptRevision(previous.id, DEFAULT_WORKER_PROMPT)
      }
      if (latestPrompt(role.id) === DEFAULT_WORKER_PROMPT) {
        insertPromptRevision(role.id, DEFAULT_CAPTAIN_PROMPT)
      }
      return {
        roomId: room.id,
        chatId: chat.id,
        roleId: role.id,
        previousRoleId: previous?.id ?? null,
      }
    })
  }

  function deleteRole(input = {}) {
    const { room, role } = roleContext(input)
    if (roleBusy(role.id)) throw hostError('ROOM_ROLE_BUSY')
    const inUse = roomDb.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM task_lanes WHERE role_id = ?) +
        (SELECT COUNT(*) FROM task_runs WHERE role_id = ?) +
        (SELECT COUNT(*) FROM tasks WHERE assignee_role_id = ? OR created_by_role_id = ?) AS n
    `).get(role.id, role.id, role.id, role.id).n
    if (inUse > 0) throw hostError('ROOM_ROLE_IN_USE')
    roomDb.database.prepare('DELETE FROM chat_roles WHERE id = ?').run(role.id)
    return { deleted: true, roomId: room.id, roleId: role.id }
  }

  function answerAttention(input = {}) {
    const room = requireRoom(input.roomId)
    const chat = requireChat(input.chatId, room.id)
    const attentionId = cleanText(input.attentionId, 120, 'attentionId')
    const commandId = cleanText(input.commandId, 120, 'commandId')
    const resolution = cleanText(input.resolution, 4000, 'resolution')
    const attention = roomDb.database.prepare(
      'SELECT * FROM attentions WHERE id = ?',
    ).get(attentionId)
    if (!attention || attention.chat_id !== chat.id) throw hostError('ROOM_ATTENTION_NOT_FOUND')
    if (attention.status !== 'open') {
      const existing = roomDb.database.prepare(
        "SELECT * FROM user_commands WHERE type = 'answer_attention' AND id = ?",
      ).get(commandId)
      if (existing) return { attentionId, status: 'answered' }
      throw hostError('ROOM_ATTENTION_ALREADY_ANSWERED')
    }
    return roomDb.withTransaction(() => {
      roomDb.database.prepare(`
        UPDATE attentions
        SET status = 'answered', answered_by = 'user', resolution_json = ?
        WHERE id = ?
      `).run(JSON.stringify({ text: resolution }), attention.id)
      roomDb.database.prepare(`
        INSERT INTO user_commands (id, chat_id, type, payload_json, status, result_json, created_at)
        VALUES (?, ?, 'answer_attention', ?, 'succeeded', ?, ?)
      `).run(
        commandId,
        chat.id,
        JSON.stringify({ attentionId, resolution }),
        JSON.stringify({ attentionId, status: 'answered' }),
        new Date(now()).toISOString(),
      )
      service.timeline.append({
        chatId: chat.id,
        authorType: 'system',
        authorId: 'user',
        kind: 'attention_resolution',
        content: `Attention answered: ${resolution}`,
        status: 'done',
      })
      service.requestLiveness()
      return { attentionId: attention.id, status: 'answered' }
    })
  }

  function submitMessage(input = {}) {
    const chat = requireChat(input.chatId, input.roomId ? roomIdOf(input.roomId) : null)
    if (typeof input.content !== 'string' || input.content.length > MAX_MESSAGE_LENGTH) {
      throw hostError('TEAM_ROOM_MESSAGE_INVALID')
    }
    const content = input.content.trim()
    if (!content) throw hostError('TEAM_ROOM_MESSAGE_INVALID')
    return service.submitUserMessage({
      chatId: chat.id,
      content,
      clientId: input.clientId === undefined || input.clientId === null
        ? null
        : cleanText(input.clientId, 120, 'clientId'),
    })
  }

  function acceptTask(input = {}) {
    const taskId = cleanText(input.taskId, 120, 'taskId')
    const commandId = cleanText(input.commandId, 120, 'commandId')
    if (input.roomId) {
      const room = requireRoom(input.roomId)
      const task = roomDb.database.prepare('SELECT chat_id FROM tasks WHERE id = ?').get(taskId)
      if (!task) throw hostError('ROOM_TASK_NOT_FOUND')
      requireChat(task.chat_id, room.id)
    }
    return service.settlement.acceptTask({ taskId, commandId })
  }

  async function stopReply(input = {}) {
    const replyId = cleanText(input.replyId, 120, 'replyId')
    if (input.roomId) {
      const room = requireRoom(input.roomId)
      const reply = roomDb.database.prepare('SELECT chat_id FROM messages WHERE id = ?').get(replyId)
      if (!reply) throw hostError('ROOM_MESSAGE_NOT_FOUND')
      requireChat(reply.chat_id, room.id)
    }
    await service.stopReply({ replyId })
    return { stopped: true, replyId }
  }

  async function rootInfoFor(roomId) {
    const room = requireRoom(roomId)
    try {
      return await resolveRoot(room.workspace)
    } catch {
      throw hostError('ROOM_WORKSPACE_UNAVAILABLE')
    }
  }

  async function filesList(input = {}) {
    const roomId = roomIdOf(input.roomId)
    const rootInfo = await rootInfoFor(roomId)
    const cursor = input.cursor === undefined || input.cursor === null || input.cursor === ''
      ? 0
      : Number(input.cursor)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw hostError('TEAM_ROOM_CURSOR_INVALID')
    try {
      const result = await listDirectory(rootInfo, input.relPath || '', cursor)
      return {
        entries: result.entries,
        cursor: result.cursor,
        hasMore: result.hasMore,
      }
    } catch (error) {
      if (error?.code === 'WORKDIR_PATH_REJECTED') throw hostError('ROOM_FILE_PATH_REJECTED')
      throw error
    }
  }

  async function filesRead(input = {}) {
    const roomId = roomIdOf(input.roomId)
    const relPath = cleanText(input.relPath, 4096, 'relPath')
    const offset = input.offset === undefined ? 0 : Number(input.offset)
    const length = input.length === undefined ? MAX_FILES_READ_BYTES : Number(input.length)
    if (!Number.isSafeInteger(offset) || offset < 0) throw hostError('TEAM_ROOM_CURSOR_INVALID')
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILES_READ_BYTES) {
      throw hostError('TEAM_ROOM_READ_LENGTH_INVALID')
    }
    const rootInfo = await rootInfoFor(roomId)
    let opened
    try {
      opened = await resolveForRead(rootInfo, relPath)
    } catch (error) {
      if (error?.code === 'WORKDIR_PATH_REJECTED') throw hostError('ROOM_FILE_PATH_REJECTED')
      throw error
    }
    try {
      const stat = fs.fstatSync(opened.fd)
      const totalBytes = stat.size
      const start = Math.min(offset, totalBytes)
      const requested = Math.min(length, MAX_FILES_READ_BYTES, totalBytes - start)
      const buffer = Buffer.alloc(requested)
      const read = requested > 0 ? fs.readSync(opened.fd, buffer, 0, requested, start) : 0
      const slice = Buffer.isBuffer(read) ? read : buffer.subarray(0, read)
      const kind = classifyContent(slice, path.basename(opened.relative))
      if (kind === 'image' && totalBytes <= 5 * 1024 * 1024) {
        const whole = Buffer.alloc(totalBytes)
        fs.readSync(opened.fd, whole, 0, totalBytes, 0)
        return {
          kind: 'image',
          mime: imageMime(whole),
          dataBase64: whole.toString('base64'),
        }
      }
      if (kind === 'text') {
        const textBuffer = trimUtf8Buffer(slice)
        return {
          kind: 'text',
          text: textBuffer.toString('utf8'),
          totalBytes,
          eof: start + textBuffer.length >= totalBytes,
          encoding: 'utf-8',
        }
      }
      return {
        kind: 'binary',
        size: totalBytes,
        ...(kind === 'image' ? { mime: imageMime(slice) } : {}),
      }
    } finally {
      fs.closeSync(opened.fd)
    }
  }

  function setWriteAuthorized(input = {}) {
    const room = requireRoom(input.roomId)
    if (typeof input.authorized !== 'boolean') throw hostError('TEAM_ROOM_INPUT_INVALID')
    const authorizedRoot = input.authorized ? room.workspace : null
    roomDb.database.prepare(
      'UPDATE rooms SET write_authorized_root = ?, updated_at = ? WHERE id = ?',
    ).run(authorizedRoot, new Date(now()).toISOString(), room.id)
    return { roomId: room.id, authorized: Boolean(authorizedRoot) }
  }

  function runtimeEvents(input = {}) {
    const room = requireRoom(input.roomId)
    const chat = requireChat(input.chatId, room.id)
    const runId = input.runId === undefined || input.runId === null
      ? null
      : cleanText(input.runId, 120, 'runId')
    return service.runtimeEvents.list({
      chatId: chat.id,
      runId,
      limit: input.limit,
    }).map(sanitizeStoredEvent).filter(Boolean)
  }

  async function start() {
    if (closed) throw hostError('ROOM_HOST_CLOSED')
    if (!started) {
      started = (async () => {
        await service.startupSweep
        try { repairDefaultPrompts() } catch { /* prompt repair is best-effort */ }
        try { service.runtimeEvents.prune() } catch { /* retention is best-effort */ }
        service.requestTick()
        service.requestLiveness()
      })()
    }
    await started
    return { ready: true }
  }

  async function close() {
    if (closed) return
    closed = true
    unsubscribeCommit()
    try { await service.close() } catch { /* shutdown is best effort */ }
    try { roomDb.close() } catch { /* shutdown is best effort */ }
  }

  return {
    roomDb,
    repository,
    readModel,
    service,
    start,
    close,
    listRooms,
    snapshot,
    chatMessages,
    bootstrap,
    createChat,
    deleteChat,
    deleteRoom,
    createRole,
    updateRole,
    setCaptain,
    deleteRole,
    answerAttention,
    submitMessage,
    acceptTask,
    stopReply,
    filesList,
    filesRead,
    setWriteAuthorized,
    runtimeEvents,
  }
}

module.exports = { createRoomHost, DEFAULT_CAPTAIN_PROMPT }
