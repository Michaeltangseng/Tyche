const path = require('node:path')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { normalizeRelativePath } = require('../runs/path-claims.cjs')

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
    if (typeof context.traceRunId !== 'string' || !context.traceRunId) throw new Error('ROOM_NATIVE_RUN_ID_REQUIRED')
    let writeRoot = null
    if (context.assignmentId) {
      const assignment = repository.getAssignmentContext(context.assignmentId)
      if (!assignment || assignment.chat_id !== target.chatId || assignment.room_id !== target.roomId
          || assignment.provider !== provider || assignment.task_id !== context.taskId
          || assignment.status !== 'running' || assignment.run_id !== context.traceRunId) throw new Error('ROOM_NATIVE_ASSIGNMENT_SCOPE_INVALID')
      const scopes = JSON.parse(assignment.write_scopes_json)
      if (!Array.isArray(scopes)) throw new Error('ROOM_NATIVE_WRITE_SCOPES_INVALID')
      for (const scope of scopes) normalizeRelativePath(scope)
      if (scopes.length) {
        writeRoot = fs.realpathSync.native(current.workdir)
        if (repository.getRoomSnapshot(target.roomId).room.write_authorized_root !== writeRoot) throw new Error('ROOM_NATIVE_WRITE_NOT_AUTHORIZED')
      }
    }
    if (context.permissionMode != null && context.permissionMode !== 'read-only'
        && (context.permissionMode !== 'workspace-write' || !writeRoot)) throw new Error('ROOM_NATIVE_WRITE_NOT_AUTHORIZED')
    const identity = createHash('sha256').update(JSON.stringify([target.roomId, target.chatId, provider, context.traceRunId])).digest('hex')
    // This descriptor exists only for this invocation. It is never registered
    // in workspace groups, messages, activeRuns or legacy session storage.
    const surface = Object.freeze({ id: `room-native-${identity}`, conversationType: 'direct',
      workdir: writeRoot || current.workdir, agentKinds: [provider], allowWrite: Boolean(writeRoot) })
    return workspace.invokeAgent(surface, provider, mode, signal, threadRootId, {
      ...context, sessionPolicy: 'room', saveSession: false, deferMessage: true,
      permissionMode: writeRoot ? 'workspace-write' : 'read-only', operationId: `agent-operation-${identity}`,
      traceAgentRunId: `room-agent-${identity}`,
      onLeaseAcquired: () => {
        if (writeRoot && (repository.getRoomSnapshot(target.roomId).room.write_authorized_root !== writeRoot
            || fs.realpathSync.native(current.workdir) !== writeRoot)) throw new Error('ROOM_NATIVE_WRITE_AUTHORIZATION_CHANGED')
      },
    })
  }

  return { resolveTarget, invokeAgent }
}

module.exports = { createRoomNativeRuntime }
