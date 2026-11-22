/**
 * Narrow IPC surface for the new room domain.
 *
 * Handlers validate renderer input and return display-safe DTOs from the room
 * read model. Authoritative paths, session refs, and process identity stay in
 * the main process; the renderer only receives workspace labels.
 */
const CHANNELS = Object.freeze({
  listRooms: 'team-room:list',
  bootstrap: 'team-room:bootstrap',
  snapshot: 'team-room:snapshot',
  chatMessages: 'team-room:chat-messages',
  createChat: 'team-room:chat-create',
  renameChat: 'team-room:chat-rename',
  deleteChat: 'team-room:chat-delete',
  deleteRoom: 'team-room:room-delete',
  createRole: 'team-room:role-create',
  updateRole: 'team-room:role-update',
  setCaptain: 'team-room:role-set-captain',
  deleteRole: 'team-room:role-delete',
  answerAttention: 'team-room:attention-answer',
  submitMessage: 'team-room:message-submit',
  acceptTask: 'team-room:accept-task',
  stopReply: 'team-room:stop-reply',
  filesList: 'team-room:files-list',
  filesRead: 'team-room:files-read',
  importFiles: 'team-room:files-import',
  writeAuthorized: 'team-room:write-authorized',
  runtimeEvents: 'team-room:runtime-events',
})

function ipcError(code) {
  return Object.assign(new Error(code), { code })
}

function assertInput(input, fields = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ipcError('TEAM_ROOM_INPUT_INVALID')
  }
  const keys = Object.keys(input)
  if (keys.some(key => !fields.includes(key))) throw ipcError('TEAM_ROOM_INPUT_INVALID')
  return input
}

function text(value, max = 120) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw ipcError('TEAM_ROOM_INPUT_INVALID')
  }
  return value
}

function optionalInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw ipcError('TEAM_ROOM_INPUT_INVALID')
  }
  return value
}

