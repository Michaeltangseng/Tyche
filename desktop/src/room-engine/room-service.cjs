const { createMessageIngress } = require('./message-ingress.cjs')
const { createRoomActionService } = require('./room-actions.cjs')
const { createRoomOutbox } = require('./room-outbox.cjs')
const { createReportImporter } = require('./report-importer.cjs')
const { createReportStateService } = require('./report-state.cjs')
const { createSessionSupervisor } = require('./session-supervisor.cjs')
const { createUserCommandService } = require('./user-commands.cjs')
const { createMentionFallback } = require('./mention-fallback.cjs')

function createRoomService({ roomDb, repository, now } = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_SERVICE_DEPENDENCIES_REQUIRED')
  const ingress = createMessageIngress(roomDb, repository)
  const actions = createRoomActionService({ roomDb, repository })
  const outbox = createRoomOutbox({ roomDb, repository })
  const reports = createReportImporter({ roomDb, repository })
  const reportState = createReportStateService({ roomDb })
  const sessions = createSessionSupervisor({ roomDb, repository, now })
  const userCommands = createUserCommandService({ roomDb, repository })
  const fallback = createMentionFallback({ roomDb, repository })

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

  return {
    submitMessage,
    editMessage: ingress.edit,
    deleteMessage: ingress.remove,
    applyControllerAction: actions.applyController,
    applyUserCommand: userCommands.apply,
    importReport,
    sessionStarted: sessions.started,
    sessionLiveness: sessions.liveness,
    sessionExited: sessions.exited,
    listStaleAssignments: sessions.listStale,
    enqueueEffect: outbox.enqueue,
    runEffectOnce: outbox.runOnce,
    retryUnknownEffect: outbox.retryUnknown,
    repository,
  }
}

module.exports = { createRoomService }
