const fs = require('node:fs')
const path = require('node:path')

const RANGES = new Set(['today', 'week', 'month'])
const DEFAULT_SETTINGS = Object.freeze({
  monthlyBudgetUsd: 60,
  warnAtPercent: 80,
  overBudgetAction: 'warn',
  roomDailyLimitUsd: 10,
  maxTokensPerTurn: 200000,
})

// List prices per 1M tokens. These are estimates for providers that do not
// report a cost on the usage event; the UI labels the result as estimated.
const PRICES = Object.freeze({
  claude: { input: 3, output: 15, cache: 0.3 },
  codex: { input: 1.25, output: 10, cache: 0.125 },
  gemini: { input: 1.25, output: 10, cache: 0.31 },
  pi: { input: 1, output: 5, cache: 0.1 },
  deepseek: { input: 0.27, output: 1.1, cache: 0.07 },
  qwen: { input: 0.4, output: 1.2, cache: 0.1 },
  kimi: { input: 0.6, output: 2.5, cache: 0.15 },
  fallback: { input: 1, output: 5, cache: 0.1 },
})

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function tokenCost(provider, input, output, cached) {
  const price = PRICES[provider] || PRICES.fallback
  return (input * price.input + output * price.output + cached * price.cache) / 1_000_000
}

function startOfDay(date) {
  const value = new Date(date)
  value.setHours(0, 0, 0, 0)
  return value
}

function rangeStart(range, now) {
  const value = startOfDay(now)
  if (range === 'today') return value
  if (range === 'week') {
    const weekday = (value.getDay() + 6) % 7
    value.setDate(value.getDate() - weekday)
    return value
  }
  value.setDate(1)
  return value
}

