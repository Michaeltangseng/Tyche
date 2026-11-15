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
    const rolePrompt = repository.getRolePrompt(assignment.role_id)?.prompt || ''
    const collaboration = repository.getChatContext(assignment.chat_id, assignment.context_revision).context
    const promptOverride = [
      'You are a Meldwork team worker. Complete the assigned task using your native tools and configuration.',
      `Task: ${assignment.objective}`,
      `Role instructions: ${rolePrompt}`,
      `Collaboration instructions: ${collaboration?.instructions || ''}`,
      input.prompt,
      'End your reply with a structured report: [[MELDWORK_REPORT:{"kind":"ready","summary":"what you completed","evidence":[],"artifacts":[]}]]',
      'Use kind progress, ready, waiting, blocked, failed or handoff truthfully. Artifact entries must be existing platform artifact IDs; do not invent IDs or use file paths as IDs. Mention output file paths in summary/evidence.',
      'Requests for other agents belong in nextRequest and do not themselves authorize dispatch.',
    ].join('\n')
    if (promptOverride.includes('\u0000') || Buffer.byteLength(promptOverride) > 4 * 1024 * 1024) throw new Error('ROOM_ASSIGNMENT_PROMPT_TOO_LARGE_OR_INVALID')
    const contextPackId = `context-pack-${crypto.createHash('sha256').update(promptOverride).digest('hex')}`
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
        promptOverride,
        contextPackId,
        deferMessage: true,
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
    ).catch(error => {
      if (repository.getAssignmentContext(assignment.id)?.status === 'running') repository.markAssignmentExited({
        assignmentId: assignment.id,
        status: 'failed',
        endedReason: error?.message || 'invoke_failed',
        outcome: 'failed',
      })
      supervisor.exited({ assignmentId: assignment.id, chatId: assignment.chat_id, runId, reason: 'failed' })
      throw error
    })
    return { assignmentId: assignment.id, runId, nativeSessionId, promise: execution }
  }

  return { start }
}

module.exports = { createAssignmentRunner }
