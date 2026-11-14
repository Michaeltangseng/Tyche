const CHECKPOINT_MARKER_PREFIX = '[[MELDWORK_CHECKPOINT:'
const REVIEW_MARKER_PREFIX = '[[MELDWORK_REVIEW:'
const CHECKPOINT_SIGNALS = new Set(['ready', 'question', 'continue'])
const REVIEW_VERDICTS = new Set(['pass', 'revise', 'needs-human'])

function lastNonEmptyLine(text) {
  const lines = String(text || '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) return lines[index].trim()
  }
  return ''
}

function parseMarker(text, prefix, field, allowed) {
  const line = lastNonEmptyLine(text)
  if (!line.startsWith(prefix) || !line.endsWith(']]')) return null
  const json = line.slice(prefix.length, -2)
  let value
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== field) return null
  return allowed.has(value[field]) ? value[field] : null
}

function parseCheckpointSignal(text) {
  return parseMarker(text, CHECKPOINT_MARKER_PREFIX, 'signal', CHECKPOINT_SIGNALS)
}

function parseReviewVerdict(text) {
  return parseMarker(text, REVIEW_MARKER_PREFIX, 'verdict', REVIEW_VERDICTS)
}

function markerIsHidden(line, prefixes) {
  const value = String(line || '')
  return prefixes.some(prefix => value.includes(prefix))
}

module.exports = {
  CHECKPOINT_MARKER_PREFIX,
  CHECKPOINT_SIGNALS,
  REVIEW_MARKER_PREFIX,
  REVIEW_VERDICTS,
  markerIsHidden,
  parseCheckpointSignal,
  parseReviewVerdict,
}
