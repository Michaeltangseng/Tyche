const { REPORT_ASSIGNMENT_STATUS, createReportStateService } = require('./report-state.cjs')

// Run once at startup, before any v2 execution begins. This does not prove that
// a native process exited: process-registry recovery owns that observation.
function createRuntimeRecovery({ roomDb, repository, locale = () => 'en' } = {}) {
  if (!roomDb || !repository) throw new TypeError('ROOM_RECOVERY_DEPENDENCIES_REQUIRED')
  const db = roomDb.database
  const reportState = createReportStateService({ roomDb })

  function recover() {
    return roomDb.withTransaction(() => {
      const effects = db.prepare("SELECT * FROM effects WHERE status = 'running' ORDER BY id").all()
      const assignments = db.prepare(`SELECT a.*, t.chat_id, c.room_id FROM assignments a
        JOIN tasks t ON t.id = a.task_id JOIN chats c ON c.id = t.chat_id
        WHERE a.status = 'running' ORDER BY a.id`).all()
      const attentionIds = []
      const eventIds = []
      const timestamp = new Date().toISOString()
      const affectedTasks = new Set(assignments.map(assignment => assignment.task_id))
      const zh = String(locale()).startsWith('zh')

      function attention({ attentionId, chatId, taskId = null, question }) {
        if (!db.prepare('SELECT id FROM attentions WHERE id = ?').get(attentionId)) {
          repository.createAttention({ attentionId, chatId, taskId, type: 'failure', question,
            options: [{ id: 'acknowledge', label: zh ? '已知悉' : 'Acknowledge' }], requestedBy: 'supervisor' })
          attentionIds.push(attentionId)
        }
      }

      for (const effect of effects) {
        db.prepare(`UPDATE effects SET status = 'unknown', last_error = 'APPLICATION_INTERRUPTED', completed_at = NULL WHERE id = ?`).run(effect.id)
        const chat = repository.getChatContext(effect.chat_id).chat
        let assignmentId
        try { assignmentId = JSON.parse(effect.payload_json)?.assignmentId } catch { /* malformed intent is still unknown */ }
        const assignment = typeof assignmentId === 'string' ? repository.getAssignmentContext(assignmentId) : null
        attention({ attentionId: `recovery-effect:${effect.id}`, chatId: effect.chat_id,
          taskId: assignment?.chat_id === effect.chat_id ? assignment.task_id : null,
          question: zh ? `执行中断，结果未知，请检查文件与残留进程后决定是否重试。Effect: ${effect.id}` : `Execution was interrupted; outcome is unknown. Inspect files and residual processes before retrying. Effect: ${effect.id}` })
        eventIds.push(repository.appendEvent({ roomId: chat.room_id, chatId: effect.chat_id,
          actorId: 'supervisor', type: 'effect_recovery_required',
          payload: { effectId: effect.id, previousStatus: 'running', status: 'unknown' } }).eventId)
      }

      for (const assignment of assignments) {
        const latest = db.prepare('SELECT kind, summary FROM reports WHERE assignment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(assignment.id)
        // A committed final Report survives a crash between report import and exit bookkeeping.
        if (latest && latest.kind !== 'progress') {
          db.prepare('UPDATE assignments SET status = ?, outcome = ?, ended_reason = ?, updated_at = ? WHERE id = ?')
            .run(REPORT_ASSIGNMENT_STATUS[latest.kind], latest.kind, latest.kind === 'failed' ? latest.summary : null, timestamp, assignment.id)
          continue
        }
        db.prepare(`UPDATE assignments SET status = 'waiting', ended_reason = 'application_interrupted', outcome = 'unknown', updated_at = ? WHERE id = ?`).run(timestamp, assignment.id)
        const linked = effects.some(effect => {
          try { return effect.chat_id === assignment.chat_id && JSON.parse(effect.payload_json)?.assignmentId === assignment.id } catch { return false }
        })
        if (!linked) attention({ attentionId: `recovery-assignment:${assignment.id}`, chatId: assignment.chat_id, taskId: assignment.task_id,
          question: zh ? `任务执行中断，未收到最终报告，请检查产物后继续。Assignment: ${assignment.id}` : `Assignment was interrupted without a final Report. Inspect its output before continuing. Assignment: ${assignment.id}` })
        eventIds.push(repository.appendEvent({ roomId: assignment.room_id, chatId: assignment.chat_id,
          actorId: 'supervisor', type: 'assignment_recovery_required',
          payload: { assignmentId: assignment.id, runId: assignment.run_id, outcome: 'unknown' } }).eventId)
      }
      for (const taskId of affectedTasks) {
        const all = repository.listAssignments(taskId)
        const replaced = new Set(all.map(assignment => assignment.previous_assignment_id).filter(Boolean))
        const required = all.filter(assignment => assignment.required && !replaced.has(assignment.id))
        const latest = new Map(reportState.latestReports(taskId).map(report => [report.assignment_id, report]))
        let status = 'active'
        if (required.some(assignment => ['waiting', 'blocked', 'failed'].includes(assignment.status))) status = 'waiting'
        else if (required.length && required.every(assignment => assignment.status === 'completed' && latest.get(assignment.id)?.kind === 'ready')) status = 'done'
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, taskId)
      }
      return { unknownEffectIds: effects.map(effect => effect.id), interruptedAssignmentIds: assignments.filter(assignment => repository.getAssignmentContext(assignment.id).outcome === 'unknown').map(assignment => assignment.id), attentionIds, eventIds }
    })
  }

  return { recover }
}

module.exports = { createRuntimeRecovery }
