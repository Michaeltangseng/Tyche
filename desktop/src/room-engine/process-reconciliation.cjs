const path = require('node:path')

function createProcessReconciliation({ roomDb, repository, supervisor, getInvocationRecords, locale = () => 'en' } = {}) {
  if (!roomDb || !repository || !supervisor || typeof getInvocationRecords !== 'function') throw new TypeError('ROOM_PROCESS_RECONCILIATION_DEPENDENCIES_REQUIRED')
  const db = roomDb.database

  function reconcile({ assignmentId = null } = {}) {
    return roomDb.withTransaction(() => {
      const candidates = new Set(db.prepare("SELECT id FROM assignments WHERE outcome = 'unknown'").all().map(row => row.id))
      const effects = db.prepare("SELECT * FROM effects WHERE status = 'unknown' AND kind IN ('start_assignment', 'stop_assignment')").all()
      for (const effect of effects) {
        try {
          const id = JSON.parse(effect.payload_json)?.assignmentId
          if (typeof id === 'string') candidates.add(id)
        } catch { /* malformed effects cannot prove process identity */ }
      }
      const resolved = []
      const unresolved = []
      for (const id of candidates) {
        if (assignmentId !== null && id !== assignmentId) continue
        const assignment = repository.getAssignmentContext(id)
        if (!assignment?.run_id) { unresolved.push(id); continue }
        const records = getInvocationRecords(assignment.run_id)
        const provenEnded = Array.isArray(records) && records.length > 0 && records.every(record => (
          record.invocationId === assignment.run_id && record.status === 'ended'
          && record.agentKind === assignment.provider && typeof record.workdir === 'string'
          && path.resolve(record.workdir) === path.resolve(assignment.workspace)
        ))
        if (!provenEnded) { unresolved.push(id); continue }
        const linked = effects.filter(effect => {
          try { return effect.chat_id === assignment.chat_id && JSON.parse(effect.payload_json)?.assignmentId === id } catch { return false }
        })
        const timestamp = new Date().toISOString()
        if (assignment.outcome === 'unknown') {
          db.prepare(`UPDATE assignments SET status = 'waiting', outcome = 'interrupted',
            ended_reason = 'application_interrupted_process_ended', updated_at = ? WHERE id = ?`).run(timestamp, id)
        }
        for (const effect of linked) {
          db.prepare(`UPDATE effects SET status = ?, last_error = ?, completed_at = ? WHERE id = ?`)
            .run(effect.kind === 'stop_assignment' ? 'succeeded' : 'failed', effect.kind === 'stop_assignment' ? null : 'APPLICATION_INTERRUPTED_PROCESS_ENDED', timestamp, effect.id)
        }
        const event = supervisor.exited({ assignmentId: id, chatId: assignment.chat_id,
          runId: assignment.run_id, reason: 'recovered_process_ended' })
        repository.appendEvent({ roomId: assignment.room_id, chatId: assignment.chat_id, actorId: 'supervisor',
          type: 'process_reconciled', payload: { assignmentId: id, runId: assignment.run_id,
            processRecordIds: records.map(record => record.recordId), effectIds: linked.map(effect => effect.id), exitEventId: event.eventId } })
        const zh = String(locale()).startsWith('zh')
        const question = zh
          ? `已确认原进程结束，请检查中断前的产物，再明确选择重试或交接。Assignment: ${id}`
          : `The original process has ended. Inspect its output, then explicitly retry or hand off. Assignment: ${id}`
        for (const attentionId of [`recovery-assignment:${id}`, `termination:${id}:${assignment.run_id}`, ...linked.map(effect => `recovery-effect:${effect.id}`)]) {
          db.prepare("UPDATE attentions SET question = ? WHERE id = ? AND status = 'open'").run(question, attentionId)
        }
        resolved.push(id)
      }
      return { resolvedAssignmentIds: resolved, unresolvedAssignmentIds: unresolved }
    })
  }

  return { reconcile }
}

module.exports = { createProcessReconciliation }
