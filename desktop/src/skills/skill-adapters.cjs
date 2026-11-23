const {
  SUPPORTED_KINDS,
  primarySkillRoot,
} = require('./local-skill-catalog.cjs')

const AGENT_KINDS = Object.freeze([
  'claude', 'codex', 'gemini', 'pi', 'hermes', 'kimi', 'deepseek', 'qwen', 'opencode', 'openclaw', 'workbuddy',
].filter(kind => SUPPORTED_KINDS.has(kind)))

const AGENT_LABELS = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  pi: 'Pi',
  hermes: 'Hermes',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  workbuddy: 'WorkBuddy',
})

function agentLabel(kind) {
  return AGENT_LABELS[kind] || String(kind || '')
}

function agentConfigDirectory(kind, configDirectoryForKind) {
  if (typeof configDirectoryForKind !== 'function') return ''
  try {
    return String(configDirectoryForKind(kind) || '')
  } catch {
    return ''
  }
}

function adapterFor(kind, { home, configDirectoryForKind } = {}) {
  if (!AGENT_KINDS.includes(kind)) return null
  const configDirectory = agentConfigDirectory(kind, configDirectoryForKind)
  let root = ''
  try {
    root = primarySkillRoot(kind, home, configDirectory)
  } catch {
    root = ''
  }
  return Object.freeze({
    kind,
    label: agentLabel(kind),
    root,
    canProject: Boolean(root),
    displayName: agentLabel(kind),
  })
}

function agentCapabilities(options = {}) {
  return Object.fromEntries(AGENT_KINDS.map((kind) => {
    const adapter = adapterFor(kind, options)
    return [kind, {
      label: agentLabel(kind),
      projectable: adapter?.canProject === true,
    }]
  }))
}

module.exports = {
  AGENT_KINDS,
  AGENT_LABELS,
  adapterFor,
  agentCapabilities,
  agentLabel,
}
