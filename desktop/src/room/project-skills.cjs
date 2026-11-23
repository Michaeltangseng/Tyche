const fs = require('node:fs')
const path = require('node:path')

const PROVIDER_ROOTS = Object.freeze({
  claude: ['.claude/skills'],
  codex: ['.codex/skills'],
  gemini: ['.gemini/skills'],
  hermes: ['.hermes/skills'],
  deepseek: ['.dsh/skills'],
  kimi: ['.kimi/skills'],
  qwen: ['.qwen/skills'],
  opencode: ['.config/opencode/skills'],
  openclaw: ['.openclaw/skills'],
  workbuddy: ['.workbuddy/skills'],
})

function rootsFor(providers) {
  const roots = new Set()
  for (const provider of providers || []) {
    for (const root of PROVIDER_ROOTS[provider] || ['.agents/skills']) roots.add(root)
  }
  return [...roots]
}

function readManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && value.workspaces && typeof value.workspaces === 'object'
      ? value
      : { workspaces: {} }
  } catch {
    return { workspaces: {} }
  }
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function sameLink(link, target) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false
    return fs.realpathSync(link) === fs.realpathSync(target)
  } catch {
    return false
  }
}

function isSymlink(link) {
  try { return fs.lstatSync(link).isSymbolicLink() } catch { return false }
}

function createProjectSkillSync({ stateRoot, platform = process.platform } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new TypeError('PROJECT_SKILL_STATE_ROOT_REQUIRED')
  }
  const manifestPath = path.join(stateRoot, 'project-skills.json')

  function sync({ workspace, providers = [], skills = [] } = {}) {
    const root = typeof workspace === 'string' ? path.resolve(workspace) : ''
    if (!root) throw new Error('PROJECT_SKILL_WORKSPACE_REQUIRED')
    if (platform === 'win32') {
      return { supported: false, linked: [], conflicts: [], removed: [] }
    }
    const manifest = readManifest(manifestPath)
    const existing = manifest.workspaces[root]?.links || {}
    const desired = new Map()
    const conflicts = []
    const linked = []
    const roots = skills.length ? rootsFor(providers) : []
    for (const relativeRoot of roots) {
      const directory = path.join(root, ...relativeRoot.split('/'))
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      for (const skill of skills) {
        const target = path.resolve(String(skill.sourceDirectory || ''))
        if (!target || !fs.existsSync(target)) {
          conflicts.push({ name: skill.name, path: directory, reason: 'source-missing' })
          continue
        }
        const link = path.join(directory, skill.name)
        const record = { skillId: skill.id, target }
        if (fs.existsSync(link) || isSymlink(link)) {
          if (sameLink(link, target)) {
            desired.set(link, record)
            linked.push({ name: skill.name, path: link })
          } else {
            conflicts.push({ name: skill.name, path: link, reason: 'occupied' })
          }
          continue
        }
        try {
          fs.symlinkSync(path.relative(directory, target), link, 'dir')
          desired.set(link, record)
          linked.push({ name: skill.name, path: link })
        } catch (error) {
          conflicts.push({
            name: skill.name,
            path: link,
            reason: ['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)
              ? 'unsupported'
              : 'failed',
          })
        }
      }
    }
    const removed = []
    for (const [link, record] of Object.entries(existing)) {
      if (desired.has(link)) continue
      if (sameLink(link, record.target)) {
        try { fs.unlinkSync(link); removed.push(link) } catch { /* keep the link */ }
      }
    }
    manifest.workspaces[root] = { links: Object.fromEntries(desired) }
    writeManifest(manifestPath, manifest)
    return { supported: true, linked, conflicts, removed }
  }

  function clear({ workspace } = {}) {
    const root = typeof workspace === 'string' ? path.resolve(workspace) : ''
    if (!root) return { removed: [] }
    const manifest = readManifest(manifestPath)
    const links = manifest.workspaces[root]?.links || {}
    const removed = []
    for (const [link, record] of Object.entries(links)) {
      if (!sameLink(link, record.target)) continue
      try { fs.unlinkSync(link); removed.push(link) } catch { /* keep the link */ }
    }
    delete manifest.workspaces[root]
    writeManifest(manifestPath, manifest)
    return { removed }
  }

  return { sync, clear, manifestPath }
}

module.exports = { createProjectSkillSync, PROVIDER_ROOTS }
