export const SKILL_FILTER_IDS = Object.freeze(['all', 'shared', 'market', 'native'])

export function skillFilterCounts(skills) {
  const rows = Array.isArray(skills) ? skills : []
  return {
    all: rows.length,
    shared: rows.filter(skill => skill?.source === 'shared').length,
    market: rows.filter(skill => skill?.source === 'market').length,
    native: rows.filter(skill => skill?.source === 'native').length,
  }
}

export function visibleSkills(skills, { filter = 'all', query = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase()
  return (Array.isArray(skills) ? skills : []).filter((skill) => {
    if (!skill) return false
    if (filter === 'shared' && skill.source !== 'shared') return false
    if (filter === 'market' && skill.source !== 'market') return false
    if (filter === 'native' && skill.source !== 'native') return false
    if (!needle) return true
    return `${skill.name || ''} ${skill.description || ''}`.toLowerCase().includes(needle)
  })
}

export function sourceLabelKey(source) {
  if (source === 'shared') return 'settingsUi.sourceShared'
  if (source === 'market') return 'settingsUi.sourceMarket'
  return 'settingsUi.sourceNative'
}

export function relativeTime(iso, locale = 'en', now = Date.now()) {
  if (!iso) return '—'
  const value = new Date(iso).getTime()
  if (!Number.isFinite(value)) return '—'
  const seconds = Math.round((value - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const steps = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.345, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ]
  let amount = seconds
  for (const [size, unit] of steps) {
    if (Math.abs(amount) < size) return formatter.format(Math.round(amount), unit)
    amount /= size
  }
  return formatter.format(Math.round(amount), 'year')
}

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