function registerTeamRoomIpc({ registerTrustedHandle, getHost, dialog, getMainWindow }) {
  if (typeof registerTrustedHandle !== 'function') throw new TypeError('TEAM_ROOM_IPC_DEPENDENCIES_REQUIRED')
  const host = () => {
    const value = getHost?.()
    if (!value) throw ipcError('TEAM_ROOM_UNAVAILABLE')
    return value
  }

  registerTrustedHandle(CHANNELS.listRooms, () => host().listRooms())

  registerTrustedHandle(CHANNELS.bootstrap, input => {
    const parsed = assertInput(input, [
      'name', 'workspace', 'providers', 'allowedCapabilities', 'title', 'roles',
    ])
    return host().bootstrap(parsed)
  })

  registerTrustedHandle(CHANNELS.snapshot, input => {
    const parsed = assertInput(input, ['roomId', 'messageLimit', 'includeCaptain'])
    text(parsed.roomId)
    optionalInteger(parsed.messageLimit, { min: 1, max: 500 })
    if (parsed.includeCaptain !== undefined && typeof parsed.includeCaptain !== 'boolean') {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    return host().snapshot(parsed)
  })

  registerTrustedHandle(CHANNELS.chatMessages, input => {
    const parsed = assertInput(input, ['roomId', 'chatId', 'beforeSeq', 'limit', 'includeCaptain'])
    text(parsed.roomId)
    text(parsed.chatId)
    optionalInteger(parsed.beforeSeq, { min: 1 })
    optionalInteger(parsed.limit, { min: 1, max: 500 })
    if (parsed.includeCaptain !== undefined && typeof parsed.includeCaptain !== 'boolean') {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    return host().chatMessages(parsed)
  })

  registerTrustedHandle(CHANNELS.createChat, input => {
    const parsed = assertInput(input, ['roomId', 'title', 'sourceChatId'])
    text(parsed.roomId)
    text(parsed.title)
    if (parsed.sourceChatId !== undefined) text(parsed.sourceChatId)
    return host().createChat(parsed)
  })

  registerTrustedHandle(CHANNELS.renameChat, input => {
    const parsed = assertInput(input, ['roomId', 'chatId', 'title'])
    text(parsed.roomId)
    text(parsed.chatId)
    text(parsed.title, 80)
    return host().renameChat(parsed)
  })

  registerTrustedHandle(CHANNELS.deleteChat, input => {
    const parsed = assertInput(input, ['roomId', 'chatId'])
    text(parsed.roomId)
    text(parsed.chatId)
    return host().deleteChat(parsed)
  })

  registerTrustedHandle(CHANNELS.deleteRoom, input => {
    const parsed = assertInput(input, ['roomId'])
    text(parsed.roomId)
    return host().deleteRoom(parsed)
  })

  registerTrustedHandle(CHANNELS.createRole, input => {
    const parsed = assertInput(input, [
      'roomId', 'chatId', 'displayName', 'provider', 'prompt', 'isCaptain',
      'nativePermission', 'capabilities', 'model', 'responsibilities', 'portrait',
    ])
    text(parsed.roomId)
    text(parsed.chatId)
    text(parsed.displayName)
    text(parsed.provider, 40)
    if (parsed.prompt !== undefined && (typeof parsed.prompt !== 'string' || parsed.prompt.length > 100_000)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.isCaptain !== undefined && typeof parsed.isCaptain !== 'boolean') {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.nativePermission !== undefined) text(parsed.nativePermission, 80)
    if (parsed.capabilities !== undefined) {
      if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length > 16
          || parsed.capabilities.some(item => typeof item !== 'string' || item.length > 200)) {
        throw ipcError('TEAM_ROOM_INPUT_INVALID')
      }
    }
    if (parsed.model !== undefined && parsed.model !== null) text(parsed.model, 120)
    if (parsed.responsibilities !== undefined
        && (typeof parsed.responsibilities !== 'string' || parsed.responsibilities.length > 4000)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.portrait !== undefined) text(parsed.portrait, 40)
    return host().createRole(parsed)
  })

  registerTrustedHandle(CHANNELS.updateRole, input => {
    const parsed = assertInput(input, [
      'roomId', 'roleId', 'displayName', 'provider', 'prompt', 'isCaptain',
      'nativePermission', 'capabilities', 'model', 'responsibilities', 'portrait',
    ])
    text(parsed.roomId)
    text(parsed.roleId)
    if (parsed.displayName !== undefined) text(parsed.displayName)
    if (parsed.provider !== undefined) text(parsed.provider, 40)
    if (parsed.prompt !== undefined && (typeof parsed.prompt !== 'string' || parsed.prompt.length > 100_000)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.isCaptain !== undefined && typeof parsed.isCaptain !== 'boolean') {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.nativePermission !== undefined) text(parsed.nativePermission, 80)
    if (parsed.capabilities !== undefined) {
      if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length > 16
          || parsed.capabilities.some(item => typeof item !== 'string' || item.length > 200)) {
        throw ipcError('TEAM_ROOM_INPUT_INVALID')
      }
    }
    if (parsed.model !== undefined && parsed.model !== null) text(parsed.model, 120)
    if (parsed.responsibilities !== undefined
        && (typeof parsed.responsibilities !== 'string' || parsed.responsibilities.length > 4000)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.portrait !== undefined) text(parsed.portrait, 40)
    return host().updateRole(parsed)
  })

  registerTrustedHandle(CHANNELS.setCaptain, input => {
    const parsed = assertInput(input, ['roomId', 'roleId'])
    text(parsed.roomId)
    text(parsed.roleId)
    return host().setCaptain(parsed)
  })

  registerTrustedHandle(CHANNELS.deleteRole, input => {
    const parsed = assertInput(input, ['roomId', 'roleId'])
    text(parsed.roomId)
    text(parsed.roleId)
    return host().deleteRole(parsed)
  })

  registerTrustedHandle(CHANNELS.answerAttention, input => {
    const parsed = assertInput(input, ['roomId', 'chatId', 'attentionId', 'resolution', 'commandId'])
    text(parsed.roomId)
    text(parsed.chatId)
    text(parsed.attentionId)
    text(parsed.resolution, 4000)
    text(parsed.commandId)
    return host().answerAttention(parsed)
  })

  registerTrustedHandle(CHANNELS.submitMessage, input => {
    const parsed = assertInput(input, ['roomId', 'chatId', 'content', 'clientId'])
    text(parsed.roomId)
    text(parsed.chatId)
    if (typeof parsed.content !== 'string' || parsed.content.length > 100_000) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.clientId !== undefined) text(parsed.clientId)
    return host().submitMessage(parsed)
  })

  registerTrustedHandle(CHANNELS.acceptTask, input => {
    const parsed = assertInput(input, ['roomId', 'taskId', 'commandId'])
    text(parsed.roomId)
    text(parsed.taskId)
    text(parsed.commandId)
    return host().acceptTask(parsed)
  })

  registerTrustedHandle(CHANNELS.stopReply, input => {
    const parsed = assertInput(input, ['roomId', 'replyId'])
    text(parsed.roomId)
    text(parsed.replyId)
    return host().stopReply(parsed)
  })

  registerTrustedHandle(CHANNELS.filesList, input => {
    const parsed = assertInput(input, ['roomId', 'relPath', 'cursor'])
    text(parsed.roomId)
    if (parsed.relPath !== undefined && (typeof parsed.relPath !== 'string' || parsed.relPath.length > 4096)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    if (parsed.cursor !== undefined && (typeof parsed.cursor !== 'string' || parsed.cursor.length > 80)) {
      throw ipcError('TEAM_ROOM_INPUT_INVALID')
    }
    return host().filesList(parsed)
  })

  registerTrustedHandle(CHANNELS.importFiles, async input => {
    const parsed = assertInput(input, ['roomId'])
    text(parsed.roomId)
    if (!dialog?.showOpenDialog) throw ipcError('TEAM_ROOM_INPUT_INVALID')
    const selected = await dialog.showOpenDialog(getMainWindow?.(), {
      properties: ['openFile', 'multiSelections'],
    })
    const sources = selected?.canceled ? [] : (selected?.filePaths || [])
    if (!sources.length) return { files: [] }
    return host().importWorkspaceFiles({ roomId: parsed.roomId, sources })
  })

  registerTrustedHandle(CHANNELS.filesRead, input => {
    const parsed = assertInput(input, ['roomId', 'relPath', 'offset', 'length'])
    text(parsed.roomId)
    text(parsed.relPath, 4096)
    optionalInteger(parsed.offset, { min: 0 })
    optionalInteger(parsed.length, { min: 1, max: 512 * 1024 })
    return host().filesRead(parsed)
  })

  registerTrustedHandle(CHANNELS.writeAuthorized, input => {
    const parsed = assertInput(input, ['roomId', 'authorized'])
    text(parsed.roomId)
    if (typeof parsed.authorized !== 'boolean') throw ipcError('TEAM_ROOM_INPUT_INVALID')
    return host().setWriteAuthorized(parsed)
  })

  registerTrustedHandle(CHANNELS.runtimeEvents, input => {
    const parsed = assertInput(input, ['roomId', 'chatId', 'runId', 'limit'])
    text(parsed.roomId)
    text(parsed.chatId)
    if (parsed.runId !== undefined) text(parsed.runId)
    optionalInteger(parsed.limit, { min: 1, max: 1000 })
    return host().runtimeEvents(parsed)
  })
}

module.exports = { CHANNELS, registerTeamRoomIpc }
