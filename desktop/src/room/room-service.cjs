/**
 * Production assembly for the new room domain.
 *
 * It owns the room database's runtime wiring: timeline/session/outbox stores,
 * the reply engine, the task queue, settlement, Captain review, the host tool
 * dispatcher, the runtime adapter (OAR in production), and the supervisor.
 *
 * Two pieces of liveness are deliberately here, not in the engine:
 * - every domain commit debounces a pass that starts queued replies and pumps
 *   task runs; startQueuedReplies itself skips a role that is still working,
 *   so one participant session stays serial;
 * - every domain commit also asks the Captain supervisor for a review tick.
 *
 * close() stops both timers and asks the runtime adapter to dispose every live
 * session. Hard-crash cleanup of OAR-spawned processes is still a separate
 * production item.
 */
const { createTimeline } = require('./timeline.cjs')
const { createSessionStore } = require('./session-store.cjs')
const { createOutbox } = require('./effects.cjs')
const { createEngine } = require('./engine.cjs')
const { createTaskQueue } = require('./task-queue.cjs')
const { createSettlement, registerFinishTaskTool } = require('./settlement.cjs')
const { createCaptainReview } = require('./captain-review.cjs')
const { createSupervisor } = require('./supervisor.cjs')
const { recoverOnStart } = require('./recovery.cjs')
const { createRuntimeEvents } = require('./runtime-events.cjs')
const { createToolDispatcher } = require('./tools/dispatcher.cjs')
const { registerMentionTool } = require('./tools/mention.cjs')
const { registerReadChatTool } = require('./tools/read.cjs')
const { registerTaskTools } = require('./tools/tasks.cjs')
const { createCaptainAssignment, registerCaptainTools } = require('./tools/captain.cjs')

