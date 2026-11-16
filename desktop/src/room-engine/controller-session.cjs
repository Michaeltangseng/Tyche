const crypto = require('node:crypto')
const { validateControllerAction } = require('./room-actions.cjs')

function assertId(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(code)
}

function decode(value, fallback = []) {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

function createControllerSession({ roomDb, repository, applyAction, decide, now = () => Date.now(), timeoutMs = 60_000, fallbackNote = null, dispatchNote = null } = {}) {
  if (!roomDb || !repository || typeof applyAction !== 'function' || typeof decide !== 'function') {
    throw new TypeError('ROOM_CONTROLLER_SESSION_DEPENDENCIES_REQUIRED')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('ROOM_CONTROLLER_TIMEOUT_INVALID')
  }

  const activeChats = new Set()

  function evaluate(input, signal) {
    const controller = new AbortController()
    let timer
    let onAbort
    const evaluation = new Promise((resolve, reject) => {
      const cancel = code => {
        const error = Object.assign(new Error(code), { code })
        reject(error)
        controller.abort(error)
      }
      onAbort = () => cancel('ROOM_CONTROLLER_CANCELLED')
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => cancel('ROOM_CONTROLLER_TIMEOUT'), timeoutMs)
      try {
        Promise.resolve(decide({ ...input, signal: controller.signal })).then(resolve, reject)
      } catch (error) { reject(error) }
    })
    return evaluation.finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    })
  }

  async function processBatch({ chatId, batchId = `batch-${crypto.randomUUID()}`, contextRevision, messageIds = [], triggerEventIds = [], model = null, signal } = {}) {
    if (signal?.aborted) throw new Error('ROOM_CONTROLLER_CANCELLED')
    assertId(chatId, 'ROOM_CHAT_ID_INVALID')
    assertId(batchId, 'ROOM_CONTROLLER_BATCH_ID_INVALID')
    if (!Number.isInteger(contextRevision) || contextRevision < 0) throw new TypeError('ROOM_CONTROLLER_CONTEXT_REVISION_INVALID')
    if (!Array.isArray(messageIds) || messageIds.some(messageId => typeof messageId !== 'string' || messageId.length === 0)) {
      throw new TypeError('ROOM_CONTROLLER_MESSAGE_IDS_INVALID')
    }
    const existing = repository.getControllerDecision({ chatId, batchId })
    if (existing) return { decision: { ...existing, inputIds: decode(existing.input_ids_json), actionIds: decode(existing.action_ids_json), results: decode(existing.results_json) }, duplicate: true }
    const chat = roomDb.database.prepare('SELECT context_revision, status FROM chats WHERE id = ?').get(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    if (chat.status !== 'active') throw new Error('ROOM_CONTROLLER_CHAT_NOT_ACTIVE')
    if (chat.context_revision !== contextRevision) throw new Error('ROOM_CONTROLLER_CONTEXT_STALE')
    const messages = messageIds.map(messageId => repository.getMessage(messageId)).filter(Boolean)
    if (messages.length !== messageIds.length) throw new Error('ROOM_CONTROLLER_MESSAGE_NOT_FOUND')
    if (messages.some(message => message.chat_id !== chatId || message.deleted_at)) throw new Error('ROOM_CONTROLLER_MESSAGE_SCOPE_INVALID')
    const chatContext = repository.getChatContext(chatId, contextRevision)
    if (!Array.isArray(triggerEventIds) || triggerEventIds.some(id => typeof id !== 'string' || !id)) throw new TypeError('ROOM_CONTROLLER_EVENT_IDS_INVALID')
    const eventById = new Map(repository.listEvents(chatContext.chat.room_id, { chatId }).map(event => [event.id, event]))
    const events = triggerEventIds.map(id => eventById.get(id))
    if (events.some(event => !event)) throw new Error('ROOM_CONTROLLER_EVENT_SCOPE_INVALID')
    const roles = repository.listAgentRoles(chatId)
    const startedAt = now()
    const proposal = await evaluate({ chatId, batchId, contextRevision, messages, events, context: chatContext.context, roles }, signal)
    if (signal?.aborted) throw new Error('ROOM_CONTROLLER_CANCELLED')
    if (!proposal || !Array.isArray(proposal.actions)) throw new TypeError('ROOM_CONTROLLER_DECISION_INVALID')
    return roomDb.withTransaction(() => {
      const committed = repository.getControllerDecision({ chatId, batchId })
      if (committed) return { decision: { ...committed, inputIds: decode(committed.input_ids_json), actionIds: decode(committed.action_ids_json), results: decode(committed.results_json) }, duplicate: true }
      const currentChat = repository.getChatContext(chatId).chat
      if (currentChat.status !== 'active') throw new Error('ROOM_CONTROLLER_CHAT_NOT_ACTIVE')
      if (currentChat.context_revision !== contextRevision) throw new Error('ROOM_CONTROLLER_CONTEXT_STALE')
      if (messages.some(message => JSON.stringify(repository.getMessage(message.id)) !== JSON.stringify(message))) {
        throw new Error('ROOM_CONTROLLER_MESSAGES_STALE')
      }
      const actions = proposal.actions.map(action => validateControllerAction(action, { chatId, contextRevision }))
      const contextUpdates = actions.filter(action => action.type === 'update_context')
      if (contextUpdates.length > 1) throw new Error('ROOM_CONTROLLER_MULTIPLE_CONTEXT_UPDATES')
      const orderedActions = [...contextUpdates, ...actions.filter(action => action.type !== 'update_context')]
      const userMessageIds = messages.filter(message => message.author_type === 'user').map(message => message.id)
      if (!orderedActions.length && userMessageIds.length && typeof fallbackNote === 'function') {
        const content = String(fallbackNote({ chatId, messages }) || '').trim()
        if (content) {
          orderedActions.push(validateControllerAction({
            type: 'note', chatId, contextRevision, content,
          }, { chatId, contextRevision }))
        }
      }
      const results = []
      const dispatchedAssignments = []
      for (const action of orderedActions) {
        const effectiveRevision = repository.getChatContext(chatId).revision
        const result = applyAction({ ...action, contextRevision: effectiveRevision }, { actorId: 'controller', contextRevision: effectiveRevision, userMessageIds })
        results.push(result)
        if (action.type === 'assign' && result?.assignmentId) {
          const assignment = repository.getAssignmentContext(result.assignmentId)
          if (assignment) dispatchedAssignments.push(assignment)
        }
      }
      if (dispatchedAssignments.length && typeof dispatchNote === 'function') {
        const existingNotes = orderedActions.filter(action => action.type === 'note').map(action => action.content).join('\n')
        const missingMention = dispatchedAssignments.some(assignment => !existingNotes.includes(`@${assignment.display_name}`))
        if (missingMention) {
          const content = String(dispatchNote(dispatchedAssignments) || '').trim()
          if (content) {
            const effectiveRevision = repository.getChatContext(chatId).revision
            const noteAction = validateControllerAction({
              type: 'note', chatId, contextRevision: effectiveRevision, content,
            }, { chatId, contextRevision: effectiveRevision })
            results.push(applyAction({ ...noteAction, contextRevision: effectiveRevision }, {
              actorId: 'controller', contextRevision: effectiveRevision, userMessageIds,
            }))
          }
        }
      }
      const actionIds = results.map(result => result?.event?.eventId).filter(Boolean)
      const decisionId = repository.createControllerDecision({
        chatId,
        batchId,
        contextRevision,
        inputIds: [...messageIds, ...triggerEventIds],
        actionIds,
        results,
        model: proposal.model || model,
        latencyMs: Math.max(0, now() - startedAt),
        cost: proposal.cost ?? null,
      })
      return { decision: { id: decisionId, chatId, batchId, contextRevision, inputIds: [...messageIds, ...triggerEventIds], actionIds, results }, duplicate: false }
    })
  }

  async function process(input = {}) {
    assertId(input.chatId, 'ROOM_CHAT_ID_INVALID')
    if (activeChats.has(input.chatId)) throw new Error('ROOM_CONTROLLER_CHAT_BUSY')
    activeChats.add(input.chatId)
    try {
      return await processBatch(input)
    } finally {
      activeChats.delete(input.chatId)
    }
  }

  return { process }
}

module.exports = { createControllerSession }
