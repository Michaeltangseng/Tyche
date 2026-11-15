const path = require('node:path')
const { MAX_MESSAGE_LENGTH } = require('./message-ingress.cjs')
const { validateUserCommand } = require('./room-actions.cjs')

const LOCAL_USER = Object.freeze({ type: 'user', id: 'user' })

const CHANNELS = Object.freeze({
  listRooms: 'room:list',
  createChat: 'room:chat-create',
  bootstrap: 'room:bootstrap',
  snapshot: 'room:snapshot',
  submitMessage: 'room:message-submit',
  userCommand: 'room:user-command',
  listStale: 'room:assignments-stale',
})

function assertInput(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ROOM_IPC_INPUT_INVALID')
  if (fields && Object.keys(input).some(key => !fields.includes(key))) throw new TypeError('ROOM_IPC_UNKNOWN_FIELD')
  return input
}

function text(value, max = 256) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\u0000')) throw new TypeError('ROOM_IPC_TEXT_INVALID')
}

function stringList(value, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError('ROOM_IPC_LIST_INVALID')
  for (const item of value) text(item)
}

function bootstrapInput(input) {
  assertInput(input, ['name', 'workspace', 'title', 'providers', 'allowedCapabilities'])
  text(input.name)
  text(input.workspace, 4096)
  if (!path.isAbsolute(input.workspace)) throw new TypeError('ROOM_IPC_WORKSPACE_INVALID')
  if (input.title !== undefined) text(input.title)
  for (const field of ['providers', 'allowedCapabilities']) if (input[field] !== undefined) stringList(input[field])
  return { ...input, createdBy: LOCAL_USER.id }
}

function messageInput(input) {
  assertInput(input, ['chatId', 'content', 'attachmentIds', 'replyTo', 'taskId'])
  text(input.chatId)
  text(input.content, MAX_MESSAGE_LENGTH)
  if (input.attachmentIds !== undefined) stringList(input.attachmentIds)
  for (const field of ['replyTo', 'taskId']) if (input[field] != null) text(input[field])
  return { ...input, author: LOCAL_USER }
}

function commandInput(input) {
  const command = validateUserCommand(assertInput(input))
  // The domain validator owns the action vocabulary/field allowlist. All
  // renderer-supplied IDs and text must also be bounded scalar values.
  for (const field of ['chatId', 'taskId', 'assignmentId', 'commandId', 'roleId', 'attentionId', 'artifactId', 'optionId']) {
    if (command[field] !== undefined) text(command[field])
  }
  for (const field of ['reason', 'comment']) if (command[field] !== undefined) text(command[field], 100_000)
  const required = {
    stop_task: ['taskId'], answer_attention: ['attentionId'],
    accept_artifact: ['artifactId'], reject_artifact: ['artifactId'],
  }
  for (const field of required[command.type] || []) text(command[field])
  if (command.type === 'restore_context' && (!Number.isInteger(command.contextRevision) || command.contextRevision < 0)) throw new TypeError('ROOM_IPC_CONTEXT_REVISION_INVALID')
  return command
}

function registerRoomIpc({ ipcMain, service, requireRenderer, isShuttingDown = () => false }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || !service || typeof requireRenderer !== 'function') throw new TypeError('ROOM_IPC_DEPENDENCIES_REQUIRED')
  const handlers = new Map([
    [CHANNELS.listRooms, input => { assertInput(input, []); return service.listRooms() }],
    [CHANNELS.createChat, input => {
      assertInput(input, ['roomId', 'title'])
      text(input.roomId)
      text(input.title)
      return service.createChat(input)
    }],
    [CHANNELS.bootstrap, input => service.bootstrap(bootstrapInput(input))],
    [CHANNELS.snapshot, input => {
      assertInput(input, ['roomId'])
      text(input.roomId)
      return service.snapshot(input)
    }],
    [CHANNELS.submitMessage, input => service.submitMessage(messageInput(input))],
    [CHANNELS.userCommand, input => service.applyUserCommand(commandInput(input), { actorId: LOCAL_USER.id })],
    [CHANNELS.listStale, input => {
      assertInput(input, ['roomId', 'timeoutMs'])
      text(input.roomId)
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new TypeError('ROOM_SESSION_TIMEOUT_INVALID')
      return service.listStaleAssignments(input)
    }],
  ])
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, input) => {
      await requireRenderer(event)
      if (isShuttingDown()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
      return handler(input)
    })
  }
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler?.(channel)
  }
}

module.exports = { CHANNELS, registerRoomIpc }
