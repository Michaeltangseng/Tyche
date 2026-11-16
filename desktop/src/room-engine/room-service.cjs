const { createMessageIngress } = require('./message-ingress.cjs')
const { createRoomActionService } = require('./room-actions.cjs')
const { createRoomOutbox } = require('./room-outbox.cjs')
const { createReportImporter } = require('./report-importer.cjs')
const { createReportStateService } = require('./report-state.cjs')
const { createSessionSupervisor } = require('./session-supervisor.cjs')
const { createUserCommandService } = require('./user-commands.cjs')
const { createMentionFallback } = require('./mention-fallback.cjs')
const { createAssignmentRunner } = require('./assignment-runner.cjs')
const { createControllerSession } = require('./controller-session.cjs')
const { createControllerQueue } = require('./controller-queue.cjs')
const { createEffectPump } = require('./effect-pump.cjs')
const { createRuntimeRecovery } = require('./runtime-recovery.cjs')
const { createProcessReconciliation } = require('./process-reconciliation.cjs')
const { createControllerBacklog } = require('./controller-backlog.cjs')
const { createHash } = require('node:crypto')

const RETRYABLE_CONTROLLER_ERRORS = new Set([
  'ROOM_CONTROLLER_TIMEOUT', 'ROOM_CONTROLLER_GROUP_NOT_FOUND', 'ROOM_CONTROLLER_CHAT_BUSY',
  'ROOM_CONTROLLER_CONTEXT_STALE', 'ROOM_CONTROLLER_MESSAGES_STALE',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
])

