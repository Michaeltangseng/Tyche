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
    days.push({ key: dayKey(day), label: String(day.getDate()), count: 0 })
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
  const delta = previous > 0 ? Math.round(((current - previous) / previous) * 100) : null
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
