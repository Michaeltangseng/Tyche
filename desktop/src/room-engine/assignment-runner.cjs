const crypto = require('node:crypto')

const REPORT_EXIT_STATUS = Object.freeze({
  progress: 'waiting', ready: 'completed', waiting: 'waiting',
  blocked: 'blocked', failed: 'failed', handoff: 'waiting',
})

function assertId(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(code)
}

function createAssignmentRunner({ repository, supervisor, invokeAgent, resolveGroup, importReport } = {}) {
  if (!repository || !supervisor || typeof invokeAgent !== 'function' || typeof resolveGroup !== 'function') {
    throw new TypeError('ROOM_ASSIGNMENT_RUNNER_DEPENDENCIES_REQUIRED')
  }

  function start(input = {}) {
    assertId(input.assignmentId, 'ROOM_ASSIGNMENT_ID_INVALID')
    assertId(input.prompt, 'ROOM_ASSIGNMENT_PROMPT_INVALID')
    const assignment = repository.getAssignmentContext(input.assignmentId)
    if (!assignment || (input.chatId && assignment.chat_id !== input.chatId)) throw new Error('ROOM_ASSIGNMENT_NOT_FOUND')
    if (assignment.role_status !== 'active') throw new Error('ROOM_ASSIGNMENT_ROLE_INACTIVE')
    const group = resolveGroup({ assignment, chatId: assignment.chat_id, roomId: assignment.room_id })
    if (!group) throw new Error('ROOM_ASSIGNMENT_GROUP_NOT_FOUND')

    const runId = input.runId || `room-run-${crypto.randomUUID()}`
    const nativeSessionId = `room:${assignment.room_id}:${assignment.chat_id}:${assignment.task_id}:${assignment.id}:${assignment.attempt}`
    repository.markAssignmentStarted({ assignmentId: assignment.id, runId, nativeSessionId })
    supervisor.started({
      assignmentId: assignment.id,
      chatId: assignment.chat_id,
      runId,
      observedAt: input.observedAt,
    })

    const execution = Promise.resolve().then(() => invokeAgent(
      group,
      assignment.provider,
      input.mode || 'plain',
      input.signal,
      input.threadRootId || assignment.task_id,
      {
        ...(input.context || {}),
        taskId: assignment.task_id,
        assignmentId: assignment.id,
        roomId: assignment.room_id,
        chatId: assignment.chat_id,
        sessionPolicy: input.sessionPolicy || 'project-room',
        sessionKey: nativeSessionId,
        traceRunId: runId,
      },
    )).then(
      result => {
        const content = result?.message?.content || result?.pendingMessage?.content
        let report = null
        if (typeof importReport === 'function' && typeof content === 'string') {
          report = importReport({
            chatId: assignment.chat_id,
            taskId: assignment.task_id,
            assignmentId: assignment.id,
            actorId: assignment.role_id,
            content,
          })
        }
        if (!report?.state) {
          repository.markAssignmentExited({
            assignmentId: assignment.id,
            status: report?.report ? REPORT_EXIT_STATUS[report.report.kind] : 'waiting',
            endedReason: report?.report ? null : 'process_exited_without_report',
            outcome: report?.report ? report.report.kind : 'exited',
          })
        }
        supervisor.exited({ assignmentId: assignment.id, chatId: assignment.chat_id, runId, reason: 'completed' })
        return report?.report ? { ...result, roomReport: report.report } : result
      },
      error => {
        repository.markAssignmentExited({
          assignmentId: assignment.id,
          status: 'failed',
          endedReason: error?.message || 'invoke_failed',
          outcome: 'failed',
        })
        supervisor.exited({ assignmentId: assignment.id, chatId: assignment.chat_id, runId, reason: 'failed' })
        throw error
      },
    )
    return { assignmentId: assignment.id, runId, nativeSessionId, promise: execution }
  }

  return { start }
}

module.exports = { createAssignmentRunner }