function localDateKey(value) {
  const date = new Date(value)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function enumerateDays(start, end) {
  const days = []
  const cursor = startOfDay(start)
  const last = startOfDay(end)
  while (cursor <= last) {
    days.push(localDateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

function usageOf(row) {
  if (!row?.data_json) return null
  try {
    const data = JSON.parse(row.data_json)
    return data?.usage && typeof data.usage === 'object' ? data.usage : null
  } catch {
    return null
  }
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalizeSettings(value)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {}
  const settings = { ...DEFAULT_SETTINGS }
  if (Number.isFinite(Number(input.monthlyBudgetUsd)) && Number(input.monthlyBudgetUsd) >= 0) {
    settings.monthlyBudgetUsd = Number(input.monthlyBudgetUsd)
  }
  if (Number.isFinite(Number(input.warnAtPercent))) {
    settings.warnAtPercent = Math.min(100, Math.max(1, Number(input.warnAtPercent)))
  }
  if (['warn', 'pause'].includes(input.overBudgetAction)) settings.overBudgetAction = input.overBudgetAction
  if (Number.isFinite(Number(input.roomDailyLimitUsd)) && Number(input.roomDailyLimitUsd) >= 0) {
    settings.roomDailyLimitUsd = Number(input.roomDailyLimitUsd)
  }
  if (Number.isFinite(Number(input.maxTokensPerTurn)) && Number(input.maxTokensPerTurn) >= 0) {
    settings.maxTokensPerTurn = Number(input.maxTokensPerTurn)
  }
  return settings
}

function writeSettings(file, value) {
  const settings = normalizeSettings(value)
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  return settings
}

function createUsageReport({ roomDb, privateRoot, now = () => new Date() }) {
  const { database } = roomDb
  const settingsPath = path.join(privateRoot, 'usage-settings.json')

  function report(range = 'month') {
    const selectedRange = RANGES.has(range) ? range : 'month'
    const current = now()
    const start = rangeStart(selectedRange, current)
    const monthStart = rangeStart('month', current)
    const queryStart = start < monthStart ? start : monthStart
    const rows = database.prepare(`
      SELECT m.created_at, m.status, m.chat_id, m.data_json,
             r.provider, r.model, r.display_name,
             c.room_id, rooms.name AS room_name
      FROM messages m
      JOIN chat_roles r ON r.id = m.author_id
      JOIN chats c ON c.id = m.chat_id
      JOIN rooms ON rooms.id = c.room_id
      WHERE m.author_type = 'agent' AND m.created_at >= ?
    `).all(queryStart.toISOString())

    const days = enumerateDays(start, current)
    const series = new Map(days.map(day => [day, {
      date: day,
      total: 0,
      providers: {},
      providerTokens: {},
      rooms: {},
      roomProviders: {},
    }]))
    const byRoom = new Map()
    const byProvider = new Map()
    let totalTokens = 0
    let totalCostUsd = 0
    let monthlyCostUsd = 0
    let turns = 0
    let interrupted = 0
    let estimated = false

    for (const row of rows) {
      const usage = usageOf(row)
      if (!usage) continue
      const input = numberOrZero(usage.inputTokens)
      const output = numberOrZero(usage.outputTokens)
      const cached = numberOrZero(usage.cachedInputTokens)
      const tokens = input + output + cached
      if (tokens === 0) continue
      const provider = String(row.provider || 'unknown')
      const reportedCost = Number(usage.costUsd ?? usage.costMicros / 1_000_000)
      const hasReported = Number.isFinite(reportedCost) && reportedCost >= 0
      const cost = hasReported ? reportedCost : tokenCost(provider, input, output, cached)
      if (!hasReported) estimated = true
      if (row.created_at >= monthStart.toISOString()) monthlyCostUsd += cost
      if (row.created_at < start.toISOString()) continue

      totalTokens += tokens
      totalCostUsd += cost
      turns += 1
      if (row.status === 'stopped' || row.status === 'failed') interrupted += 1

      const day = localDateKey(row.created_at)
      const point = series.get(day)
      const roomKey = String(row.room_id || '')
      if (point) {
        point.total += cost
        point.providers[provider] = (point.providers[provider] || 0) + cost
        point.providerTokens[provider] = (point.providerTokens[provider] || 0) + tokens
        const roomPoint = point.rooms[roomKey] || { tokens: 0, costUsd: 0 }
        roomPoint.tokens += tokens
        roomPoint.costUsd += cost
        point.rooms[roomKey] = roomPoint
        const roomProvider = point.roomProviders[roomKey] || {}
        const providerPoint = roomProvider[provider] || { tokens: 0, costUsd: 0 }
        providerPoint.tokens += tokens
        providerPoint.costUsd += cost
        roomProvider[provider] = providerPoint
        point.roomProviders[roomKey] = roomProvider
      }

      const room = byRoom.get(roomKey) || {
        id: roomKey, name: row.room_name || roomKey, tokens: 0, costUsd: 0, providers: {},
      }
      room.tokens += tokens
      room.costUsd += cost
      const roomProvider = room.providers[provider] || { tokens: 0, costUsd: 0 }
      roomProvider.tokens += tokens
      roomProvider.costUsd += cost
      room.providers[provider] = roomProvider
      byRoom.set(roomKey, room)

      const agent = byProvider.get(provider) || { provider, tokens: 0, costUsd: 0, rooms: {} }
      agent.tokens += tokens
      agent.costUsd += cost
      const agentRoom = agent.rooms[roomKey] || { tokens: 0, costUsd: 0 }
      agentRoom.tokens += tokens
      agentRoom.costUsd += cost
      agent.rooms[roomKey] = agentRoom
      byProvider.set(provider, agent)
    }

    const rooms = [...byRoom.values()]
      .sort((left, right) => right.costUsd - left.costUsd)
    const agents = [...byProvider.values()]
      .map(agent => ({
        ...agent,
        share: totalCostUsd > 0 ? agent.costUsd / totalCostUsd : 0,
      }))
      .sort((left, right) => right.costUsd - left.costUsd)

    const settings = readSettings(settingsPath)
    const budgetPercent = settings.monthlyBudgetUsd > 0
      ? (monthlyCostUsd / settings.monthlyBudgetUsd) * 100
      : 0

    return {
      range: selectedRange,
      start: start.toISOString(),
      generatedAt: current.toISOString(),
      totals: {
        costUsd: totalCostUsd,
        monthlyCostUsd,
        tokens: totalTokens,
        turns,
        interrupted,
        estimated,
      },
      series: [...series.values()],
      rooms,
      agents,
      budget: {
        ...settings,
        usedPercent: budgetPercent,
        overBudget: settings.monthlyBudgetUsd > 0 && monthlyCostUsd > settings.monthlyBudgetUsd,
        warn: settings.monthlyBudgetUsd > 0 && budgetPercent >= settings.warnAtPercent,
        // Budget settings are informational until the runtime enforces them.
        enforced: false,
      },
    }
  }

  return {
    report,
    settings: () => readSettings(settingsPath),
    updateSettings: input => writeSettings(settingsPath, input),
  }
}

module.exports = { createUsageReport, DEFAULT_SETTINGS, PRICES }
