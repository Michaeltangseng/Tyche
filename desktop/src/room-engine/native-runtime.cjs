const path = require('node:path')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const {
  defaultNativePermission,
  nativePermissionAllowsExec,
  nativePermissionAllowsWrite,
} = require('../agents/native-permission-modes.cjs')

// Native execution reuses the CLI transport, not a persisted legacy chat.
function createRoomNativeRuntime({ repository, workspace, artifactSnapshots, onAssignmentEvent } = {}) {
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
    let nativePermission = null
    if (context.assignmentId) {
      const assignment = repository.getAssignmentContext(context.assignmentId)
      if (!assignment || assignment.chat_id !== target.chatId || assignment.room_id !== target.roomId
          || assignment.provider !== provider || assignment.task_id !== context.taskId
          || assignment.status !== 'running' || assignment.run_id !== context.traceRunId) throw new Error('ROOM_NATIVE_ASSIGNMENT_SCOPE_INVALID')
      const role = repository.getAgentRole(assignment.role_id)
      nativePermission = role?.native_permission || defaultNativePermission(provider)
      if (nativePermissionAllowsWrite(provider, nativePermission)) {
        writeRoot = fs.realpathSync.native(current.workdir)
      }
    }
    const nativePermissionMode = nativePermission || defaultNativePermission(provider)
    const nativeExec = nativePermissionAllowsExec(provider, nativePermissionMode)
    const identity = createHash('sha256').update(JSON.stringify([target.roomId, target.chatId, provider, context.traceRunId])).digest('hex')
    // This descriptor exists only for this invocation. It is never registered
    // in workspace groups, messages, activeRuns or legacy session storage.
    const surface = Object.freeze({ id: `room-native-${identity}`, conversationType: 'direct',
      workdir: writeRoot || current.workdir, agentKinds: [provider], allowWrite: Boolean(writeRoot) })
    let baseline = null
    let artifactIds = []
    const snapshotInput = { assignmentId: context.assignmentId, runId: context.traceRunId, workdir: writeRoot, signal }
    const assertActive = () => {
      if (signal?.aborted || repository.getTask(context.taskId)?.status === 'cancelled') throw new Error('ROOM_NATIVE_CANCELLED')
    }
    const liveEvent = context.assignmentId && typeof onAssignmentEvent === 'function'
      ? event => onAssignmentEvent({
        roomId: target.roomId, chatId: target.chatId, taskId: context.taskId,
        assignmentId: context.assignmentId, runId: context.traceRunId,
        event: ['type', 'id', 'seq', 'status', 'title', 'summary', 'detail', 'delta']
          .reduce((safe, key) => {
            if (event?.[key] == null) return safe
            safe[key] = typeof event[key] === 'string' ? event[key].slice(0, 32 * 1024) : event[key]
            return safe
          }, {}),
      }) : null
    const result = await workspace.invokeAgent(surface, provider, mode, signal, threadRootId, {
      ...context, sessionPolicy: 'room', saveSession: false, deferMessage: true,
      nativePermission: nativePermissionMode,
      permissionMode: writeRoot ? 'workspace-write' : (nativeExec ? 'read-exec' : 'read-only'),
      operationId: `agent-operation-${identity}`,
      traceAgentRunId: `room-agent-${identity}`,
      ...(liveEvent ? { onEvent: liveEvent } : {}),
      onLeaseAcquired: async () => {
        if (writeRoot && fs.realpathSync.native(current.workdir) !== writeRoot) throw new Error('ROOM_NATIVE_WORKDIR_CHANGED')
        if (writeRoot && artifactSnapshots) {
          assertActive()
          baseline = await artifactSnapshots.before(snapshotInput)
          assertActive()
        }
      },
      onInvocationCompleted: async () => {
        if (writeRoot && artifactSnapshots) {
          assertActive()
          artifactIds = await artifactSnapshots.after({ ...snapshotInput, baseline, signal })
        }
      },
    })
    return artifactIds.length ? { ...result, roomArtifactIds: artifactIds } : result
  }

  return { resolveTarget, invokeAgent }
}

module.exports = { createRoomNativeRuntime }