function createRoomService({ roomDb, repository, now, invokeAgent, resolveGroup, decideController, prepareSkillSelections, prepareSkillBindings, controllerBatchDelayMs = 40, heartbeatMs = 30_000, onControllerError = error => console.error('[room-controller]', error), autoRunEffects = false, onEffectError = error => console.error('[room-effects]', error), locale, getInvocationRecords, readArtifactDiff, traceReader, getTraceReader } = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_SERVICE_DEPENDENCIES_REQUIRED')
  const resolveTraceReader = () => (typeof getTraceReader === 'function' ? getTraceReader() : traceReader)
  const ingress = createMessageIngress(roomDb, repository)
  const actions = createRoomActionService({ roomDb, repository })
  const outbox = createRoomOutbox({ roomDb, repository })
  const reports = createReportImporter({ roomDb, repository })
  const reportState = createReportStateService({ roomDb })
  const sessions = createSessionSupervisor({ roomDb, repository, now })
  const reconciliation = typeof getInvocationRecords === 'function'
    ? createProcessReconciliation({ roomDb, repository, supervisor: sessions, getInvocationRecords, locale })
    : null
  const userCommands = createUserCommandService({ roomDb, repository })
  const fallback = createMentionFallback({ roomDb, repository })
  const recovery = createRuntimeRecovery({ roomDb, repository, locale })
  const backlog = createControllerBacklog({ roomDb })
  const blockedControllerChats = new Set()
  const assignmentRunner = invokeAgent && resolveGroup
    ? createAssignmentRunner({
      repository,
      supervisor: sessions,
      invokeAgent,
      resolveGroup,
      importReport,
      prepareSkillSelections,
      locale,
      heartbeatMs,
      withTransaction: roomDb.withTransaction,
    })
    : null
  const controller = typeof decideController === 'function'
    ? createControllerSession({
      roomDb,
      repository,
      applyAction: applyControllerAction,
      decide: decideController,
      now: () => Date.now(),
      fallbackNote: () => (String(locale?.() || '').toLowerCase().startsWith('zh')
        ? '已收到消息；本轮没有需要派发的任务。'
        : 'Message received; no work needed this round.'),
    })
    : null
  const controllerQueue = controller
    ? createControllerQueue({
      processBatch: processControllerBatch,
      getContextRevision: chatId => repository.getChatContext(chatId).revision,
      delayMs: controllerBatchDelayMs,
      shouldRetry: error => RETRYABLE_CONTROLLER_ERRORS.has(error?.code || error?.message),
      onRetryError: error => { if (!closed) onControllerError(error) },
      onSettled: ({ chatId, error, retrying }) => {
        if (error && !retrying) blockedControllerChats.add(chatId)
        recoverControllerInputs()
      },
    })
    : null
  const effectPump = autoRunEffects ? createEffectPump({ runNext: runNextEffect, onError: onEffectError }) : null
  const controlPump = autoRunEffects ? createEffectPump({ runNext: runNextControlEffect, onError: onEffectError }) : null
  let closed = false
  let executionStarted = false

  function controllerAvailable(chatId) {
    return controllerQueue && (typeof decideController.isAvailable !== 'function' || decideController.isAvailable({ chatId }))
  }

  function recoverControllerInputs(input) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    if (!controllerQueue) return 0
    let count = 0
    for (const chat of backlog.chats(input?.chatId || null)) {
      if (blockedControllerChats.has(chat.id)) continue
      const limit = controllerQueue.capacity(chat.id)
      if (!limit || !controllerAvailable(chat.id)) continue
      for (const pending of backlog.list({ chatId: chat.id, limit, excludeKeys: controllerQueue.inputKeys(chat.id) })) {
        queueControllerInput(pending)
        count += 1
      }
    }
    return count
  }

  function queueControllerInput(input) {
    if (!closed && controllerQueue && !blockedControllerChats.has(input.chatId)) {
      controllerQueue.enqueue(input).catch(error => {
        if (!closed && error.message !== 'ROOM_CONTROLLER_QUEUE_FULL') onControllerError(error)
      })
    }
  }

  function wakeController(chatId, eventId) {
    queueControllerInput({ chatId, eventId })
  }

  async function processControllerBatch(input) {
    if (input.batchId && repository.getControllerDecision({ chatId: input.chatId, batchId: input.batchId })) return controller.process(input)
    const pending = backlog.filter(input)
    if (((input.messageIds?.length || 0) + (input.triggerEventIds?.length || 0)) > 0
        && pending.messageIds.length + pending.triggerEventIds.length === 0) {
      return { duplicate: true, decision: null }
    }
    const result = await controller.process(pending)
    if (!result.duplicate) {
      for (const action of result.decision.results) {
        if (action.taskId || action.roleId || action.context) wakeController(input.chatId, action.event.eventId)
      }
    }
    return result
  }

  function enqueueAssignment(assignmentId, chatId, actionId = null) {
    const assignment = repository.getAssignmentContext(assignmentId)
    return outbox.enqueue({
      chatId, actionId, kind: 'start_assignment',
      payload: { assignmentId, prompt: assignment?.objective || '' },
      idempotencyKey: `start-assignment:${assignmentId}`,
    })
  }

  function submitMessage(input, { deterministicFallback = true } = {}) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    const result = ingress.submit(input)
    let dispatch = null
    if (controllerAvailable(input.chatId)) {
      queueControllerInput({ chatId: input.chatId, messageId: result.message.messageId })
    } else if (deterministicFallback && input.author?.type === 'user' && result.mentions.length > 0) {
      dispatch = roomDb.withTransaction(() => {
        const dispatched = fallback.dispatch({
          chatId: input.chatId,
          messageId: result.message.messageId,
          content: input.content,
          mentions: result.mentions,
          createdBy: input.author.id,
        })
        for (const assignmentId of dispatched.assignmentIds) enqueueAssignment(assignmentId, input.chatId)
        return dispatched
      })
      effectPump?.request()
    }
    return { ...result, dispatch }
  }

  function importReport(input) {
    const result = roomDb.withTransaction(() => {
      const imported = reports.importFromMessage(input)
      if (imported.report) imported.state = reportState.reconcileTask(input.taskId)
      return imported
    })
    if (result.imported) wakeController(input.chatId, result.event.eventId)
    return result
  }

  function bootstrap(input = {}) {
    const roomId = input.roomId
    const chatId = input.chatId
    const createdBy = typeof input.createdBy === 'string' && input.createdBy ? input.createdBy : 'user'
    return roomDb.withTransaction(() => {
      const createdRoomId = repository.createRoom({
        roomId,
        name: input.name,
        workspace: input.workspace,
        providers: input.providers,
        allowedCapabilities: input.allowedCapabilities,
      })
      const createdChatId = repository.createChat({
        chatId,
        roomId: createdRoomId,
        title: input.title || input.name,
        isPrimary: true,
        engineVersion: 'v2',
      })
      repository.appendEvent({
        roomId: createdRoomId,
        chatId: createdChatId,
        actorId: createdBy,
        type: 'chat_bootstrapped',
        payload: { engineVersion: 'v2' },
      })
      return { roomId: createdRoomId, chatId: createdChatId }
    })
  }

  function snapshot(input = {}) {
    if (typeof input.roomId !== 'string' || input.roomId.length === 0) throw new TypeError('ROOM_ID_INVALID')
    const result = repository.getRoomSnapshot(input.roomId, { messageLimit: 100 })
    return { ...result, chats: result.chats.map(chat => ({
      ...chat,
      controller_blocked: blockedControllerChats.has(chat.id),
    })) }
  }

  function listChatMessages({ roomId, chatId, beforeSequence = null, limit = 100 } = {}) {
    if (typeof roomId !== 'string' || !roomId || typeof chatId !== 'string' || !chatId) throw new TypeError('ROOM_MESSAGE_PAGE_INPUT_INVALID')
    const chat = repository.getChat(chatId)
    if (!chat || chat.room_id !== roomId) throw new Error('ROOM_CHAT_NOT_FOUND')
    if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) throw new TypeError('ROOM_MESSAGE_CURSOR_INVALID')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('ROOM_MESSAGE_LIMIT_INVALID')
    return repository.listMessagesPage(chatId, { beforeSequence, limit })
  }

  function assignmentTrace({ roomId, assignmentId, cursor, direction = 'forward', limit = 50 } = {}) {
    const reader = resolveTraceReader()
    if (!reader || typeof reader.page !== 'function') throw new Error('ROOM_TRACE_UNAVAILABLE')
    const assignment = repository.getAssignmentContext(assignmentId)
    if (!assignment || assignment.room_id !== roomId || !assignment.run_id) throw new Error('ROOM_TRACE_NOT_FOUND')
    const agentRunId = roomAgentRunId(assignment)
    try {
      return reader.page({
        runId: assignment.run_id,
        agentRunId,
        cursor,
        direction,
        limit,
      })
    } catch (error) {
      if (error?.code === 'TRACE_NOT_FOUND') throw new Error('ROOM_TRACE_NOT_FOUND')
      throw error
    }
  }

  function roomAgentRunId(assignment) {
    const identity = createHash('sha256').update(JSON.stringify([
      assignment.room_id, assignment.chat_id, assignment.provider, assignment.run_id,
    ])).digest('hex')
    return `room-agent-${identity}`
  }

  function assignmentTraceBlob({ roomId, assignmentId, blobId, offset = 0, length = 256 * 1024 } = {}) {
    const reader = resolveTraceReader()
    if (!reader || typeof reader.blob !== 'function') throw new Error('ROOM_TRACE_UNAVAILABLE')
    const assignment = repository.getAssignmentContext(assignmentId)
    if (!assignment || assignment.room_id !== roomId || !assignment.run_id) throw new Error('ROOM_TRACE_NOT_FOUND')
    try {
      return reader.blob({ runId: assignment.run_id, agentRunId: roomAgentRunId(assignment), blobId, offset, length })
    } catch (error) {
      if (error?.code === 'TRACE_NOT_FOUND') throw new Error('ROOM_TRACE_NOT_FOUND')
      throw error
    }
  }

  function authorizeTrace({ runId, agentRunId } = {}) {
    if (!runId || !agentRunId) return false
    const assignment = repository.getAssignmentByRunId(runId)
    if (!assignment) return false
    return agentRunId === roomAgentRunId(assignment)
  }

  function createChat(input) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    return roomDb.withTransaction(() => {
      if (!repository.getRoom(input.roomId)) throw new Error('ROOM_NOT_FOUND')
      const chatId = repository.createChat({ roomId: input.roomId, title: input.title, engineVersion: 'v2' })
      repository.appendEvent({ roomId: input.roomId, chatId, actorId: 'user', type: 'chat_created', payload: {} })
      return { roomId: input.roomId, chatId }
    })
  }

  function hasActiveAssignments({ chatId = null, roomId = null }) {
    const sql = chatId
      ? `SELECT a.id FROM assignments a JOIN tasks t ON t.id = a.task_id
          WHERE t.chat_id = ? AND (a.status IN ('queued', 'running') OR a.outcome = 'unknown') LIMIT 1`
      : `SELECT a.id FROM assignments a JOIN tasks t ON t.id = a.task_id
          JOIN chats c ON c.id = t.chat_id
          WHERE c.room_id = ? AND (a.status IN ('queued', 'running') OR a.outcome = 'unknown') LIMIT 1`
    return Boolean(roomDb.database.prepare(sql).get(chatId || roomId))
  }

  function deleteChat(input = {}) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    return roomDb.withTransaction(() => {
      const chat = repository.getChat(input.chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      if (input.roomId && input.roomId !== chat.room_id) throw new Error('ROOM_CHAT_ROOM_MISMATCH')
      if (hasActiveAssignments({ chatId: chat.id })) throw new Error('ROOM_CHAT_DELETE_BUSY')
      let promotedChatId = null
      if (chat.is_primary) {
        const remaining = roomDb.database.prepare(`SELECT id FROM chats
          WHERE room_id = ? AND id <> ? ORDER BY created_at, id LIMIT 1`).get(chat.room_id, chat.id)
        if (!remaining) throw new Error('ROOM_PRIMARY_CHAT_UNDELETABLE')
        promotedChatId = remaining.id
      }
      repository.deleteChat(chat.id)
      if (promotedChatId) repository.setPrimaryChat(chat.room_id, promotedChatId)
      roomDb.database.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), chat.room_id)
      repository.appendEvent({
        roomId: chat.room_id,
        chatId: null,
        actorId: 'user',
        type: 'chat_deleted',
        payload: { chatId: chat.id, title: chat.title, promotedChatId },
      })
      blockedControllerChats.delete(chat.id)
      return { roomId: chat.room_id, chatId: chat.id, promotedChatId }
    })
  }

  function deleteRoom(input = {}) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    return roomDb.withTransaction(() => {
      const room = repository.getRoom(input.roomId)
      if (!room) throw new Error('ROOM_NOT_FOUND')
      if (hasActiveAssignments({ roomId: room.id })) throw new Error('ROOM_ROOM_DELETE_BUSY')
      const chats = repository.listChats(room.id)
      repository.deleteRoom(room.id)
      for (const chat of chats) blockedControllerChats.delete(chat.id)
      return { roomId: room.id, deleted: true }
    })
  }

  function applyControllerAction(input, options) {
    return roomDb.withTransaction(() => {
      const result = actions.applyController(input, options)
      if (result.assignmentId) {
        enqueueAssignment(result.assignmentId, input.chatId, result.event?.eventId || null)
        effectPump?.request()
      }
      return result
    })
  }

  function applyUserCommand(input, options) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    const result = roomDb.withTransaction(() => {
      if (['retry_task', 'handoff_task'].includes(input.type)) reconciliation?.reconcile({ assignmentId: input.assignmentId })
      const applied = userCommands.apply(input, options)
      if (applied.assignmentId) enqueueAssignment(applied.assignmentId, input.chatId, applied.event.eventId)
      for (const assignment of applied.stopAssignments || []) {
        outbox.enqueue({ chatId: input.chatId, actionId: applied.event.eventId,
          kind: 'stop_assignment', payload: assignment,
          idempotencyKey: `stop-assignment:${assignment.assignmentId}:${assignment.runId}` })
      }
      return applied
    })
    if (input.type === 'resume_chat') blockedControllerChats.delete(input.chatId)
    if (input.type === 'resume_chat' || result.assignmentId) effectPump?.request()
    if (input.type === 'stop_task') controlPump?.request()
    if (!result.duplicate && input.type !== 'pause_chat') wakeController(input.chatId, result.event.eventId)
    if (input.type === 'resume_chat') recoverControllerInputs({ chatId: input.chatId })
    return result
  }

  async function updateSkillBindings({ chatId, roleId = null, selections = [], inheritChat = false }) {
    const chat = repository.getChat(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    if (typeof inheritChat !== 'boolean' || (inheritChat && !roleId)) throw new TypeError('ROOM_SKILL_BINDINGS_INVALID')
    const room = repository.getRoomSnapshot(chat.room_id).room
    let provider = null
    if (roleId) {
      const role = roomDb.database.prepare('SELECT provider FROM agent_roles WHERE id = ? AND chat_id = ?').get(roleId, chatId)
      if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
      provider = role.provider
    }
    if (!inheritChat && typeof prepareSkillBindings !== 'function') throw new Error('ROOM_SKILL_BINDINGS_UNAVAILABLE')
    const prepared = inheritChat ? null : await prepareSkillBindings({ selections, provider, allowedProviders: room.providers_json || [] })
    const saved = roomDb.withTransaction(() => {
      const skillBindings = roleId
        ? repository.setRoleSkillBindings({ roleId, skillBindings: prepared })
        : repository.setChatSkillBindings({ chatId, skillBindings: prepared })
      const event = repository.appendEvent({ roomId: chat.room_id, chatId, actorId: 'user',
        type: roleId ? 'user_role_skill_bindings_updated' : 'user_chat_skill_bindings_updated',
        payload: { roleId, inheritChat, skillBindings: skillBindings?.map(({ targetKind, namespace, slug, name, snapshotId, manifestHash }) => ({ targetKind, namespace, slug, name, snapshotId, manifestHash })) ?? null } })
      return { chatId, roleId, inheritChat, skillBindings: skillBindings?.map(({ targetKind, namespace, slug, name, snapshotId, manifestHash }) => ({ targetKind, namespace, slug, name, snapshotId, manifestHash })) ?? null, event }
    })
    return saved
  }

  async function runNextEffect({ signal } = {}) {
    executionStarted = true
    return outbox.runOnce(async effect => {
      if (effect.kind === 'start_assignment') {
        if (!assignmentRunner) throw new Error('ROOM_ASSIGNMENT_RUNNER_UNAVAILABLE')
        const run = assignmentRunner.start({ ...effect.payload, signal })
        return run.promise
      }
      throw Object.assign(new Error('ROOM_EFFECT_HANDLER_MISSING'), {
        code: 'ROOM_EFFECT_HANDLER_MISSING',
        effectKind: effect.kind,
      })
    }, { kind: 'start_assignment' })
  }

  async function runNextControlEffect() {
    executionStarted = true
    return outbox.runOnce(async effect => {
      if (!assignmentRunner) throw new Error('ROOM_ASSIGNMENT_RUNNER_UNAVAILABLE')
      return assignmentRunner.stop(effect.payload)
    }, { kind: 'stop_assignment', includePaused: true })
  }

  return {
    bootstrap,
    listRooms: () => repository.listRooms(),
    createChat,
    deleteChat,
    deleteRoom,
    snapshot,
    listChatMessages,
    artifactDiff: input => {
      if (closed) throw new Error('ROOM_SERVICE_CLOSED')
      if (typeof readArtifactDiff !== 'function') throw new Error('ROOM_ARTIFACT_DIFF_UNAVAILABLE')
      return readArtifactDiff(input)
    },
    startAssignment: input => {
      if (closed) throw new Error('ROOM_SERVICE_CLOSED')
      if (!assignmentRunner) throw new Error('ROOM_ASSIGNMENT_RUNNER_UNAVAILABLE')
      executionStarted = true
      return assignmentRunner.start(input)
    },
    submitMessage,
    editMessage: ingress.edit,
    deleteMessage: ingress.remove,
    applyControllerAction,
    applyUserCommand,
    updateSkillBindings,
    importReport,
    sessionStarted: sessions.started,
    sessionLiveness: sessions.liveness,
    sessionExited: sessions.exited,
    listStaleAssignments: sessions.listStale,
    assignmentTrace,
    assignmentTraceBlob,
    authorizeTrace,
    enqueueEffect: outbox.enqueue,
    runEffectOnce: outbox.runOnce,
    runNextEffect,
    runNextControlEffect,
    processControllerBatch: input => {
      if (!controller) throw new Error('ROOM_CONTROLLER_UNAVAILABLE')
      return processControllerBatch(input)
    },
    flushController: chatId => controllerQueue ? controllerQueue.flush(chatId) : Promise.resolve(null),
    startRuntime: () => {
      blockedControllerChats.clear()
      recoverControllerInputs()
      return Promise.all([effectPump?.request(), controlPump?.request()])
    },
    recoverRuntime: () => {
      if (closed || executionStarted) throw new Error('ROOM_RECOVERY_REQUIRES_STARTUP')
      return recovery.recover()
    },
    reconcileProcesses: input => reconciliation ? reconciliation.reconcile(input) : { resolvedAssignmentIds: [], unresolvedAssignmentIds: [] },
    close: async () => {
      closed = true
      await Promise.all([controllerQueue?.close(), effectPump?.close(), controlPump?.close(), assignmentRunner?.close()])
    },
    retryUnknownEffect: outbox.retryUnknown,
    repository,
  }
}

module.exports = { createRoomService }
