const CONTROLLER_TYPES = new Set([
  'create_task', 'assign', 'request_attention', 'update_context', 'create_role',
  'archive_role', 'note', 'propose_stop', 'propose_retry',
])
const USER_TYPES = new Set([
  'stop_task', 'retry_task', 'handoff_task', 'accept_artifact', 'reject_artifact',
  'answer_attention', 'pause_chat', 'resume_chat', 'archive_chat', 'restore_context',
])
const PLATFORM_TYPES = new Set([
  'session_started', 'session_liveness', 'session_exited', 'report_received', 'effect_updated',
])

const FIELDS = Object.freeze({
  controller: {
    create_task: ['type', 'chatId', 'contextRevision', 'objective', 'kind', 'sourceMessageIds', 'blockedByTaskIds', 'requiredArtifactIds', 'optional', 'parentTaskId', 'inputs'],
    assign: ['type', 'chatId', 'contextRevision', 'taskId', 'roleId', 'required', 'writeScopes'],
    request_attention: ['type', 'chatId', 'contextRevision', 'taskId', 'attentionType', 'question', 'options'],
    update_context: ['type', 'chatId', 'contextRevision', 'changes'],
    create_role: ['type', 'chatId', 'contextRevision', 'displayName', 'responsibilities', 'capabilities', 'provider', 'creationReason'],
    archive_role: ['type', 'chatId', 'contextRevision', 'roleId'],
    note: ['type', 'chatId', 'contextRevision', 'content'],
    propose_stop: ['type', 'chatId', 'contextRevision', 'taskId', 'reason'],
    propose_retry: ['type', 'chatId', 'contextRevision', 'taskId', 'reason'],
  },
  user: {
    stop_task: ['type', 'chatId', 'taskId', 'reason'],
    retry_task: ['type', 'chatId', 'taskId', 'reason'],
    handoff_task: ['type', 'chatId', 'taskId', 'roleId', 'reason'],
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
  if (expectedChatId !== null && action.chatId !== expectedChatId) throw new Error('ROOM_ACTION_CHAT_MISMATCH')
  if (kind === 'controller') {
    if (!Number.isInteger(action.contextRevision) || action.contextRevision < 0) throw new TypeError('ROOM_ACTION_CONTEXT_REVISION_INVALID')
    if (expectedContextRevision !== null && action.contextRevision !== expectedContextRevision) throw new Error('ROOM_ACTION_CONTEXT_STALE')
    if (action.type === 'update_context' && !isRecord(action.changes)) throw new TypeError('ROOM_ACTION_CONTEXT_CHANGES_INVALID')
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

  function applyController(action, { actorId = 'controller', contextRevision = null } = {}) {
    const validated = validateControllerAction(action, { contextRevision })
    return roomDb.withTransaction(() => {
      let result
      if (validated.type === 'create_task') result = { taskId: repository.createTask({ ...validated, createdBy: actorId, contextRevision: validated.contextRevision }) }
      else if (validated.type === 'assign') result = { assignmentId: repository.createAssignment(validated) }
      else if (validated.type === 'create_role') result = { roleId: repository.createAgentRole({ ...validated, createdBy: actorId }) }
      else if (validated.type === 'request_attention') result = { attentionId: repository.createAttention({ ...validated, type: validated.attentionType, requestedBy: actorId }) }
      else if (validated.type === 'update_context') result = { context: repository.createChatContextRevision({ chatId: validated.chatId, instructions: typeof validated.changes?.instructions === 'string' ? validated.changes.instructions : '', changes: validated.changes, createdBy: actorId }) }
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
