import {
  extractFileChanges,
  resolveToolInput,
  toolOutput,
  toolStatus,
  toolTitle,
} from './traceActivity.js'

const COMMAND_TOOL_NAMES = new Set([
  'bash',
  'cmd',
  'command',
  'commandexecution',
  'console',
  'exec',
  'execute',
  'powershell',
  'run',
  'runcommand',
  'runterminal',
  'sh',
  'shell',
  'terminal',
  'zsh',
])

const INPUT_SUMMARY_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'pattern',
  'query',
  'description',
  'url',
  'name',
  'prompt',
  'target',
]

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function oneLine(value, limit = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function firstSequence(steps) {
  return steps.find(step => Number.isSafeInteger(step?.seq))?.seq || 0
}

function groupToolStepsById(steps) {
  const groups = new Map()
  for (const step of steps) {
    if (step?.kind !== 'tool') continue
    const key = String(step.toolCallId || `seq:${step.seq}`)
    const group = groups.get(key) || { key, steps: [] }
    group.steps.push(step)
    groups.set(key, group)
  }
  return groups
}

function stepCommand(steps, input) {
  for (const step of steps) {
    if (typeof step.command === 'string' && step.command.trim()) return step.command
  }
  const value = input?.command ?? input?.cmd ?? input?.command_line
    ?? input?.commandLine ?? input?.script
  return typeof value === 'string' ? value : ''
}

function inputSummary(input) {
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string' && input.trim() && !/^[{[]/.test(input.trim())) {
      return oneLine(input)
    }
    return ''
  }
  for (const field of INPUT_SUMMARY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) return oneLine(value)
  }
  if (Array.isArray(input.paths) && typeof input.paths[0] === 'string') {
    return oneLine(input.paths[0])
  }
  return ''
}

function serializeInput(input) {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return ''
  }
}

function isCommandTool(group, input) {
  if (group.steps.some(step => typeof step.command === 'string' && step.command.trim())) return true
  if (typeof input?.command === 'string' && input.command.trim()) return true
  const name = normalizeName(toolTitle(group.steps))
  return COMMAND_TOOL_NAMES.has(name)
    || name.includes('command')
    || name.includes('terminal')
    || name.includes('shell')
}

function buildToolItem(group) {
  const input = resolveToolInput(group.steps)
  const command = stepCommand(group.steps, input)
  const blobStep = [...group.steps].reverse().find(step => step?.blobs?.output)
  const exitStep = [...group.steps].reverse().find(step => Number.isInteger(step.exitCode))
  return {
    command,
    exitCode: exitStep ? exitStep.exitCode : null,
    inputText: serializeInput(input),
    key: group.key,
    output: toolOutput(group.steps),
    outputBlob: blobStep?.blobs?.output || null,
    status: toolStatus(group.steps),
    summary: command ? oneLine(command) : inputSummary(input),
    title: toolTitle(group.steps),
  }
}

function isMeaningfulToolItem(item) {
  return Boolean(
    item.title
      || item.command
      || item.summary
      || item.inputText
      || item.output
      || item.outputBlob
      || item.exitCode !== null
      || item.status === 'failed',
  )
}

function lastStatus(steps) {
  return String(steps.at(-1)?.status || '') || 'completed'
}

function overallItemStatus(items) {
  const statuses = items.map(item => String(item?.status || 'completed'))
  if (statuses.some(status => ['failed', 'timeout', 'budget-exhausted'].includes(status))) {
    return 'failed'
  }
  if (statuses.some(status => ['pending', 'running', 'streaming', 'in_progress'].includes(status))) {
    return 'running'
  }
  if (statuses.some(status => ['cancelled', 'incomplete', 'interrupted', 'partial', 'stopped'].includes(status))) {
    return 'partial'
  }
  return 'completed'
}

function classifyToolGroup(group, workdir) {
  if (extractFileChanges(group.steps, { workdir }).length) return 'file'
  const input = resolveToolInput(group.steps)
  if (isCommandTool(group, input)) return 'command'
  return 'tool'
}

function thinkingBlock(steps) {
  return {
    count: steps.length,
    key: `thinking:${firstSequence(steps)}`,
    kind: 'thinking',
    status: lastStatus(steps),
    steps,
    text: steps.map(step => String(step?.output || '')).join(''),
  }
}

function planBlock(steps) {
  return {
    count: steps.length,
    key: `plan:${firstSequence(steps)}`,
    kind: 'plan',
    status: lastStatus(steps),
    steps,
    text: steps.map(step => String(step?.output || '')).join('\n').trim(),
  }
}

export function summarizeTraceActivities(blocks = []) {
  let commands = 0
  let thinking = 0
  let tools = 0
  const files = new Map()
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.kind === 'command') {
      commands += block.items.length
      continue
    }
    if (block.kind === 'tool') {
      tools += block.items.length
      continue
    }
    if (block.kind === 'thinking') {
      thinking += block.count
      continue
    }
    if (block.kind !== 'file') continue
    for (const file of block.files || []) {
      const existing = files.get(file.path)
      if (!existing) {
        files.set(file.path, { ...file })
        continue
      }
      existing.additions += file.additions
      existing.deletions += file.deletions
      existing.created = existing.created || file.created
      existing.deleted = existing.deleted || file.deleted
      existing.status = file.status
    }
  }
  return {
    commands,
    fileList: [...files.values()],
    files: files.size,
    thinking,
    tools,
  }
}

export function buildTraceActivities(steps = [], { workdir = '' } = {}) {
  const values = Array.isArray(steps) ? steps : []
  const blocks = []
  const toolGroups = groupToolStepsById(values)
  const emittedTools = new Set()
  let current = null
  let index = 0
  while (index < values.length) {
    const step = values[index]
    if (step?.kind === 'thinking') {
      current = null
      const group = []
      while (index < values.length && values[index]?.kind === 'thinking') group.push(values[index++])
      blocks.push(thinkingBlock(group))
      continue
    }
    if (step?.kind === 'plan') {
      current = null
      const group = []
      while (index < values.length && values[index]?.kind === 'plan') group.push(values[index++])
      blocks.push(planBlock(group))
      continue
    }
    if (step?.kind === 'tool') {
      const key = String(step.toolCallId || `seq:${step.seq}`)
      index += 1
      if (emittedTools.has(key)) continue
      emittedTools.add(key)
      const group = toolGroups.get(key)
      if (!group) continue
      const item = buildToolItem(group)
      if (!isMeaningfulToolItem(item)) continue
      const kind = classifyToolGroup(group, workdir)
      if (current && current.kind === kind) {
        current.steps.push(...group.steps)
        current.items.push(item)
        continue
      }
      current = {
        items: [item],
        key: '',
        kind,
        steps: [...group.steps],
      }
      blocks.push(current)
      continue
    }
    current = null
    index += 1
  }

  for (const block of blocks) {
    if (!['command', 'file', 'tool'].includes(block.kind)) continue
    block.key = `${block.kind}:${firstSequence(block.steps)}`
    block.status = overallItemStatus(block.items)
    if (block.kind === 'file') {
      block.files = extractFileChanges(block.steps, { workdir })
      block.count = block.files.length
    } else {
      block.count = block.items.length
    }
  }

  return {
    blocks,
    summary: summarizeTraceActivities(blocks),
  }
}
