const path = require('node:path')
const { createHash } = require('node:crypto')

// Native execution reuses the CLI transport, not a persisted legacy chat.
function createRoomNativeRuntime({ repository, workspace } = {}) {
  if (!repository || !workspace || typeof workspace.invokeAgent !== 'function') throw new TypeError('ROOM_NATIVE_RUNTIME_DEPENDENCIES_REQUIRED')

  function resolveTarget({ assignment, chatId, roomId } = {}) {
    if (!assignment || typeof chatId !== 'string' || typeof roomId !== 'string') return null
    const chat = repository.getChatContext(chatId).chat
    if (chat.room_id !== roomId) return null
    const room = repository.getRoomSnapshot(roomId).room
    if (!room || typeof assignment.workspace !== 'string' || !path.isAbsolute(assignment.workspace)
        || path.resolve(assignment.workspace) !== path.resolve(room.workspace)
        || !room.providers_json.includes(assignment.provider)) return null
    const agent = workspace.detectedAgents?.find(agent => agent.kind === assignment.provider)
    if (!agent?.available || agent.installed === false || agent.invocable === false) return null
    return Object.freeze({
      roomId, chatId, provider: assignment.provider, workdir: path.resolve(room.workspace),
    })
  }

  async function invokeAgent(target, provider, mode, signal, threadRootId, context = {}) {
    if (signal?.aborted) throw new Error('ROOM_NATIVE_CANCELLED')
    if (!target || context.roomId !== target.roomId || context.chatId !== target.chatId || provider !== target.provider) throw new Error('ROOM_NATIVE_TARGET_SCOPE_INVALID')
    const current = resolveTarget({ assignment: { workspace: target.workdir, provider }, chatId: target.chatId, roomId: target.roomId })
    if (!current) throw new Error('ROOM_NATIVE_TARGET_UNAVAILABLE')
    if (context.permissionMode != null && context.permissionMode !== 'read-only') throw new Error('ROOM_NATIVE_WRITE_NOT_SUPPORTED')
    if (typeof context.traceRunId !== 'string' || !context.traceRunId) throw new Error('ROOM_NATIVE_RUN_ID_REQUIRED')
    const identity = createHash('sha256').update(JSON.stringify([target.roomId, target.chatId, provider, context.traceRunId])).digest('hex')
    // This descriptor exists only for this invocation. It is never registered
    // in workspace groups, messages, activeRuns or legacy session storage.
    const surface = Object.freeze({ id: `room-native-${identity}`, conversationType: 'direct',
      workdir: current.workdir, agentKinds: [provider], allowWrite: false })
    return workspace.invokeAgent(surface, provider, mode, signal, threadRootId, {
      ...context, sessionPolicy: 'room', saveSession: false, deferMessage: true,
      permissionMode: 'read-only', operationId: `agent-operation-${identity}`,
      traceAgentRunId: `room-agent-${identity}`,
    })
  }

  return { resolveTarget, invokeAgent }
}

module.exports = { createRoomNativeRuntime }
