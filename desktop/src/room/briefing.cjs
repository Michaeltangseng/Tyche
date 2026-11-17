const MAX_EARLIER = 100
const MAX_TEXT = 2000
const IN_FLIGHT = new Set(['queued', 'working', 'waiting_for_input', 'stopping'])

function attachmentSuffix(row, filesOf) {
  const files = filesOf(row) ?? []
  if (files.length === 0) return ''
  return `\n  files: ${files.join(', ')}`
}

function visible(row, me, viewerIsCaptain) {
  if (row.audience === 'captain' && !viewerIsCaptain) return false
  return true
}

function briefing({ chatTitle, me, lastSeq, rows, trigger, nameOf, filesOf = () => [], viewerIsCaptain = false }) {
  let seen = lastSeq
  let blocked = false
  const earlier = []
  const omittedSeqs = []
  const truncatedIds = []

  for (const row of rows) {
    if (!visible(row, me, viewerIsCaptain)) continue
    const mine = row.authorType === 'agent' && row.authorId === me
    if (row.id === trigger.id || mine) {
      if (!blocked) seen = Math.max(seen, row.seq)
      continue
    }
    if (IN_FLIGHT.has(row.status)) {
      blocked = true
      omittedSeqs.push(row.seq)
      continue
    }
    if (!blocked) seen = Math.max(seen, row.seq)
    const files = filesOf(row) ?? []
    if ((!row.content || row.content.length === 0) && files.length === 0) continue
    let text = row.content ?? ''
    if (text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT)
      truncatedIds.push(row.id)
    }
    earlier.push({ seq: row.seq, line: `- ${nameOf(row)}: ${text}${attachmentSuffix(row, filesOf)}` })
  }

  const triggerVisible = visible(trigger, me, viewerIsCaptain)
  const body = []
  const triggerContent = triggerVisible ? (trigger.content ?? '') : ''
  if (triggerVisible) {
    let triggerText = triggerContent
    if (triggerText.length > MAX_TEXT) {
      triggerText = triggerText.slice(0, MAX_TEXT)
      truncatedIds.push(trigger.id)
    }
    const files = filesOf(trigger) ?? []
    if (triggerText.length > 0 || files.length > 0) {
      body.push(`${nameOf(trigger)} says:`, `${triggerText}${attachmentSuffix(trigger, filesOf)}`)
    }
  }

  let older = earlier
  let omittedLine = null
  if (earlier.length > MAX_EARLIER) {
    const dropped = earlier.slice(0, earlier.length - MAX_EARLIER)
    for (const item of dropped) omittedSeqs.push(item.seq)
    older = earlier.slice(-MAX_EARLIER)
    omittedLine = `(omitted ${dropped.length} earlier messages)`
  }

  const lines = [`[chat: ${chatTitle}]`, 'Since you last looked:']
  if (omittedLine) lines.push(omittedLine)
  for (const item of older) lines.push(item.line)
  lines.push('---')
  lines.push(...body)

  return {
    text: lines.join('\n'),
    seen,
    omittedSeqs,
    truncatedIds,
  }
}

module.exports = { MAX_EARLIER, MAX_TEXT, briefing }
