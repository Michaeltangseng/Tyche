/**
 * Production host for the new room domain.
 *
 * This is the only place that opens the room SQLite file, assembles the room
 * service, and turns renderer commands into domain operations. The renderer
 * never sees the workspace path, session refs, PIDs, or raw runtime activity;
 * read-model DTOs are display-safe by construction.
 */
const fs = require('node:fs')
const path = require('node:path')

const { openRoomDatabase } = require('./db.cjs')
const { createRoomRepository } = require('./repository.cjs')
const { createRoomReadModel } = require('./read-model.cjs')
const { createRoomService } = require('./room-service.cjs')
const { createOarRuntimeAdapter } = require('./runtime-adapter.cjs')
const {
  classifyContent,
  imageMime,
  listDirectory,
  resolveForRead,
  trimUtf8Buffer,
} = require('../room-engine/workdir-access.cjs')
const { resolveRoot } = require('../runs/path-claims.cjs')

const MAX_MESSAGE_LENGTH = 100_000
const MAX_FILES_READ_BYTES = 512 * 1024
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const DEFAULT_CAPTAIN_PROMPT = [
  'You are the Captain of this chat.',
  'Use assign_in_group to give work to other roles, and post_in_chat for public updates.',
  'Do not create tasks yourself; the assigned role owns its task.',
  'Keep replies short and quote task numbers when useful.',
].join(' ')

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
  return path.join(directory, 'meldwork-runtime-wrapper.sh')
}

function createRoomHost({
  privateRoot,
  env = process.env,
  runtimeWrapperPath = runtimeWrapperFile(),
  adapterFactory = null,
  liveness = true,
  now = () => Date.now(),
  onChanged = () => {},
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
    if (!roles.some(role => role.prompt)) {
      const captain = roles.find(role => role.isCaptain)
      if (captain) captain.prompt = DEFAULT_CAPTAIN_PROMPT
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
        const roleId = repository.createRole({
          chatId,
          displayName: role.display_name,
          provider: role.provider,
          prompt: role.prompt || '',
          isCaptain: role.is_captain === 1,
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
    })
  }

  async function start() {
    if (closed) throw hostError('ROOM_HOST_CLOSED')
    if (!started) {
      started = (async () => {
        await service.startupSweep
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
