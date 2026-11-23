const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { nativeIdentityDirectory } = require('./native-config-directory.cjs')
const { agentLabel } = require('../skills/skill-adapters.cjs')

const MAX_CONFIG_BYTES = 2 * 1024 * 1024

const JSON_CONFIGS = Object.freeze({
  claude: ['settings.json'],
  gemini: ['settings.json'],
  qwen: ['settings.json'],
  pi: ['settings.json'],
  workbuddy: ['settings.json'],
  opencode: ['opencode.json', 'opencode.jsonc'],
  openclaw: ['openclaw.json'],
  hermes: ['config.json'],
  zcode: ['config.json'],
  opencodereview: ['config.json'],
})

const TOML_CONFIGS = Object.freeze({
  codex: ['config.toml'],
  kimi: ['config.toml'],
})

function readText(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file) {
  const text = readText(file)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function transportOf(value) {
  const type = String(value?.type || value?.transport || '').toLowerCase()
  if (type.includes('http')) return 'http'
  if (type.includes('sse')) return 'sse'
  if (type.includes('stdio') || type === 'local') return 'stdio'
  if (typeof value?.url === 'string' && value.url) return 'http'
  if (typeof value?.command === 'string' && value.command) return 'stdio'
  return 'unknown'
}

function addServer(found, name, value) {
  if (typeof name !== 'string' || !name.trim()) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  found.push({ name: name.trim(), transport: transportOf(value) })
}

function serversFromJson(file, { includeMcp = false } = {}) {
  const data = readJson(file)
  const found = []
  if (!data || typeof data !== 'object') return found
  const keys = includeMcp ? ['mcpServers', 'servers', 'mcp'] : ['mcpServers', 'servers']
  for (const key of keys) {
    const map = data[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    if (key === 'mcp' && map.servers && typeof map.servers === 'object') {
      for (const [name, value] of Object.entries(map.servers)) addServer(found, name, value)
      continue
    }
    for (const [name, value] of Object.entries(map)) {
      if (name === 'servers') continue
      addServer(found, name, value)
    }
  }
  if (data.projects && typeof data.projects === 'object') {
    for (const project of Object.values(data.projects)) {
      const map = project?.mcpServers
      if (!map || typeof map !== 'object') continue
      for (const [name, value] of Object.entries(map)) addServer(found, name, value)
    }
  }
  return found
}

function serversFromToml(file) {
  const text = readText(file)
  const found = []
  if (!text) return found
  let current = null
  let value = {}
  const flush = () => {
    if (current) addServer(found, current, value)
    current = null
    value = {}
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const section = line.match(/^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/)
    if (section) {
      flush()
      current = section[1] || section[2] || section[3]
      continue
    }
    if (/^\[/.test(line)) {
      flush()
      continue
    }
    if (!current) continue
    const pair = line.match(/^(command|url|type|transport)\s*=\s*"([^"]*)"/)
    if (pair) value[pair[1]] = pair[2]
  }
  flush()
  return found
}

function configDirectory(kind, home) {
  try {
    return nativeIdentityDirectory(kind, process.env, home, process.platform)
  } catch {
    return ''
  }
}

function listNativeMcpServers({ home = os.homedir() } = {}) {
  const merged = new Map()
  const add = (kind, servers) => {
    for (const server of servers) {
      const key = `${server.name}\u0000${server.transport}`
      const entry = merged.get(key) || {
        name: server.name,
        transport: server.transport,
        agents: new Set(),
      }
      entry.agents.add(agentLabel(kind))
      merged.set(key, entry)
    }
  }
  for (const [kind, files] of Object.entries(JSON_CONFIGS)) {
    const directory = configDirectory(kind, home)
    if (!directory) continue
    for (const file of files) {
      add(kind, serversFromJson(path.join(directory, file), { includeMcp: kind === 'opencode' }))
    }
  }
  for (const [kind, files] of Object.entries(TOML_CONFIGS)) {
    const directory = configDirectory(kind, home)
    if (!directory) continue
    for (const file of files) add(kind, serversFromToml(path.join(directory, file)))
  }
  const claudeRoot = configDirectory('claude', home)
  if (claudeRoot) {
    add('claude', serversFromJson(path.join(home, '.claude.json')))
    add('claude', serversFromJson(path.join(claudeRoot, 'settings.json')))
  }
  return [...merged.values()]
    .map(entry => ({
      name: entry.name,
      transport: entry.transport,
      agents: [...entry.agents].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

module.exports = { listNativeMcpServers }
