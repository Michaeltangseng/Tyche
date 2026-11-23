const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_LIMITS,
  frontmatterFields,
  walkSkillFiles,
} = require('./skill-library-util.cjs')

const STANDARD_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
const TEXT_EXTENSIONS = new Set([
  '', '.md', '.txt', '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.rb', '.go', '.rs', '.java', '.sql',
])
const MAX_SCAN_FILE_BYTES = 256 * 1024
const MAX_SCAN_TOTAL_BYTES = 2 * 1024 * 1024
const SEVERITY_ORDER = { none: 0, info: 1, low: 2, medium: 3, high: 4 }

function emptyReport() {
  return { level: 'none', labels: [], findings: [], scannedAt: new Date().toISOString(), truncated: false }
}

function addFinding(report, code, severity, detail, label = code) {
  report.labels.add(label)
  report.findings.push({ code, severity, detail })
  if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[report.level]) report.level = severity
}

function looksLikeText(filename) {
  const extension = path.extname(filename).toLowerCase()
  return TEXT_EXTENSIONS.has(extension)
}

function scanText(report, relativePath, text, { scripts = false } = {}) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const where = `${relativePath}:${index + 1}`
    if (/`![^`]+`/.test(line) || /^\s*![A-Za-z0-9_./-]/.test(line)) {
      addFinding(report, 'dynamic-command', 'high', `dynamic shell command at ${where}`, 'dynamic-command')
    }
    if (/\b(eval|exec)\s*\(/.test(line) || /\b(base64\s+-d|base64\s+--decode)\b/.test(line)) {
      addFinding(report, 'dynamic-command', 'high', `dynamic code execution at ${where}`, 'dynamic-command')
    }
    if (/\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/.test(line)) {
      addFinding(report, 'dynamic-command', 'high', `network script pipeline at ${where}`, 'dynamic-command')
    }
    if (scripts && /\b(curl|wget|nc|netcat|ssh|scp)\b/.test(line)) {
      addFinding(report, 'network', 'medium', `network command at ${where}`, 'network')
    }
    if (/\b(rm\s+-rf|sudo\b|chmod\s+\+x)\b/.test(line)) {
      addFinding(report, 'file-write', 'medium', `filesystem command at ${where}`, 'file-write')
    }
    if (/(^|\s)\.\.\//.test(line)) {
      addFinding(report, 'external-paths', 'medium', `reference outside the Skill directory at ${where}`, 'external-paths')
    }
  }
}

function scanSkill(directory, limits = DEFAULT_LIMITS) {
  const report = {
    ...emptyReport(),
    labels: new Set(),
  }
  let walked
  try {
    walked = walkSkillFiles(directory, { limits })
  } catch (error) {
    const label = error?.code === 'SKILL_TOO_LARGE' ? 'large-assets' : 'unreadable'
    report.level = 'medium'
    report.labels.add(label)
    report.findings.push({
      code: label,
      severity: 'medium',
      detail: error?.code || 'SKILL_UNREADABLE',
    })
    report.labels = [...report.labels].sort()
    return report
  }

  const skillFile = path.join(directory, 'SKILL.md')
  let header = ''
  try {
    const stat = fs.statSync(skillFile)
    if (stat.isFile() && stat.size <= limits.maxFileBytes) header = fs.readFileSync(skillFile, 'utf8')
  } catch { /* a missing SKILL.md is reported by the caller */ }
  const parsed = frontmatterFields(header)
  const allowedTools = String(parsed.fields['allowed-tools'] || '')
  if (/\b(bash|shell|exec|terminal|computer|\*)\b/i.test(allowedTools)) {
    addFinding(report, 'shell-tools', 'high', 'allowed-tools grants shell access', 'shell-tools')
  }
  for (const field of Object.keys(parsed.fields)) {
    if (!STANDARD_FIELDS.has(field)) {
      addFinding(report, 'nonstandard-fields', 'info', `non-standard frontmatter field: ${field}`, 'nonstandard-fields')
    }
  }
  if (Object.hasOwn(parsed.fields, 'hooks')) {
    addFinding(report, 'hooks', 'high', 'hook declarations in SKILL.md', 'hooks')
  }
  scanText(report, 'SKILL.md', header)

  let remaining = MAX_SCAN_TOTAL_BYTES
  for (const file of walked.files) {
    const relative = file.relativePath
    if (relative === 'SKILL.md') continue
    if (relative.split('/').includes('hooks')) {
      addFinding(report, 'hooks', 'high', `hook file: ${relative}`, 'hooks')
    }
    if (relative.startsWith('scripts/') || (file.mode & 0o111) !== 0) {
      addFinding(report, 'scripts', 'medium', `executable content: ${relative}`, 'scripts')
    }
    if (file.size > 256 * 1024) {
      addFinding(report, 'large-assets', 'low', `large file: ${relative}`, 'large-assets')
    }
    if (remaining <= 0 || file.size > MAX_SCAN_FILE_BYTES || !looksLikeText(file.filename)) continue
    let text
    try {
      text = fs.readFileSync(file.filename, 'utf8').slice(0, MAX_SCAN_FILE_BYTES)
    } catch {
      continue
    }
    remaining -= Buffer.byteLength(text)
    if (remaining < 0) report.truncated = true
    scanText(report, relative, text, { scripts: relative.startsWith('scripts/') })
  }

  report.labels = [...report.labels].sort()
  report.findings = report.findings.slice(0, 50)
  return report
}

module.exports = { scanSkill }