function createRoomService({
  roomDb,
  repository,
  timeline = null,
  sessions = null,
  outbox = null,
  dispatcher = null,
  adapter = null,
  adapterFactory = null,
  adapterOptions = {},
  supervisorOptions = {},
  recoverOnOpen = false,
  liveness = true,
  livenessDebounceMs = 150,
  now = () => Date.now(),
  onEvent = () => {},
  onTaskSettled: onTaskSettledEvent = null,
} = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_SERVICE_DEPENDENCIES_REQUIRED')
  const { database } = roomDb
  const timelineStore = timeline ?? createTimeline({ roomDb, repository })
  const sessionStore = sessions ?? createSessionStore({ roomDb, repository })
  const outboxStore = outbox ?? createOutbox({ roomDb, repository })
  const toolDispatcher = dispatcher ?? createToolDispatcher({ roomDb, repository })
  const runtimeEvents = createRuntimeEvents({ roomDb, now })

  function recordRuntimeEvent(payload) {
    // Text/reasoning deltas are already on the reply row; keep the trace small.
    if (payload?.event?.kind !== 'text_delta' && payload?.event?.kind !== 'reasoning') {
      try { runtimeEvents.record(payload) } catch { /* trace must not fail a run */ }
    }
    try { onEvent(payload) } catch { /* observers are best-effort */ }
  }

  let runtimeAdapter = adapter
  let supervisor = null
  let closed = false
  let livenessTimer = null
  let livenessRun = null
  let unsubscribeCommit = null

  const requestTick = chatId => supervisor?.requestTick(chatId)
  const runtime = {
    start(input) {
      if (!runtimeAdapter) throw new Error('ROOM_RUNTIME_ADAPTER_REQUIRED')
      return runtimeAdapter.start({ ...input, onEvent: input.onEvent ?? onEvent })
    },
  }

  const engine = createEngine({
    roomDb,
    repository,
    timeline: timelineStore,
    sessions: sessionStore,
    outbox: outboxStore,
    runtime,
    now,
    onEvent: recordRuntimeEvent,
  })
  const queue = createTaskQueue({
    roomDb,
    repository,
    timeline: timelineStore,
    outbox: outboxStore,
    now,
    startRun: (run, task) => {
      if (!runtimeAdapter) throw new Error('ROOM_RUNTIME_ADAPTER_REQUIRED')
      return runtimeAdapter.startTaskRun(run, task)
    },
  })
  const settlement = createSettlement({ roomDb, repository, timeline: timelineStore, now })
  const review = createCaptainReview({ roomDb, repository, timeline: timelineStore, now, outbox: outboxStore })
  const captainAssignment = createCaptainAssignment({
    roomDb,
    repository,
    timeline: timelineStore,
    review,
    queueReply: input => engine.queueReply(input),
    requestTick,
  })

  registerMentionTool({
    dispatcher: toolDispatcher,
    roomDb,
    repository,
    timeline: timelineStore,
    queueReply: input => engine.queueReply(input),
  })
  registerReadChatTool({ dispatcher: toolDispatcher, timeline: timelineStore, repository })
  registerTaskTools({
    dispatcher: toolDispatcher,
    roomDb,
    repository,
    timeline: timelineStore,
    queueRun: queue,
  })
  registerFinishTaskTool({ dispatcher: toolDispatcher, settlement })
  registerCaptainTools({ dispatcher: toolDispatcher, repository, captainAssignment, timeline: timelineStore })

  function onTaskSettled(info) {
    if (info?.taskId) {
      const task = database.prepare('SELECT chat_id FROM tasks WHERE id = ?').get(info.taskId)
      if (task?.chat_id) supervisor?.requestTick(task.chat_id)
    }
    try { onTaskSettledEvent?.(info) } catch { /* observers are best-effort */ }
    requestLiveness()
  }

  supervisor = createSupervisor({
    captainReview: review,
    startReplies: chatId => engine.startQueuedReplies({ chatId }),
    now,
    ...supervisorOptions,
  })

  if (!runtimeAdapter && typeof adapterFactory === 'function') {
    runtimeAdapter = adapterFactory({
      roomDb,
      repository,
      timeline: timelineStore,
      sessions: sessionStore,
      dispatcher: toolDispatcher,
      settlement,
      onTaskSettled,
      onEvent: recordRuntimeEvent,
      ...adapterOptions,
    })
  }
  if (!runtimeAdapter || typeof runtimeAdapter.start !== 'function') {
    throw new Error('ROOM_RUNTIME_ADAPTER_REQUIRED')
  }

  const recovery = recoverOnOpen
    ? recoverOnStart({ roomDb, repository, now })
    : null

  function pendingChatIds() {
    return database.prepare(`
      SELECT DISTINCT chat_id FROM messages
      WHERE author_type = 'agent' AND status = 'queued'
      UNION
      SELECT DISTINCT chat_id FROM effects
      WHERE kind = 'start_reply' AND status = 'pending'
    `).all().map(row => row.chat_id)
  }

  function roomIds() {
    return database.prepare('SELECT id FROM rooms').all().map(row => row.id)
  }

  async function runLiveness() {
    if (closed) return
    if (livenessRun) return livenessRun
    livenessRun = (async () => {
      try {
        for (const chatId of pendingChatIds()) {
          if (closed) return
          try {
            await engine.startQueuedReplies({ chatId })
          } catch { /* errors are on the reply row; the next commit retries */ }
        }
        for (const roomId of roomIds()) {
          if (closed) return
          try {
            await queue.pump({ roomId })
          } catch { /* errors are on the run row; the next commit retries */ }
        }
      } finally {
        livenessRun = null
      }
    })()
    return livenessRun
  }

  function requestLiveness() {
    if (!liveness || closed || livenessTimer) return
    livenessTimer = setTimeout(() => {
      livenessTimer = null
      void runLiveness()
    }, livenessDebounceMs)
    livenessTimer.unref?.()
  }

  if (liveness) {
    unsubscribeCommit = roomDb.onCommit(() => {
      supervisor?.requestTick()
      requestLiveness()
    })
  }
  supervisor.start()

  function submitUserMessage(input) {
    const result = engine.submitUserMessage(input)
    requestTick(input.chatId)
    requestLiveness()
    return result
  }

  async function startQueuedReplies(input) {
    const result = await engine.startQueuedReplies(input)
    requestLiveness()
    return result
  }

  async function pump(input) {
    const started = await queue.pump(input)
    requestLiveness()
    return started
  }

  async function waitForChatIdle({ chatId, timeoutMs = 5 * 60 * 1000 } = {}) {
    if (typeof chatId !== 'string' || chatId.length === 0) throw new TypeError('ROOM_CHAT_ID_REQUIRED')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const busy = database.prepare(`
        SELECT COUNT(*) AS n FROM messages
        WHERE chat_id = ? AND author_type = 'agent'
          AND status IN ('queued', 'working', 'waiting_for_input', 'stopping')
      `).get(chatId).n
      if (busy === 0) return true
      if (!liveness) {
        try { await engine.startQueuedReplies({ chatId }) } catch { /* retried by the caller */ }
      } else {
        requestLiveness()
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('ROOM_CHAT_NOT_IDLE')
  }

  async function close() {
    if (closed) return
    closed = true
    if (livenessTimer) {
      clearTimeout(livenessTimer)
      livenessTimer = null
    }
    unsubscribeCommit?.()
    unsubscribeCommit = null
    supervisor?.stop()
    try { await livenessRun } catch { /* shutdown is best effort */ }
    try { await runtimeAdapter.disposeAll?.() } catch { /* shutdown is best effort */ }
  }

  return {
    roomDb,
    repository,
    timeline: timelineStore,
    sessions: sessionStore,
    outbox: outboxStore,
    dispatcher: toolDispatcher,
    engine,
    queue,
    settlement,
    review,
    supervisor,
    adapter: runtimeAdapter,
    runtimeEvents,
    recovery,
    submitUserMessage,
    startQueuedReplies,
    pump,
    stopReply: input => engine.stopReply(input),
    waitForChatIdle,
    requestTick,
    requestLiveness,
    get closed() { return closed },
    close,
  }
}

module.exports = { createRoomService }
