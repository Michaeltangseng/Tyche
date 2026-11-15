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

function createRoomService({ roomDb, repository, now, invokeAgent, resolveGroup, decideController, controllerBatchDelayMs = 40, onControllerError = error => console.error('[room-controller]', error), autoRunEffects = false, onEffectError = error => console.error('[room-effects]', error), locale, getInvocationRecords } = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_SERVICE_DEPENDENCIES_REQUIRED')
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
  const assignmentRunner = invokeAgent && resolveGroup
    ? createAssignmentRunner({
      repository,
      supervisor: sessions,
      invokeAgent,
      resolveGroup,
      importReport,
    })
    : null
  const controller = typeof decideController === 'function'
    ? createControllerSession({ roomDb, repository, applyAction: applyControllerAction, decide: decideController, now: () => Date.now() })
    : null
  const controllerQueue = controller
    ? createControllerQueue({
      processBatch: processControllerBatch,
      getContextRevision: chatId => repository.getChatContext(chatId).revision,
      delayMs: controllerBatchDelayMs,
    })
    : null
  const effectPump = autoRunEffects ? createEffectPump({ runNext: runNextEffect, onError: onEffectError }) : null
  let closed = false
  let executionStarted = false

  function controllerAvailable(chatId) {
    return controllerQueue && (typeof decideController.isAvailable !== 'function' || decideController.isAvailable({ chatId }))
  }

  function recoverControllerInputs(input) {
    if (closed) throw new Error('ROOM_SERVICE_CLOSED')
    if (!controllerQueue) return 0
    let count = 0
    for (const pending of backlog.list(input)) {
      if (!controllerAvailable(pending.chatId)) continue
      controllerQueue.enqueue(pending).catch(error => { if (!closed) onControllerError(error) })
      count += 1
    }
    return count
  }

  function wakeController(chatId, eventId) {
    if (!closed && controllerQueue) controllerQueue.enqueue({ chatId, eventId }).catch(error => { if (!closed) onControllerError(error) })
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
        if (action.taskId || action.roleId) wakeController(input.chatId, action.event.eventId)
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
      controllerQueue.enqueue({ chatId: input.chatId, messageId: result.message.messageId }).catch(error => { if (!closed) onControllerError(error) })
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
    return repository.getRoomSnapshot(input.roomId)
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
    const result = roomDb.withTransaction(() => {
      if (['retry_task', 'handoff_task'].includes(input.type)) reconciliation?.reconcile({ assignmentId: input.assignmentId })
      const applied = userCommands.apply(input, options)
      if (applied.assignmentId) enqueueAssignment(applied.assignmentId, input.chatId, applied.event.eventId)
      return applied
    })
    if (input.type === 'resume_chat' || result.assignmentId) effectPump?.request()
    if (!result.duplicate && input.type !== 'pause_chat') wakeController(input.chatId, result.event.eventId)
    if (input.type === 'resume_chat') recoverControllerInputs({ chatId: input.chatId })
    return result
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
    })
  }

  return {
    bootstrap,
    snapshot,
    startAssignment: input => {
      if (!assignmentRunner) throw new Error('ROOM_ASSIGNMENT_RUNNER_UNAVAILABLE')
      executionStarted = true
      return assignmentRunner.start(input)
    },
    submitMessage,
    editMessage: ingress.edit,
    deleteMessage: ingress.remove,
    applyControllerAction,
    applyUserCommand,
    importReport,
    sessionStarted: sessions.started,
    sessionLiveness: sessions.liveness,
    sessionExited: sessions.exited,
    listStaleAssignments: sessions.listStale,
    enqueueEffect: outbox.enqueue,
    runEffectOnce: outbox.runOnce,
    runNextEffect,
    processControllerBatch: input => {
      if (!controller) throw new Error('ROOM_CONTROLLER_UNAVAILABLE')
      return processControllerBatch(input)
    },
    flushController: chatId => controllerQueue ? controllerQueue.flush(chatId) : Promise.resolve(null),
    startRuntime: () => {
      recoverControllerInputs()
      return effectPump ? effectPump.request() : Promise.resolve()
    },
    recoverRuntime: () => {
      if (closed || executionStarted) throw new Error('ROOM_RECOVERY_REQUIRES_STARTUP')
      return recovery.recover()
    },
    reconcileProcesses: input => reconciliation ? reconciliation.reconcile(input) : { resolvedAssignmentIds: [], unresolvedAssignmentIds: [] },
    close: async () => {
      closed = true
      await Promise.all([controllerQueue?.close(), effectPump?.close()])
    },
    retryUnknownEffect: outbox.retryUnknown,
    repository,
  }
}

module.exports = { createRoomService }
