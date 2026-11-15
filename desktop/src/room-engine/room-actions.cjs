const CONTROLLER_TYPES = new Set([
  'create_task', 'assign', 'request_attention', 'update_context', 'create_role',
  'update_role_prompt', 'note', 'propose_stop', 'propose_retry',
])
const USER_TYPES = new Set([
  'stop_task', 'retry_task', 'handoff_task', 'accept_artifact', 'reject_artifact',
  'answer_attention', 'pause_chat', 'resume_chat', 'archive_chat', 'restore_context',
  'set_workspace_write',
])
const PLATFORM_TYPES = new Set([
  'session_started', 'session_liveness', 'session_exited', 'report_received', 'effect_updated',
])

const FIELDS = Object.freeze({
  controller: {
    create_task: ['type', 'chatId', 'contextRevision', 'objective', 'kind', 'sourceMessageIds', 'blockedByTaskIds', 'requiredArtifactIds', 'optional', 'parentTaskId', 'inputs'],
    assign: ['type', 'chatId', 'contextRevision', 'taskId', 'roleId', 'required', 'writeScopes'],
    request_attention: ['type', 'chatId', 'contextRevision', 'taskId', 'attentionType', 'question', 'options'],
    update_context: ['type', 'chatId', 'contextRevision', 'instructions', 'sourceMessageIds'],
    create_role: ['type', 'chatId', 'contextRevision', 'displayName', 'responsibilities', 'capabilities', 'provider', 'creationReason'],
    update_role_prompt: ['type', 'chatId', 'contextRevision', 'roleId', 'prompt'],
    note: ['type', 'chatId', 'contextRevision', 'content'],
    propose_stop: ['type', 'chatId', 'contextRevision', 'taskId', 'reason'],
    propose_retry: ['type', 'chatId', 'contextRevision', 'taskId', 'reason'],
  },
  user: {
    set_workspace_write: ['type', 'chatId', 'allowWrite', 'commandId'],
    stop_task: ['type', 'chatId', 'taskId', 'commandId', 'reason'],
    retry_task: ['type', 'chatId', 'taskId', 'assignmentId', 'commandId', 'reason'],
    handoff_task: ['type', 'chatId', 'taskId', 'assignmentId', 'commandId', 'roleId', 'reason'],
    accept_artifact: ['type', 'chatId', 'artifactId'],
    reject_artifact: ['type', 'chatId', 'artifactId', 'reason'],
    answer_attention: ['type', 'chatId', 'attentionId', 'optionId', 'comment'],
    pause_chat: ['type', 'chatId'],
    resume_chat: ['type', 'chatId'],
    archive_chat: ['type', 'chatId'],
    restore_context: ['type', 'chatId', 'contextRevision'],
  },
  platform: {
    session_started: ['type', 'chatId', 'assignmentId', 'runId'],
    session_liveness: ['type', 'chatId', 'assignmentId', 'observedAt', 'state'],
    session_exited: ['type', 'chatId', 'assignmentId', 'runId', 'exitCode', 'reason'],
    report_received: ['type', 'chatId', 'taskId', 'assignmentId', 'reportId', 'reportKind'],
    effect_updated: ['type', 'chatId', 'effectId', 'status', 'attempt'],
  },
})

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function assertRecord(action, error = 'ROOM_ACTION_INVALID') {
  if (!isRecord(action)) throw new TypeError(error)
}

function assertString(value, error) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100_000) throw new TypeError(error)
}

function assertId(value, field) { assertString(value, `ROOM_ACTION_${field.toUpperCase()}_INVALID`) }

function normalize(action, kind, expectedChatId = null, expectedContextRevision = null) {
  assertRecord(action)
  const allowedTypes = kind === 'controller' ? CONTROLLER_TYPES : kind === 'user' ? USER_TYPES : PLATFORM_TYPES
  if (!allowedTypes.has(action.type)) throw new TypeError(`ROOM_${kind.toUpperCase()}_ACTION_TYPE_INVALID`)
  const fields = FIELDS[kind][action.type]
  for (const key of Object.keys(action)) {
    if (!fields.includes(key)) throw new TypeError('ROOM_ACTION_UNKNOWN_FIELD')
  }
  assertId(action.chatId, 'chat_id')
  if (kind === 'user' && action.type === 'set_workspace_write') {
    if (typeof action.allowWrite !== 'boolean') throw new TypeError('ROOM_ACTION_ALLOW_WRITE_INVALID')
    assertId(action.commandId, 'command_id')
  }
  if (kind === 'user' && ['retry_task', 'handoff_task'].includes(action.type)) {
    for (const field of ['taskId', 'assignmentId', 'commandId']) assertId(action[field], field)
    if (action.type === 'handoff_task') assertId(action.roleId, 'role_id')
    if (action.reason !== undefined) assertString(action.reason, 'ROOM_ACTION_REASON_INVALID')
  }
  if (kind === 'user' && action.type === 'stop_task') {
    for (const field of ['taskId', 'commandId']) assertId(action[field], field)
    if (action.reason !== undefined) assertString(action.reason, 'ROOM_ACTION_REASON_INVALID')
  }
  if (expectedChatId !== null && action.chatId !== expectedChatId) throw new Error('ROOM_ACTION_CHAT_MISMATCH')
  if (kind === 'controller') {
    if (!Number.isInteger(action.contextRevision) || action.contextRevision < 0) throw new TypeError('ROOM_ACTION_CONTEXT_REVISION_INVALID')
    if (expectedContextRevision !== null && action.contextRevision !== expectedContextRevision) throw new Error('ROOM_ACTION_CONTEXT_STALE')
    if (action.type === 'update_context') {
      assertString(action.instructions, 'ROOM_ACTION_CONTEXT_INSTRUCTIONS_INVALID')
      if (!action.instructions.trim()) throw new TypeError('ROOM_ACTION_CONTEXT_INSTRUCTIONS_INVALID')
      if (!Array.isArray(action.sourceMessageIds) || !action.sourceMessageIds.length || action.sourceMessageIds.length > 32) {
        throw new TypeError('ROOM_ACTION_CONTEXT_SOURCES_INVALID')
      }
      for (const id of action.sourceMessageIds) assertId(id, 'source_message_id')
    }
    if (action.type === 'update_role_prompt') assertId(action.roleId, 'role_id')
    if (action.type === 'update_role_prompt') assertString(action.prompt, 'ROOM_ACTION_PROMPT_INVALID')
  }
  return Object.freeze({ ...action })
}

