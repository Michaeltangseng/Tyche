export function formatTokenCount(value) {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${trimCount(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trimCount(value / 1_000)}k`
  return String(Math.round(value))
}

function trimCount(value) {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function formatUsageLine(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  if (Number.isFinite(usage.inputTokens)) parts.push(`in ${formatTokenCount(usage.inputTokens)}`)
  if (Number.isFinite(usage.outputTokens)) parts.push(`out ${formatTokenCount(usage.outputTokens)}`)
  if (Number.isFinite(usage.cachedInputTokens)) parts.push(`cache ${formatTokenCount(usage.cachedInputTokens)}`)
  return parts.join(' · ')
}

export function indexUsageByRun(events) {
  const byRun = {}
  for (const event of events || []) {
    const payload = event?.payload
    if (payload?.kind === 'usage' && payload.usage && event.runId) byRun[event.runId] = payload.usage
  }
  return byRun
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
}

export function agentUsageRows({ roles = [], messages = [], usageByRun = {}, liveRuns = {} } = {}) {
  const totals = new Map()
  const contextPercent = new Map()
  const working = new Set()
  for (const message of messages) {
    if (message?.author_type !== 'agent' || !message.author_id) continue
    const roleId = message.author_id
    const live = liveRuns[message.id]
    if (['queued', 'working', 'waiting_for_input'].includes(message.status) || live?.status === 'running') {
      working.add(roleId)
    }
    const usage = live?.usage || usageByRun[message.id]
    if (!usage) continue
    const total = totals.get(roleId) || emptyUsage()
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens']) {
      if (Number.isFinite(usage[key])) total[key] += usage[key]
    }
    totals.set(roleId, total)
    if (Number.isFinite(usage.context?.percent)) contextPercent.set(roleId, usage.context.percent)
  }
  return roles.map(role => ({
    id: role.id,
    name: role.display_name || role.id,
    model: role.model || role.provider || '',
    status: working.has(role.id) ? 'working' : 'idle',
    usage: totals.get(role.id) || emptyUsage(),
    contextPercent: contextPercent.has(role.id) ? contextPercent.get(role.id) : null,
  }))
}

export function toolActivity(tool) {
  const name = String(tool?.name || 'tool').replace(/^mcp__[^_]+__/, '').replace(/^tyche_/, '')
  const raw = typeof tool?.input === 'string' ? tool.input : ''
  const pathMatch = raw.match(/[A-Za-z0-9_@.-][A-Za-z0-9_@./\\-]{0,180}\.[A-Za-z0-9]{1,8}/)
  const target = pathMatch ? pathMatch[0].split(/[/\\]/).pop() : ''
  let verb = 'tool'
  if (/read|cat|open/i.test(name)) verb = 'read'
  else if (/grep|search|find|rg/i.test(name)) verb = 'search'
  else if (/bash|shell|exec|command|terminal/i.test(name)) verb = 'run'
  else if (/write|edit|patch|strreplace/i.test(name)) verb = 'write'
  return { verb, target, name }
}

export function previewText(text, limit = 12) {
  const lines = String(text ?? '').split('\n')
  if (lines.length <= limit) return { text: String(text ?? ''), truncated: false, hidden: 0 }
  return { text: lines.slice(0, limit).join('\n'), truncated: true, hidden: lines.length - limit }
}
