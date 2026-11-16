const path = require('node:path')
const { MAX_MESSAGE_LENGTH } = require('./message-ingress.cjs')
const { validateUserCommand } = require('./room-actions.cjs')

const LOCAL_USER = Object.freeze({ type: 'user', id: 'user' })

const CHANNELS = Object.freeze({
  listRooms: 'room:list',
  createChat: 'room:chat-create',
  deleteChat: 'room:chat-delete',
  deleteRoom: 'room:room-delete',
  bootstrap: 'room:bootstrap',
  snapshot: 'room:snapshot',
  chatMessages: 'room:chat-messages',
  filesList: 'room:files-list',
  filesRead: 'room:files-read',
  artifactDiff: 'room:artifact-diff',
  submitMessage: 'room:message-submit',
  userCommand: 'room:user-command',
  updateSkillBindings: 'room:skill-bindings-update',
  listStale: 'room:assignments-stale',
  assignmentTrace: 'room:assignment-trace',
  assignmentTraceBlob: 'room:assignment-trace-blob',
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
  if (command.prompt !== undefined) {
    if (['update_role', 'create_role'].includes(command.type)) {
      if (typeof command.prompt !== 'string' || command.prompt.length > 100_000) throw new TypeError('ROOM_IPC_TEXT_INVALID')
    } else {
      text(command.prompt, 100_000)
    }
  }
  if (command.displayName !== undefined) text(command.displayName, 120)
  if (command.provider !== undefined) text(command.provider)
  if (command.responsibilities !== undefined
      && (typeof command.responsibilities !== 'string' || command.responsibilities.length > 4000)) {
    throw new TypeError('ROOM_IPC_ROLE_RESPONSIBILITIES_INVALID')
  }
  if (command.capabilities !== undefined) stringList(command.capabilities, 16)
  if (command.isController !== undefined && typeof command.isController !== 'boolean') {
    throw new TypeError('ROOM_IPC_ROLE_CONTROLLER_INVALID')
  }
  const required = {
    stop_task: ['taskId'], answer_attention: ['attentionId'], update_role_prompt: ['roleId', 'prompt', 'commandId'],
    update_role: ['roleId', 'commandId'], create_role: ['displayName', 'provider', 'commandId'],
    delete_role: ['roleId', 'commandId'],
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
    [CHANNELS.deleteChat, input => {
      assertInput(input, ['roomId', 'chatId'])
      text(input.roomId)
      text(input.chatId)
      return service.deleteChat(input)
    }],
    [CHANNELS.deleteRoom, input => {
      assertInput(input, ['roomId'])
      text(input.roomId)
      return service.deleteRoom(input)
    }],
    [CHANNELS.bootstrap, input => service.bootstrap(bootstrapInput(input))],
    [CHANNELS.snapshot, input => {
      assertInput(input, ['roomId'])
      text(input.roomId)
      return service.snapshot(input)
    }],
    [CHANNELS.chatMessages, input => {
      assertInput(input, ['roomId', 'chatId', 'beforeSequence', 'limit'])
      text(input.roomId)
      text(input.chatId)
      if (input.beforeSequence !== undefined && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) throw new TypeError('ROOM_MESSAGE_CURSOR_INVALID')
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw new TypeError('ROOM_MESSAGE_LIMIT_INVALID')
      return service.listChatMessages({ ...input, beforeSequence: input.beforeSequence ?? null, limit: input.limit ?? 100 })
    }],
    [CHANNELS.filesList, input => {
      assertInput(input, ['roomId', 'relPath', 'cursor'])
      text(input.roomId)
      if (input.relPath !== undefined && (typeof input.relPath !== 'string' || input.relPath.length > 4096 || input.relPath.includes('\u0000'))) {
        throw new TypeError('ROOM_IPC_RELATIVE_PATH_INVALID')
      }
      if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 80)) {
        throw new TypeError('ROOM_IPC_CURSOR_INVALID')
      }
      return service.listRoomFiles({ roomId: input.roomId, relPath: input.relPath ?? '', cursor: input.cursor ?? null })
    }],
    [CHANNELS.filesRead, input => {
      assertInput(input, ['roomId', 'relPath', 'offset', 'length'])
      text(input.roomId)
      text(input.relPath, 4096)
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw new TypeError('ROOM_IPC_OFFSET_INVALID')
      if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > 512 * 1024)) throw new TypeError('ROOM_IPC_LENGTH_INVALID')
      return service.readRoomFile({ roomId: input.roomId, relPath: input.relPath, offset: input.offset ?? 0, length: input.length ?? 512 * 1024 })
    }],
    [CHANNELS.submitMessage, input => service.submitMessage(messageInput(input))],
    [CHANNELS.artifactDiff, input => {
      assertInput(input, ['roomId', 'artifactId'])
      text(input.roomId)
      text(input.artifactId)
      return service.artifactDiff(input)
    }],
    [CHANNELS.userCommand, input => service.applyUserCommand(commandInput(input), { actorId: LOCAL_USER.id })],
    [CHANNELS.updateSkillBindings, input => {
      assertInput(input, ['chatId', 'roleId', 'selections', 'inheritChat'])
      text(input.chatId)
      if (input.roleId != null) text(input.roleId)
      if (input.inheritChat === true) {
        if (!input.roleId) throw new TypeError('ROOM_IPC_SKILL_BINDINGS_INVALID')
      } else {
        if (!Array.isArray(input.selections) || input.selections.length > 4) throw new TypeError('ROOM_IPC_SKILL_SELECTIONS_INVALID')
        for (const selection of input.selections) {
          assertInput(selection, ['targetKind', 'namespace', 'slug', 'name'])
          for (const field of ['targetKind', 'namespace', 'slug', 'name']) text(selection[field])
        }
      }
      return service.updateSkillBindings({ ...input, roleId: input.roleId ?? null, selections: input.selections || [], inheritChat: input.inheritChat === true })
    }],
    [CHANNELS.listStale, input => {
      assertInput(input, ['roomId', 'timeoutMs'])
      text(input.roomId)
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new TypeError('ROOM_SESSION_TIMEOUT_INVALID')
      return service.listStaleAssignments(input)
    }],
    [CHANNELS.assignmentTrace, input => {
      assertInput(input, ['roomId', 'assignmentId', 'cursor', 'direction', 'limit'])
      text(input.roomId)
      text(input.assignmentId)
      if (input.cursor !== undefined) text(input.cursor, 4096)
      if (input.direction !== undefined && !['forward', 'backward'].includes(input.direction)) throw new TypeError('ROOM_TRACE_DIRECTION_INVALID')
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw new TypeError('ROOM_TRACE_LIMIT_INVALID')
      return service.assignmentTrace(input)
    }],
    [CHANNELS.assignmentTraceBlob, input => {
      assertInput(input, ['roomId', 'assignmentId', 'blobId', 'offset', 'length'])
      text(input.roomId)
      text(input.assignmentId)
      text(input.blobId)
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw new TypeError('ROOM_TRACE_OFFSET_INVALID')
      if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > 256 * 1024)) throw new TypeError('ROOM_TRACE_LENGTH_INVALID')
      return service.assignmentTraceBlob(input)
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
