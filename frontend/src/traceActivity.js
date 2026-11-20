const WRITE_TOOL_NAMES = new Set([
  'applydiff',
  'applypatch',
  'createfile',
  'delete',
  'deletefile',
  'edit',
  'editfile',
  'filechange',
  'multiedit',
  'remove',
  'removefile',
  'notebookedit',
  'patch',
  'strreplace',
  'write',
  'writefile',
])

const FILE_PATH_FIELDS = [
  'file_path', 'filePath', 'file', 'path', 'notebook_path', 'notebookPath', 'absolute_path',
]

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function normalizeText(value) {
  return typeof value === 'string' ? value : ''
}

export function groupToolSteps(steps = []) {
  const groups = new Map()
  for (const [index, step] of (Array.isArray(steps) ? steps : []).entries()) {
    if (step?.kind !== 'tool') continue
    const key = String(step.toolCallId || `seq:${step.seq ?? index}`)
    let group = groups.get(key)
    if (!group) {
      group = { key, steps: [] }
      groups.set(key, group)
    }
    group.steps.push(step)
  }
  return [...groups.values()]
}

export function resolveToolInput(steps = []) {
  const values = Array.isArray(steps) ? steps : []
  const streamed = values
    .filter(step => typeof step?.input === 'string')
    .map(step => step.input)
    .join('')
  if (streamed.trim().startsWith('{') || streamed.trim().startsWith('[')) {
    try {
      return JSON.parse(streamed)
    } catch { /* the stream may be truncated; fall back to the last full input */ }
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const input = values[index]?.input
    if (input && typeof input === 'object' && !Array.isArray(input)) return input
  }
  return null
}

export function toolTitle(steps = []) {
  for (const step of steps) {
    const title = String(step?.title || '').trim()
    if (title && !['tool', 'tool_result', 'event', 'file_change'].includes(title.toLowerCase())) {
      return title
    }
  }
  return ''
}

export function toolOutput(steps = []) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (typeof steps[index]?.output === 'string' && steps[index].output) {
      return steps[index].output
    }
  }
  return ''
}

export function toolStatus(steps = []) {
  const last = steps.at(-1)
  return String(last?.status || steps[0]?.status || 'completed')
}

function inputPath(input) {
  if (!input || typeof input !== 'object') return ''
  for (const field of FILE_PATH_FIELDS) {
    if (typeof input[field] === 'string' && input[field]) return input[field]
  }
  return ''
}

