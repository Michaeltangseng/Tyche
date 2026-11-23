export const SKILL_FILTER_IDS = Object.freeze(['all', 'shared', 'market', 'native'])

export const SKILL_CATEGORY_KEYS = Object.freeze([
  'data', 'efficiency', 'design', 'research', 'creative', 'development', 'other',
])

const CATEGORY_RULES = [
  ['research', /(research|paper|arxiv|search|crawl|scrape|研究|搜索|抓取)/i],
  ['design', /(design|figma|ui\b|ux\b|diagram|svg|image|video|motion|视觉|设计|图形)/i],
  ['creative', /(ascii|art\b|creative|story|write|blog|创意|写作)/i],
  ['data', /(data|sql|database|csv|excel|analytic|chart|数据|分析|表格)/i],
  ['efficiency', /(notes?|reminders?|calendar|email|slack|notify|memo|效率|提醒|笔记|通知)/i],
  ['development', /(code|cli\b|git\b|test|review|api|develop|开发|代码|审查)/i],
]

export function skillCategoryKey(skill) {
  const text = `${skill?.name || ''} ${skill?.description || ''}`
  for (const [key, rule] of CATEGORY_RULES) {
    if (rule.test(text)) return key
  }
  return 'other'
}

export function avatarTone(name) {
  const tones = ['cyan', 'blue', 'violet', 'pink', 'orange', 'green', 'amber']
  let hash = 0
  for (const char of String(name || '')) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return tones[hash % tones.length]
}

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
