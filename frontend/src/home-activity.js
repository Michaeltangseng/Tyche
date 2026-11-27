function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function weeklyActivity(rows, now = new Date()) {
  const today = dayStart(now)
  const days = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setDate(today.getDate() - offset)
    days.push({ key: dayKey(day), label: String(day.getDate()), weekday: day.getDay(), count: 0 })
  }
  const index = new Map(days.map((day, slot) => [day.key, slot]))
  const seen = new Set()
  const previousSeen = new Set()
  let previous = 0
  for (const row of rows || []) {
    const at = new Date(row?.at || '')
    if (Number.isNaN(at.getTime())) continue
    const key = dayKey(at)
    const id = `${row?.id || ''}:${key}`
    const slot = index.get(key)
    if (slot !== undefined) {
      if (seen.has(id)) continue
      seen.add(id)
      days[slot].count += 1
      continue
    }
    const age = (today.getTime() - dayStart(at).getTime()) / 86400000
    if (age >= 7 && age <= 13) {
      if (previousSeen.has(id)) continue
      previousSeen.add(id)
      previous += 1
    }
  }
  const current = days.reduce((sum, day) => sum + day.count, 0)
  const todayCount = days.at(-1)?.count || 0
  // A one-chat week turns a normal week into a huge percent. Wait for a real baseline.
  const delta = previous >= 3 ? Math.round(((current - previous) / previous) * 100) : null
  return { days, current, previous, today: todayCount, delta }
}

export function relativeTime(value, now = Date.now()) {
  const at = new Date(value || '').getTime()
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return { key: 'home.justNow', count: 0 }
  if (minutes < 60) return { key: 'home.minutesAgo', count: minutes }
  const hours = Math.round(minutes / 60)
  if (hours < 24) return { key: 'home.hoursAgo', count: hours }
  return { key: 'home.daysAgo', count: Math.round(hours / 24) }
}

const USAGE_COLORS = {
  claude: '#f5a524',
  codex: '#4c8dff',
  pi: '#3ecf8e',
  gemini: '#b07cff',
  deepseek: '#2dd4bf',
  qwen: '#f472b6',
  kimi: '#a78bfa',
  hermes: '#67e8f9',
}
const USAGE_FALLBACK = ['#67e8f9', '#93c5fd', '#fca5a5', '#fcd34d', '#c4b5fd']

export function usageColor(provider) {
  if (USAGE_COLORS[provider]) return USAGE_COLORS[provider]
  let hash = 0
  for (const char of String(provider || '')) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return USAGE_FALLBACK[hash % USAGE_FALLBACK.length]
}

export function localDayKey(date = new Date()) {
  return dayKey(date)
}

export function weekdayOf(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day).getDay()
}