function outputPath(output) {
  const text = normalizeText(output)
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /(?:created|updated|written|wrote|saved|deleted|removed|moved|renamed)/i.test(line))
  if (!firstLine) return ''
  const absolute = firstLine.match(/((?:[A-Za-z]:[\\/]|\/)[^\s"'`]+)/)
  return absolute ? absolute[1].replace(/[.,;:]+$/, '') : ''
}

function changeList(input) {
  const changes = input?.changes
  if (Array.isArray(changes)) {
    return changes
      .map(change => ({
        path: String(change?.path || change?.file_path || change?.file || ''),
        change,
      }))
      .filter(item => item.path)
  }
  if (changes && typeof changes === 'object') {
    return Object.entries(changes).map(([path, change]) => ({ path, change }))
  }
  return []
}

function patchStats(value) {
  const text = normalizeText(value)
  if (!text) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function lineCount(value) {
  const text = normalizeText(value)
  if (!text) return 0
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length
}

function editStats(edit) {
  if (!edit || typeof edit !== 'object') return { additions: 0, deletions: 0 }
  if (typeof edit.content === 'string') {
    return { additions: lineCount(edit.content), deletions: 0 }
  }
  if (typeof edit.new_string === 'string' || typeof edit.newString === 'string'
    || typeof edit.newText === 'string' || typeof edit.new_source === 'string') {
    return {
      additions: lineCount(edit.new_string ?? edit.newString ?? edit.newText ?? edit.new_source),
      deletions: lineCount(edit.old_string ?? edit.oldString ?? edit.oldText),
    }
  }
  return { additions: 0, deletions: 0 }
}

function changeStats(change) {
  if (!change) return { additions: 0, deletions: 0 }
  if (Number.isFinite(change.add) || Number.isFinite(change.remove)) {
    return {
      additions: Number.isFinite(change.add) ? change.add : 0,
      deletions: Number.isFinite(change.remove) ? change.remove : 0,
    }
  }
  if (Number.isFinite(change.added) || Number.isFinite(change.removed)) {
    return {
      additions: Number.isFinite(change.added) ? change.added : 0,
      deletions: Number.isFinite(change.removed) ? change.removed : 0,
    }
  }
  if (typeof change.unified_diff === 'string') return patchStats(change.unified_diff)
  if (typeof change.diff === 'string') return patchStats(change.diff)
  if (typeof change.content === 'string') {
    const lines = lineCount(change.content)
    return { additions: lines, deletions: 0 }
  }
  return editStats(change)
}

function inputStats(input) {
  if (!input || typeof input !== 'object') return { additions: 0, deletions: 0 }
  if (Array.isArray(input.edits)) {
    return input.edits.reduce((total, edit) => {
      const stats = editStats(edit)
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      }
    }, { additions: 0, deletions: 0 })
  }
  if (typeof input.patch === 'string') return patchStats(input.patch)
  if (typeof input.diff === 'string') return patchStats(input.diff)
  return editStats(input)
}

function isWriteShaped(input) {
  if (!input || typeof input !== 'object') return false
  return typeof input.content === 'string'
    || typeof input.new_string === 'string'
    || typeof input.newString === 'string'
    || typeof input.newText === 'string'
    || typeof input.new_source === 'string'
    || Array.isArray(input.edits)
    || typeof input.patch === 'string'
    || changeList(input).length > 0
}

function changeKind(output, input, title, change) {
  const kind = normalizeName(change?.kind || change?.type || input?.mode || input?.edit_mode)
  if (['add', 'create', 'created', 'new', 'insert'].includes(kind)) return 'created'
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'deleted'
  const text = normalizeText(output)
  if (/(?:file )?created successfully|created file|new file|已创建|已新建|新建文件/i.test(text)) {
    return 'created'
  }
  if (/(?:file )?(?:deleted|removed)|已删除|删除文件/i.test(text)) return 'deleted'
  if (/(?:file )?updated successfully|已更新|修改文件/i.test(text)) return 'modified'
  const normalizedTitle = normalizeName(title)
  if (['delete', 'deletefile', 'remove', 'removefile'].includes(normalizedTitle)) {
    return 'deleted'
  }
  return 'modified'
}

export function toWorkdirRelative(value, workdir = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim()
  if (!raw) return ''
  const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)
  if (!absolute) {
    const segments = raw.replace(/^\.\//, '').split('/').filter(Boolean)
    return segments.includes('..') ? '' : segments.join('/')
  }
  const root = String(workdir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return ''
  const prefix = `${root.toLowerCase()}/`
  if (!raw.toLowerCase().startsWith(prefix)) return ''
  const relative = raw.slice(root.length + 1)
  return relative.split('/').filter(Boolean).join('/')
}

function uniquePaths(paths, workdir) {
  const seen = new Set()
  const result = []
  for (const path of paths) {
    const value = String(path || '')
    if (!value) continue
    const key = toWorkdirRelative(value, workdir) || value.replace(/\\/g, '/')
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function fileEntry(path, rawPath, workdir, stats, created, deleted, status) {
  const normalized = String(path || '').replace(/\\/g, '/')
  const relativePath = toWorkdirRelative(rawPath, workdir) || toWorkdirRelative(normalized, workdir)
  return {
    path: relativePath || normalized,
    relativePath,
    name: normalized.split('/').filter(Boolean).at(-1) || normalized,
    additions: Math.max(0, Number(stats?.additions) || 0),
    deletions: Math.max(0, Number(stats?.deletions) || 0),
    created,
    deleted,
    status,
  }
}

export function extractFileChanges(steps = [], { workdir = '' } = {}) {
  const files = new Map()
  for (const group of groupToolSteps(steps)) {
    const input = resolveToolInput(group.steps)
    const title = toolTitle(group.steps)
    const output = toolOutput(group.steps)
    const titleKind = normalizeName(title)
    const list = changeList(input)
    const stepsPaths = group.steps.flatMap(step => (
      Array.isArray(step?.paths) ? step.paths : []
    ))
    const knownPaths = [
      ...stepsPaths,
      ...(list.length ? list.map(item => item.path) : []),
      inputPath(input),
    ].filter(Boolean)
    const paths = uniquePaths([
      ...knownPaths,
      ...(knownPaths.length ? [] : [outputPath(output)]),
    ], workdir)
    if (!paths.length) continue
    if (!WRITE_TOOL_NAMES.has(titleKind) && !list.length && !isWriteShaped(input)) continue

    const status = toolStatus(group.steps)
    for (const path of paths) {
      const pathKey = toWorkdirRelative(path, workdir) || String(path).replace(/\\/g, '/')
      const changeItem = list.find((item) => {
        const itemKey = toWorkdirRelative(item.path, workdir)
          || String(item.path).replace(/\\/g, '/')
        return itemKey === pathKey
      })?.change || (list.length === 1 ? list[0].change : null)
      const stats = changeItem ? changeStats(changeItem) : inputStats(input)
      const kind = changeKind(output, input, title, changeItem)
      const relativePath = toWorkdirRelative(path, workdir)
      const key = relativePath || path
      const entry = fileEntry(key, path, workdir, stats, kind === 'created', kind === 'deleted', status)
      const existing = files.get(entry.path)
      if (!existing) {
        files.set(entry.path, entry)
        continue
      }
      existing.additions += entry.additions
      existing.deletions += entry.deletions
      existing.created = existing.created || entry.created
      existing.deleted = existing.deleted || entry.deleted
      existing.status = entry.status
      existing.relativePath = existing.relativePath || entry.relativePath
    }
  }
  return [...files.values()]
}

export function summarizeTraceActivity(steps = [], { workdir = '' } = {}) {
  const values = Array.isArray(steps) ? steps : []
  let thinkingCount = 0
  let inThinking = false
  const tools = new Set()
  for (const step of values) {
    if (step?.kind === 'thinking') {
      if (!inThinking) {
        thinkingCount += 1
        inThinking = true
      }
      continue
    }
    inThinking = false
    if (step?.kind === 'tool') {
      tools.add(String(step.toolCallId || `seq:${step.seq}`))
    }
  }
  return {
    thinkingCount,
    toolCount: tools.size,
    files: extractFileChanges(values, { workdir }),
  }
}
