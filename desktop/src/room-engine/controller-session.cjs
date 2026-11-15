const crypto = require('node:crypto')

function assertId(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(code)
}

function decode(value, fallback = []) {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

function createControllerSession({ roomDb, repository, applyAction, decide, now = () => Date.now() } = {}) {
  if (!roomDb || !repository || typeof applyAction !== 'function' || typeof decide !== 'function') {
    throw new TypeError('ROOM_CONTROLLER_SESSION_DEPENDENCIES_REQUIRED')
  }

  async function process({ chatId, batchId = `batch-${crypto.randomUUID()}`, contextRevision, messageIds = [], model = null } = {}) {
    assertId(chatId, 'ROOM_CHAT_ID_INVALID')
    assertId(batchId, 'ROOM_CONTROLLER_BATCH_ID_INVALID')
    if (!Number.isInteger(contextRevision) || contextRevision < 0) throw new TypeError('ROOM_CONTROLLER_CONTEXT_REVISION_INVALID')
    if (!Array.isArray(messageIds) || messageIds.some(messageId => typeof messageId !== 'string' || messageId.length === 0)) {
      throw new TypeError('ROOM_CONTROLLER_MESSAGE_IDS_INVALID')
    }
    const existing = repository.getControllerDecision({ chatId, batchId })
    if (existing) return { decision: { ...existing, inputIds: decode(existing.input_ids_json), actionIds: decode(existing.action_ids_json), results: decode(existing.results_json) }, duplicate: true }
    const chat = roomDb.database.prepare('SELECT context_revision FROM chats WHERE id = ?').get(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    if (chat.context_revision !== contextRevision) throw new Error('ROOM_CONTROLLER_CONTEXT_STALE')
    const messages = messageIds.map(messageId => repository.getMessage(messageId)).filter(Boolean)
    if (messages.length !== messageIds.length) throw new Error('ROOM_CONTROLLER_MESSAGE_NOT_FOUND')
    const chatContext = repository.getChatContext(chatId, contextRevision)
    const roles = repository.listAgentRoles(chatId)
    const startedAt = now()
    const proposal = await decide({ chatId, batchId, contextRevision, messages, context: chatContext.context, roles })
    if (!proposal || !Array.isArray(proposal.actions)) throw new TypeError('ROOM_CONTROLLER_DECISION_INVALID')
    const results = []
    for (const action of proposal.actions) {
      results.push(applyAction(action, { actorId: 'controller', contextRevision }))
    }
    const actionIds = results.map(result => result?.event?.eventId).filter(Boolean)
    const decisionId = repository.createControllerDecision({
      chatId,
      batchId,
      contextRevision,
      inputIds: messageIds,
      actionIds,
      results,
      model: proposal.model || model,
      latencyMs: Math.max(0, now() - startedAt),
      cost: proposal.cost ?? null,
    })
    return { decision: { id: decisionId, chatId, batchId, contextRevision, inputIds: messageIds, actionIds, results }, duplicate: false }
  }

  return { process }
}

module.exports = { createControllerSession }
