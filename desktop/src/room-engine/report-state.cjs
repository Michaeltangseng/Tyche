const REPORT_ASSIGNMENT_STATUS = Object.freeze({
  progress: 'running',
  ready: 'completed',
  waiting: 'waiting',
  blocked: 'blocked',
  failed: 'failed',
  handoff: 'waiting',
})

function createReportStateService({ roomDb }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function') throw new TypeError('ROOM_REPORT_STATE_DEPENDENCIES_REQUIRED')
  const db = roomDb.database

  function latestReports(taskId) {
    const rows = db.prepare(`SELECT r.* FROM reports r
      WHERE r.task_id = ? ORDER BY r.created_at DESC, r.id DESC`).all(taskId)
    const latest = new Map()
    for (const row of rows) if (!latest.has(row.assignment_id)) latest.set(row.assignment_id, row)
    return [...latest.values()]
  }

  function reconcileTask(taskId) {
    return roomDb.withTransaction(() => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
      if (!task) throw new Error('ROOM_TASK_NOT_FOUND')
      const assignments = db.prepare('SELECT * FROM assignments WHERE task_id = ? ORDER BY created_at, id').all(taskId)
      const reports = latestReports(taskId)
      const reportByAssignment = new Map(reports.map((report) => [report.assignment_id, report]))
      for (const assignment of assignments) {
        const report = reportByAssignment.get(assignment.id)
        if (!report) continue
        const status = REPORT_ASSIGNMENT_STATUS[report.kind]
        db.prepare('UPDATE assignments SET status = ?, ended_reason = ?, outcome = ?, updated_at = ? WHERE id = ?')
          .run(status, report.kind === 'failed' ? report.summary : null, report.kind, new Date().toISOString(), assignment.id)
      }
      const required = assignments.filter((assignment) => assignment.required === 1)
      const requiredReports = required.map((assignment) => reportByAssignment.get(assignment.id)).filter(Boolean)
      let status = 'open'
      if (required.some((assignment) => ['blocked', 'failed'].includes(reportByAssignment.get(assignment.id)?.kind))) status = 'waiting'
      else if (required.length > 0 && requiredReports.length === required.length && requiredReports.every((report) => report.kind === 'ready')) status = 'done'
      else if (reports.length > 0) status = 'active'
      const timestamp = new Date().toISOString()
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, taskId)
      return { taskId, status, assignmentStatuses: assignments.map((assignment) => ({
        assignmentId: assignment.id,
        status: reportByAssignment.has(assignment.id) ? REPORT_ASSIGNMENT_STATUS[reportByAssignment.get(assignment.id).kind] : assignment.status,
      })) }
    })
  }

  return { reconcileTask, latestReports }
}

module.exports = { REPORT_ASSIGNMENT_STATUS, createReportStateService }
