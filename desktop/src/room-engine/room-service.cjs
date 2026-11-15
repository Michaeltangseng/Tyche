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

function createRoomService({ roomDb, repository, now, invokeAgent, resolveGroup, decideController } = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_SERVICE_DEPENDENCIES_REQUIRED')
  const ingress = createMessageIngress(roomDb, repository)
  const actions = createRoomActionService({ roomDb, repository })
  const outbox = createRoomOutbox({ roomDb, repository })
  const reports = createReportImporter({ roomDb, repository })
  const reportState = createReportStateService({ roomDb })
  const sessions = createSessionSupervisor({ roomDb, repository, now })
  const userCommands = createUserCommandService({ roomDb, repository })
  const fallback = createMentionFallback({ roomDb, repository })
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
    ? createControllerSession({ roomDb, repository, applyAction: actions.applyController, decide: decideController, now: () => Date.now() })
    : null

  function submitMessage(input, { deterministicFallback = true } = {}) {
    const result = ingress.submit(input)
    let dispatch = null
    if (deterministicFallback && input.author?.type === 'user' && result.mentions.length > 0) {
      dispatch = fallback.dispatch({
        chatId: input.chatId,
        messageId: result.message.messageId,
        content: input.content,
        mentions: result.mentions,
        createdBy: input.author.id,
      })
    }
    return { ...result, dispatch }
  }

  function importReport(input) {
    const result = reports.importFromMessage(input)
    if (result.report) result.state = reportState.reconcileTask(input.taskId)
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
    const result = actions.applyController(input, options)
    if (result.assignmentId) {
      const assignment = repository.getAssignmentContext(result.assignmentId)
      outbox.enqueue({
        chatId: input.chatId,
        actionId: result.event?.eventId || null,
        kind: 'start_assignment',
        payload: { assignmentId: result.assignmentId, prompt: assignment?.objective || '' },
        idempotencyKey: `start-assignment:${result.assignmentId}`,
      })
    }
    return result
  }

  async function runNextEffect() {
    return outbox.runOnce(async effect => {
      if (effect.kind === 'start_assignment') {
        if (!assignmentRunner) throw new Error('ROOM_ASSIGNMENT_RUNNER_UNAVAILABLE')
        const run = assignmentRunner.start(effect.payload)
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
      return assignmentRunner.start(input)
    },
    submitMessage,
    editMessage: ingress.edit,
    deleteMessage: ingress.remove,
    applyControllerAction,
    applyUserCommand: userCommands.apply,
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
      return controller.process(input)
    },
    retryUnknownEffect: outbox.retryUnknown,
    repository,
  }
}

module.exports = { createRoomService }
