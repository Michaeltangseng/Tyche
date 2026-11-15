// Real-provider recovery smoke: unknown execution -> process reconciliation -> explicit retry.
async function runRecoverySmoke({ service, repository, roomId, chatId, processRegistry, provider = 'claude' }) {
  const roleId = repository.createAgentRole({
    chatId,
    displayName: 'Recovery worker',
    responsibilities: 'Complete the assigned recovery check and report truthfully.',
    capabilities: ['text'],
    provider,
    createdBy: 'user',
  })
  repository.createRolePromptRevision({ roleId, prompt: 'Return a concise ready report after checking the assignment. Do not create files.', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Verify that an interrupted assignment can be retried and completed.', kind: 'recovery-check', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId, required: true, writeScopes: ['.'] })
  repository.createEffect({ chatId, kind: 'start_assignment', payload: { assignmentId, prompt: 'Perform the recovery check. Reply with a ready Report stating that recovery succeeded.' }, idempotencyKey: `recovery-start:${assignmentId}` })

  const first = await service.runNextEffect()
  if (!first || first.effect.status !== 'unknown' || first.error?.unknown !== true) throw new Error('SMOKE_RECOVERY_UNKNOWN_NOT_QUARANTINED')
  const quarantined = repository.getAssignmentContext(assignmentId)
  if (quarantined.status !== 'waiting' || quarantined.outcome !== 'unknown') throw new Error('SMOKE_RECOVERY_ASSIGNMENT_NOT_QUARANTINED')
  if (repository.listEvents(roomId, { chatId }).some(event => event.type === 'session_exited')) throw new Error('SMOKE_RECOVERY_EXIT_FABRICATED')

  const reconciled = service.reconcileProcesses({ assignmentId })
  if (reconciled.resolvedAssignmentIds.length !== 1 || reconciled.unresolvedAssignmentIds.length !== 0) {
    throw new Error(`SMOKE_RECOVERY_RECONCILIATION_FAILED:${JSON.stringify({ reconciled, runId: quarantined.run_id, records: processRegistry.getInvocationRecords(quarantined.run_id), workspace: quarantined.workspace })}`)
  }
  const interrupted = repository.getAssignmentContext(assignmentId)
  if (interrupted.outcome !== 'interrupted' || !repository.listEvents(roomId, { chatId }).some(event => event.type === 'session_exited')) throw new Error('SMOKE_RECOVERY_EXIT_NOT_RECORDED')

  const retry = service.applyUserCommand({ type: 'retry_task', chatId, taskId, assignmentId, commandId: `recovery-retry:${assignmentId}` })
  if (!retry.assignmentId || retry.assignmentId === assignmentId) throw new Error('SMOKE_RECOVERY_RETRY_NOT_CREATED')
  const second = await service.runNextEffect()
  if (!second || second.effect.status !== 'succeeded') throw new Error('SMOKE_RECOVERY_RETRY_NOT_EXECUTED')
  const replacement = repository.getAssignmentContext(retry.assignmentId)
  const task = repository.getTask(taskId)
  const reports = repository.getRoomSnapshot(roomId).reports.filter(report => report.task_id === taskId)
  if (replacement.status !== 'completed' || replacement.outcome !== 'ready' || task.status !== 'done' || reports.at(-1)?.kind !== 'ready') throw new Error('SMOKE_RECOVERY_COMPLETION_INVALID')
  const records = processRegistry.getInvocationRecords(replacement.run_id)
  if (!records.length || records.some(record => record.status !== 'ended')) throw new Error('SMOKE_RECOVERY_PROCESS_RECORD_MISSING')
  if (repository.listAssignments(taskId).length !== 2) throw new Error('SMOKE_RECOVERY_HISTORY_MISSING')
  return { ok: true, scenario: 'recovery', originalAssignmentId: assignmentId, replacementAssignmentId: retry.assignmentId, taskId, tasks: 1, assignments: 2, reports: reports.length, recoveryVerified: true }
}

module.exports = { runRecoverySmoke }