function validateControllerAction(action, options = {}) {
  return normalize(action, 'controller', options.chatId ?? null, options.contextRevision ?? null)
}

function validateUserCommand(action, options = {}) {
  return normalize(action, 'user', options.chatId ?? null)
}

function validatePlatformTransition(action, options = {}) {
  return normalize(action, 'platform', options.chatId ?? null)
}

function createRoomActionService({ roomDb, repository }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) throw new TypeError('ROOM_ACTION_SERVICE_DEPENDENCIES_REQUIRED')

  function recordEvent(action, actorId, type = `action_${action.type}`) {
    const chat = roomDb.database.prepare('SELECT room_id FROM chats WHERE id = ?').get(action.chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    return repository.appendEvent({ roomId: chat.room_id, chatId: action.chatId, actorId, type, payload: action })
  }

  function applyController(action, { actorId = 'controller', contextRevision = null, userMessageIds = [] } = {}) {
    const validated = validateControllerAction(action, { contextRevision })
    return roomDb.withTransaction(() => {
      if (repository.getChatContext(validated.chatId).revision !== validated.contextRevision) throw new Error('ROOM_ACTION_CONTEXT_STALE')
      let result
      if (validated.type === 'create_task') result = { taskId: repository.createTask({ ...validated, createdBy: actorId, contextRevision: validated.contextRevision }) }
      else if (validated.type === 'assign') {
        if (repository.getTask(validated.taskId)?.status === 'cancelled') throw new Error('ROOM_TASK_CANCELLED')
        result = { assignmentId: repository.createAssignment(validated) }
      }
      else if (validated.type === 'create_role') {
        const chat = roomDb.database.prepare('SELECT room_id FROM chats WHERE id = ?').get(validated.chatId)
        const room = roomDb.database.prepare('SELECT providers_json, allowed_capabilities_json FROM rooms WHERE id = ?').get(chat?.room_id)
        const providers = JSON.parse(room?.providers_json || '[]')
        const capabilities = JSON.parse(room?.allowed_capabilities_json || '[]')
        if (providers.length > 0 && !providers.includes(validated.provider)) throw new Error('ROOM_ROLE_PROVIDER_NOT_ALLOWED')
        if (capabilities.length > 0 && (validated.capabilities || []).some(capability => !capabilities.includes(capability))) {
          throw new Error('ROOM_ROLE_CAPABILITY_NOT_ALLOWED')
        }
        result = { roleId: repository.createAgentRole({ ...validated, createdBy: actorId }) }
      }
      else if (validated.type === 'request_attention') result = { attentionId: repository.createAttention({ ...validated, type: validated.attentionType, requestedBy: actorId }) }
      else if (validated.type === 'update_context') {
        for (const id of validated.sourceMessageIds) {
          const message = repository.getMessage(id)
          if (!userMessageIds.includes(id) || !message || message.chat_id !== validated.chatId
              || message.author_type !== 'user' || message.deleted_at) throw new Error('ROOM_CONTEXT_USER_SOURCE_REQUIRED')
        }
        result = { context: repository.createChatContextRevision({ chatId: validated.chatId,
          instructions: validated.instructions, changes: { sourceMessageIds: [...new Set(validated.sourceMessageIds)] }, createdBy: actorId }) }
      }
      else if (validated.type === 'update_role_prompt') {
        const role = roomDb.database.prepare('SELECT id FROM agent_roles WHERE id = ? AND chat_id = ?').get(validated.roleId, validated.chatId)
        if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
        result = { roleId: validated.roleId, prompt: repository.createRolePromptRevision({ roleId: validated.roleId, prompt: validated.prompt, createdBy: actorId }) }
      }
      else result = {}
      return { ...result, event: recordEvent(validated, actorId) }
    })
  }

  return { applyController, validateControllerAction, validateUserCommand, validatePlatformTransition }
}

module.exports = {
  CONTROLLER_TYPES, USER_TYPES, PLATFORM_TYPES,
  createRoomActionService, validateControllerAction, validateUserCommand, validatePlatformTransition,
}
