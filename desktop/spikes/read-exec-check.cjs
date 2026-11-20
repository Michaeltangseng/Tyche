#!/usr/bin/env node
'use strict'

// 里程碑 0 任务 0.5：实测 Claude print 与 Codex exec 的 read-exec 参数。
//
// 用法：
//   node read-exec-check.cjs
//   CLAUDE_BIN=/path/to/claude CODEX_BIN=/path/to/codex node read-exec-check.cjs
//
// 判定口径（M3 6.1）：能读、能运行命令，编辑类工具被拒绝，才算支持 read-exec。
// 命令本身能写文件是预期的（M3 3.1），单独记录，不算失败。

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLAUDE = process.env.CLAUDE_BIN || 'claude'
const CODEX = process.env.CODEX_BIN || 'codex'
const KEEP = process.argv.includes('--keep')

const PROMPT = [
  'You are being tested for tool permission handling. Work only in the current directory.',
  'Perform these four steps in order, and continue after any failure:',
  '1. Use the Read tool to read sample.txt and report its content.',
  '2. Use the Bash tool to run the shell command: ls',
  '3. Use the Bash tool to run the shell command: echo x > out.txt',
  '4. Use the Edit tool (not Bash) to change OLD to NEW in edit-me.txt.',
  'After attempting all four, list which steps succeeded and which were denied.',
].join('\n')

function run(command, args, { input = null, cwd, timeoutMs = 240000, stdinMode = 'pipe' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [stdinMode, 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ error: error.code || String(error), stdout, stderr, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    if (stdinMode === 'pipe') {
      child.stdin.end(input == null ? '' : input)
    }
  })
}

function parseJsonLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* non-JSON line */ }
  }
  return events
}

function parseClaude(text) {
  const uses = []
  const results = []
  let resultEvent = null
  let initTools = []
  for (const event of parseJsonLines(text)) {
    if (event.type === 'result') resultEvent = event
    if (event.type === 'system' && event.subtype === 'init') {
      initTools = (event.tools || []).map((tool) => (typeof tool === 'string' ? tool : tool && tool.name))
    }
    const content = event.message && event.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        uses.push({ id: block.id, name: block.name, input: block.input })
      }
      if (block && block.type === 'tool_result') {
        results.push({
          id: block.tool_use_id,
          isError: block.is_error === true,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        })
      }
    }
  }
  return { uses, results, resultEvent, initTools }
}

function readFileIfExists(filename) {
  try { return fs.readFileSync(filename, 'utf8') } catch { return null }
}

function claudeVerdict(dir, parsed) {
  const bashUses = parsed.uses.filter((use) => use.name === 'Bash')
  const editUses = parsed.uses.filter((use) => use.name === 'Edit')
  const readUses = parsed.uses.filter((use) => use.name === 'Read')
  const editResult = editUses.length
    ? parsed.results.find((result) => result.id === editUses[editUses.length - 1].id) || null
    : null
  const outFile = readFileIfExists(path.join(dir, 'out.txt'))
  const editMe = readFileIfExists(path.join(dir, 'edit-me.txt'))
  const editingTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
  const offeredEditingTools = parsed.initTools.filter((tool) => editingTools.includes(tool))
  const editAttempted = editUses.length > 0
  const editDeniedByAttempt = editAttempted
    ? Boolean(editResult && (editResult.isError || /denied|not allowed|permission/i.test(editResult.content)))
    : null
  const editDenied = offeredEditingTools.length === 0 || editDeniedByAttempt === true
  return {
    readToolUsed: readUses.length > 0,
    bashCommands: bashUses.map((use) => use.input && use.input.command).filter(Boolean),
    outFileCreated: outFile !== null,
    outFileContent: outFile,
    offeredEditingTools,
    editAttempted,
    editDenied,
    editResult: editResult ? { isError: editResult.isError, content: editResult.content.slice(0, 500) } : null,
    editMeContent: editMe,
    editMeUnchanged: editMe !== null && editMe.trim() === 'OLD',
    supportsReadExec: bashUses.length > 0 && editDenied && editMe !== null && editMe.trim() === 'OLD',
  }
}

function codexVerdict(dir, result) {
  const events = parseJsonLines(result.stdout)
  const items = []
  for (const event of events) {
    if (event.type === 'item.completed' && event.item) {
      items.push({
        type: event.item.type,
        command: event.item.command || null,
        status: event.item.status || null,
        text: typeof event.item.text === 'string' ? event.item.text.slice(0, 300) : null,
        message: typeof event.item.message === 'string' ? event.item.message.slice(0, 300) : null,
      })
    }
  }
  const commands = items.filter((item) => item.type === 'command_execution')
  const fileChanges = items.filter((item) => item.type === 'file_change')
  const outFile = readFileIfExists(path.join(dir, 'out.txt'))
  const editMe = readFileIfExists(path.join(dir, 'edit-me.txt'))
  return {
    commands,
    fileChanges,
    outFileCreated: outFile !== null,
    outFileContent: outFile,
    editMeContent: editMe,
    editMeUnchanged: editMe !== null && editMe.trim() === 'OLD',
    supportsReadExec: commands.length > 0 && editMe !== null && editMe.trim() === 'OLD' && fileChanges.length === 0,
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-read-exec-'))
  fs.writeFileSync(path.join(dir, 'sample.txt'), 'ALPHA\n')
  fs.writeFileSync(path.join(dir, 'edit-me.txt'), 'OLD\n')
  const summary = { dir, claude: null, codex: null }

  try {
    const claude = await run(CLAUDE, [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Read,Glob,Grep,Bash',
      '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit',
    ], { cwd: dir, input: PROMPT })
    summary.claude = {
      exit: claude.code,
      signal: claude.signal,
      error: claude.error || null,
      timedOut: claude.timedOut,
      stderrTail: claude.stderr.slice(-800),
      verdict: claudeVerdict(dir, parseClaude(claude.stdout)),
    }
    // Reset the files for Codex.
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'ALPHA\n')
    fs.writeFileSync(path.join(dir, 'edit-me.txt'), 'OLD\n')
    fs.rmSync(path.join(dir, 'out.txt'), { force: true })

    const codex = await run(CODEX, [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', PROMPT,
    ], { cwd: dir, stdinMode: 'ignore' })
    summary.codex = {
      exit: codex.code,
      signal: codex.signal,
      error: codex.error || null,
      timedOut: codex.timedOut,
      stderrTail: codex.stderr.slice(-800),
      verdict: codexVerdict(dir, codex),
    }
  } finally {
    if (!KEEP) fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
