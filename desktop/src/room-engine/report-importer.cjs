const REPORT_MARKER = /\[\[MELDWORK_REPORT:(\{[\s\S]*\})\]\]/g
const REPORT_KINDS = new Set(['progress', 'ready', 'waiting', 'blocked', 'failed', 'handoff'])
const REPORT_FIELDS = new Set(['reportId', 'kind', 'summary', 'evidence', 'artifacts', 'nextRequest', 'attentionId'])

function parseReportMarker(content) {
  if (typeof content !== 'string') throw new TypeError('ROOM_REPORT_CONTENT_INVALID')
  // Native CLIs occasionally append a short human-readable tail after the
  // machine marker. The marker itself remains the authoritative payload.
  const matches = [...content.matchAll(REPORT_MARKER)]
  const match = matches.at(-1)
  if (!match) return null
  let value
  try { value = JSON.parse(match[1]) } catch { throw new TypeError('ROOM_REPORT_MARKER_JSON_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('ROOM_REPORT_MARKER_INVALID')
  for (const key of Object.keys(value)) if (!REPORT_FIELDS.has(key)) throw new TypeError('ROOM_REPORT_MARKER_UNKNOWN_FIELD')
  if (!REPORT_KINDS.has(value.kind)) throw new TypeError('ROOM_REPORT_KIND_INVALID')
  if (typeof value.summary !== 'string' || value.summary.length === 0 || value.summary.length > 100_000) {
    throw new TypeError('ROOM_REPORT_SUMMARY_INVALID')
  }
  if (value.reportId !== undefined && (typeof value.reportId !== 'string' || value.reportId.length === 0)) {
    throw new TypeError('ROOM_REPORT_ID_INVALID')
  }
  for (const field of ['evidence', 'artifacts']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string'))) {
      throw new TypeError(`ROOM_REPORT_${field.toUpperCase()}_INVALID`)
    }
  }
  return {
    reportId: value.reportId,
    kind: value.kind,
    summary: value.summary,
    evidence: value.evidence || [],
    artifactIds: value.artifacts || [],
    nextRequest: value.nextRequest === undefined ? null : value.nextRequest,
    attentionId: value.attentionId === undefined ? null : value.attentionId,
  }
}

function createReportImporter({ roomDb, repository }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) {
    throw new TypeError('ROOM_REPORT_IMPORTER_DEPENDENCIES_REQUIRED')
  }

  function importFromMessage({ chatId, taskId, assignmentId, actorId, content, platformArtifactIds = [] }) {
    const report = parseReportMarker(content)
    if (!report) return { imported: false, report: null, event: null }
    if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('ROOM_REPORT_ACTOR_INVALID')
    return roomDb.withTransaction(() => {
      const assignment = roomDb.database.prepare(`
        SELECT a.id, a.task_id, t.chat_id, c.room_id
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN chats c ON c.id = t.chat_id
        WHERE a.id = ?`).get(assignmentId)
      if (!assignment || assignment.task_id !== taskId || assignment.chat_id !== chatId) {
        throw new Error('ROOM_REPORT_ASSIGNMENT_MISMATCH')
      }
      if (report.reportId) {
        const existing = repository.getReport(report.reportId)
        if (existing) {
          if (existing.task_id !== taskId || existing.assignment_id !== assignmentId) throw new Error('ROOM_REPORT_ID_REUSED')
          return { imported: false, duplicate: true, report: existing, event: null }
        }
      }
      for (const artifactId of report.artifactIds) {
        const artifact = roomDb.database.prepare('SELECT room_id FROM artifacts WHERE id = ?').get(artifactId)
        if (artifact?.room_id !== assignment.room_id) throw new Error('ROOM_REPORT_ARTIFACT_SCOPE_INVALID')
      }
      for (const artifactId of platformArtifactIds) {
        const artifact = roomDb.database.prepare('SELECT room_id, source_assignment_id FROM artifacts WHERE id = ?').get(artifactId)
        if (artifact?.room_id !== assignment.room_id || artifact.source_assignment_id !== assignmentId) throw new Error('ROOM_REPORT_ARTIFACT_SCOPE_INVALID')
      }
      report.artifactIds = [...new Set([...report.artifactIds, ...platformArtifactIds])]
      const reportId = repository.createReport({ ...report, reportId: report.reportId, taskId, assignmentId })
      const event = repository.appendEvent({
        roomId: assignment.room_id,
        chatId,
        actorId,
        type: 'report_received',
        reportId,
        payload: { taskId, assignmentId, reportKind: report.kind },
      })
      return { imported: true, duplicate: false, report: repository.getReport(reportId), event }
    })
  }

  return { parseReportMarker, importFromMessage }
}

module.exports = { REPORT_KINDS, parseReportMarker, createReportImporter }
