#!/usr/bin/env node
'use strict'

// 里程碑 0 任务 0.4：实测 Claude / Codex 的 ACP 适配器（M3 7.1）。
//
// 用法：
//   node acp-adapter-check.cjs --adapter claude --checks permissions --mode read-exec
//   node acp-adapter-check.cjs --adapter codex --checks permissions,session,cancel
//   ACP_SPIKE_DIR=/tmp/meldwork-acp-spike node acp-adapter-check.cjs ...
//
// 客户端使用桌面端已有的 @agentclientprotocol/sdk 0.23.0；适配器自己带 SDK 2.x。
// 两边 PROTOCOL_VERSION 都是 1，这次实测同时验证线协议兼容性。
//
// 权限策略（与 M3 6.1 对应）：
//   read        放行 read/search/fetch/think，其余拒绝
//   read-exec   另放行 execute，edit/delete/move/other 拒绝
//   write       全部放行

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')

const REPO = path.resolve(__dirname, '..', '..')
const SDK_PATH = process.env.ACP_SDK_PATH
  || path.join(REPO, 'desktop', 'node_modules', '@agentclientprotocol', 'sdk')
const SDK = require(SDK_PATH)
const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = SDK

const ACP_DIR = process.env.ACP_SPIKE_DIR || '/tmp/meldwork-acp-spike'
const ADAPTER_PATHS = {
  claude: path.join(ACP_DIR, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'),
  codex: path.join(ACP_DIR, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'),
}

const SAFE_KINDS = new Set(['read', 'search', 'fetch', 'think'])
const EXEC_KINDS = new Set([...SAFE_KINDS, 'execute'])

function parseArgs(argv) {
  const options = {
    adapter: 'claude',
    checks: 'permissions',
    mode: 'read-exec',
    sessionMode: null,
    timeoutMs: 180000,
    longRunMinutes: 120,
    longRunWaitMs: 7_500_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => argv[++index]
    if (argument === '--adapter') options.adapter = value()
    else if (argument === '--checks') options.checks = value()
    else if (argument === '--mode') options.mode = value()
    else if (argument === '--session-mode') options.sessionMode = value()
    else if (argument === '--timeout-ms') options.timeoutMs = Number(value())
    else if (argument === '--long-run-minutes') options.longRunMinutes = Number(value())
    else if (argument === '--long-run-wait-ms') options.longRunWaitMs = Number(value())
  }
  if (!ADAPTER_PATHS[options.adapter]) throw new Error(`unknown adapter: ${options.adapter}`)
  if (!['read', 'read-exec', 'write'].includes(options.mode)) throw new Error(`unknown mode: ${options.mode}`)
  return options
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decidePermission(mode, toolKind, request) {
  const options = Array.isArray(request && request.options) ? request.options : []
  const allowed = mode === 'write'
    || (mode === 'read-exec' && EXEC_KINDS.has(toolKind))
    || (mode === 'read' && SAFE_KINDS.has(toolKind))
  const wantedKinds = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  const option = wantedKinds
    .map((kind) => options.find((candidate) => candidate && candidate.kind === kind))
    .find(Boolean)
  return {
    allowed,
    optionId: option ? option.optionId : null,
    outcome: option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } },
    offeredKinds: options.map((candidate) => candidate && candidate.kind),
  }
}

function startAdapter(adapter, cwd, mode) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.PATH = `${path.join(ACP_DIR, 'node_modules', '.bin')}:${env.PATH || ''}`
  const child = spawn(process.execPath, [ADAPTER_PATHS[adapter]], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const runtime = {
    adapter,
    mode,
    child,
    events: [],
    permissions: [],
    stderr: '',
    closed: false,
    client: null,
    connection: null,
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { runtime.stderr += chunk })
  runtime.client = {
    async requestPermission(params) {
      const toolCall = params && params.toolCall ? params.toolCall : {}
      const decision = decidePermission(mode, toolCall.kind, params)
      runtime.permissions.push({
        kind: toolCall.kind || 'unknown',
        title: toolCall.title || null,
        rawInput: toolCall.rawInput || null,
        allowed: decision.allowed,
        optionId: decision.optionId,
        offeredKinds: decision.offeredKinds,
      })
      return decision.outcome
    },
    async sessionUpdate(params) {
      const update = params && params.update ? params.update : {}
      const record = {
        type: update.sessionUpdate || 'unknown',
        toolCallId: update.toolCallId || null,
        status: update.status || null,
        kind: update.kind || null,
        title: update.title || null,
        content: null,
        rawInput: update.rawInput || null,
        rawOutput: update.rawOutput || null,
      }
      if (update.content) {
        if (typeof update.content === 'string') record.content = update.content.slice(0, 500)
        else if (update.content.type === 'text') record.content = String(update.content.text || '').slice(0, 500)
        else record.content = JSON.stringify(update.content).slice(0, 500)
      }
      if (update.sessionUpdate === 'usage_update') {
        record.usage = JSON.parse(JSON.stringify(update))
      }
      runtime.events.push(record)
    },
  }
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  runtime.connection = new ClientSideConnection(() => runtime.client, stream)
  return runtime
}

async function closeAdapter(runtime) {
  if (!runtime || runtime.closed) return
  runtime.closed = true
  try { runtime.child.stdin.end() } catch { /* already closed */ }
  try { runtime.child.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([
    new Promise((resolve) => runtime.child.once('exit', resolve)),
    delay(3000),
  ])
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    try { runtime.child.kill('SIGKILL') } catch { /* gone */ }
    await Promise.race([
      new Promise((resolve) => runtime.child.once('exit', resolve)),
      delay(2000),
    ])
  }
  try { runtime.child.stdout.destroy() } catch { /* gone */ }
  try { runtime.child.stderr.destroy() } catch { /* gone */ }
}

async function initialize(runtime, cwd, sessionMode = null) {
  const initialized = await runtime.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  const session = await runtime.connection.newSession({ cwd, mcpServers: [] })
  if (sessionMode) {
    await runtime.connection.setSessionMode({ sessionId: session.sessionId, modeId: sessionMode })
  }
  return { initialized, sessionId: session.sessionId, session }
}

function summarizeEvents(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1
  const toolCalls = events.filter((event) => ['tool_call', 'tool_call_update'].includes(event.type))
  const thoughts = events.filter((event) => event.type === 'agent_thought_chunk')
  const usage = events.filter((event) => event.type === 'usage_update')
  return {
    counts,
    toolCalls: toolCalls.slice(0, 20),
    thoughtCount: thoughts.length,
    usage,
  }
}

function fileText(dir, name) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return null }
}

async function permissionsCheck(adapter, mode, timeoutMs, sessionMode = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-acp-${adapter}-${mode}-`))
  fs.writeFileSync(path.join(dir, 'sample.txt'), 'ALPHA\n')
  fs.writeFileSync(path.join(dir, 'edit-me.txt'), 'OLD\n')
  const runtime = startAdapter(adapter, dir, mode)
  const result = { adapter, mode, dir, login: null, trace: null, files: null, permissions: null, error: null }
  try {
    const { initialized, sessionId, session } = await initialize(runtime, dir, sessionMode)
    const prompt = [
      'You are being tested for tool permission handling. Work only in the current directory.',
      'Perform these four steps in order, and continue after any failure:',
      '1. Read sample.txt and report its content.',
      '2. Run the shell command: ls',
      '3. Run the shell command: echo x > out.txt',
      '4. Change OLD to NEW in edit-me.txt using your file-editing tool.',
      'After attempting all four, list which steps succeeded and which were denied.',
    ].join('\n')
    const response = await Promise.race([
      runtime.connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] }),
      delay(timeoutMs).then(() => ({ timedOut: true })),
    ])
    result.promptResult = response
    result.login = { authenticatedWithoutPrompt: true, protocolVersion: initialized.protocolVersion }
    result.session = {
      sessionId,
      modes: session && session.modes ? session.modes : null,
      currentModeId: session && session.currentModeId ? session.currentModeId : null,
      requestedSessionMode: sessionMode,
    }
    result.permissions = runtime.permissions
    result.trace = summarizeEvents(runtime.events)
    result.files = {
      outFile: fileText(dir, 'out.txt'),
      editMe: fileText(dir, 'edit-me.txt'),
    }
  } catch (error) {
    result.error = String((error && error.message) || error)
    result.stderrTail = runtime.stderr.slice(-1500)
  } finally {
    await closeAdapter(runtime)
    // Keep the directory only when --keep-dir is passed.
    if (!process.argv.includes('--keep-dir')) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
    }
  }
  return result
}

async function sessionCheck(adapter, mode, timeoutMs, sessionMode = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-acp-session-${adapter}-`))
  const result = { adapter, mode, dir, first: null, resumed: null, error: null }
  let firstRuntime = null
  let secondRuntime = null
  try {
    firstRuntime = startAdapter(adapter, dir, mode)
    const first = await initialize(firstRuntime, dir, sessionMode)
    result.sessionId = first.sessionId
    result.first = await Promise.race([
      firstRuntime.connection.prompt({
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: 'Remember the secret word BANANA. Reply with exactly OK.' }],
      }),
      delay(timeoutMs).then(() => ({ timedOut: true })),
    ])
    await closeAdapter(firstRuntime)
    firstRuntime = null

    secondRuntime = startAdapter(adapter, dir, mode)
    const second = await initialize(secondRuntime, dir, sessionMode)
    result.resumed = await Promise.race([
      secondRuntime.connection.resumeSession({
        sessionId: first.sessionId,
        cwd: dir,
        mcpServers: [],
      }).then((session) => secondRuntime.connection.prompt({
        sessionId: session.sessionId || first.sessionId,
        prompt: [{ type: 'text', text: 'What is the secret word? Reply with just the word.' }],
      })),
      delay(timeoutMs).then(() => ({ timedOut: true })),
    ])
    result.resumeEvents = summarizeEvents(secondRuntime.events)
    const transcript = secondRuntime.events
      .filter((event) => event.type === 'agent_message_chunk' && typeof event.content === 'string')
      .map((event) => event.content)
      .join('')
    result.secondAssistantText = transcript.slice(-1500)
    result.contextRetained = transcript.includes('BANANA')
  } catch (error) {
    result.error = String((error && error.message) || error)
    result.stderrTail = (secondRuntime || firstRuntime || {}).stderr?.slice(-1500) || null
  } finally {
    await closeAdapter(firstRuntime)
    await closeAdapter(secondRuntime)
    if (!process.argv.includes('--keep-dir')) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
    }
  }
  return result
}

async function cancelCheck(adapter, mode, timeoutMs, sessionMode = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-acp-cancel-${adapter}-`))
  const marker = `meldwork-acp-cancel-${Date.now()}`
  const runtime = startAdapter(adapter, dir, 'read-exec')
  const result = { adapter, mode, dir, marker, promptResult: null, cancelledAt: null, error: null }
  try {
    const { sessionId } = await initialize(runtime, dir, sessionMode)
    const promptPromise = runtime.connection.prompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: `Run the shell command "sleep 30 # ${marker}" and wait for it to finish, then reply DONE.`,
      }],
    })
    await delay(4000)
    result.cancelledAt = Date.now()
    await runtime.connection.cancel({ sessionId })
    result.promptResult = await Promise.race([
      promptPromise,
      delay(timeoutMs).then(() => ({ timedOut: true })),
    ])
    result.trace = summarizeEvents(runtime.events)
  } catch (error) {
    result.error = String((error && error.message) || error)
    result.stderrTail = runtime.stderr.slice(-1500)
  } finally {
    await closeAdapter(runtime)
    await delay(500)
    result.leftover = listProcesses(marker)
    for (const pid of result.leftover) {
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
    if (!process.argv.includes('--keep-dir')) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
    }
  }
  return result
}

function listProcesses(marker) {
  try {
    const { execFileSync } = require('node:child_process')
    const output = execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' })
    return output.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

async function longrunCheck(adapter, mode, sessionMode, minutes, waitMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-acp-longrun-${adapter}-`))
  const runtime = startAdapter(adapter, dir, mode)
  const result = { adapter, mode, minutes, startedAt: new Date().toISOString(), status: 'starting', error: null }
  const statusPath = path.join(os.tmpdir(), `meldwork-acp-longrun-${adapter}.json`)
  fs.writeFileSync(statusPath, JSON.stringify(result, null, 2))
  try {
    const { sessionId } = await initialize(runtime, dir, sessionMode)
    // 第一条提示：启动后台任务后立即返回，不让模型等待命令结束。
    const startPrompt = [
      `Start a background job that writes one line per minute for ${minutes} minutes:`,
      `nohup sh -c 'i=0; while [ $i -lt ${minutes} ]; do date >> longrun.log; i=$((i+1)); sleep 60; done' >/dev/null 2>&1 &`,
      'Reply with exactly STARTED. Do not wait for the job to finish.',
    ].join('\n')
    result.startPromptResult = await Promise.race([
      runtime.connection.prompt({ sessionId, prompt: [{ type: 'text', text: startPrompt }] }),
      delay(180000).then(() => ({ timedOut: true })),
    ])
    result.status = 'idle'
    result.idleStartedAt = new Date().toISOString()
    fs.writeFileSync(statusPath, JSON.stringify(result, null, 2))

    // 保持同一 ACP 进程与会话空闲 waitMs，期间后台任务持续写日志。
    await delay(waitMs)
    result.idleEndedAt = new Date().toISOString()
    result.elapsedMs = Date.now() - Date.parse(result.startedAt)
    result.lines = (fileText(dir, 'longrun.log') || '').split('\n').filter(Boolean).length
    result.adapterAliveAfterIdle = runtime.child.exitCode === null && runtime.child.signalCode === null

    if (result.adapterAliveAfterIdle) {
      const alivePrompt = 'Reply with exactly STILL-ALIVE. If longrun.log has more than 0 lines, also say RUNNING.'
      result.alivePromptResult = await Promise.race([
        runtime.connection.prompt({ sessionId, prompt: [{ type: 'text', text: alivePrompt }] }),
        delay(180000).then(() => ({ timedOut: true })),
      ])
      const transcript = runtime.events
        .filter((event) => event.type === 'agent_message_chunk' && typeof event.content === 'string')
        .map((event) => event.content)
        .join('')
      result.aliveTranscript = transcript.slice(-800)
      result.status = result.alivePromptResult.timedOut ? 'timed-out' : 'completed'
    } else {
      result.status = 'adapter-died'
    }
    result.usageCount = runtime.events.filter((event) => event.type === 'usage_update').length
  } catch (error) {
    result.status = 'error'
    result.error = String((error && error.message) || error)
    result.stderrTail = runtime.stderr.slice(-1500)
  } finally {
    fs.writeFileSync(statusPath, JSON.stringify(result, null, 2))
    await closeAdapter(runtime)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
  }
  result.statusPath = statusPath
  return result
}

async function usageCheck(adapter, mode, timeoutMs, sessionMode = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-acp-usage-${adapter}-`))
  const runtime = startAdapter(adapter, dir, mode)
  const result = { adapter, mode, dir, usage: [], error: null }
  try {
    const { sessionId } = await initialize(runtime, dir, sessionMode)
    result.promptResult = await Promise.race([
      runtime.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly OK.' }],
      }),
      delay(timeoutMs).then(() => ({ timedOut: true })),
    ])
    result.usage = runtime.events
      .filter((event) => event.type === 'usage_update')
      .map((event) => event.usage || null)
    result.promptUsage = result.promptResult && result.promptResult.usage ? result.promptResult.usage : null
  } catch (error) {
    result.error = String((error && error.message) || error)
    result.stderrTail = runtime.stderr.slice(-1500)
  } finally {
    await closeAdapter(runtime)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
  }
  return result
}

async function sdkInfo(adapter) {
  const packagePath = path.join(ACP_DIR, 'node_modules', '@agentclientprotocol', adapter === 'claude' ? 'claude-agent-acp' : 'codex-acp', 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const adapterSdk = packageJson.dependencies && packageJson.dependencies['@agentclientprotocol/sdk']
  return {
    adapter: packageJson.name,
    adapterVersion: packageJson.version,
    adapterSdk,
    desktopSdk: require(path.join(SDK_PATH, 'package.json')).version,
    desktopProtocolVersion: PROTOCOL_VERSION,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const checks = options.checks.split(',').map((value) => value.trim()).filter(Boolean)
  const summary = { adapter: options.adapter, mode: options.mode, checks, sdk: await sdkInfo(options.adapter) }
  for (const check of checks) {
    if (check === 'permissions') summary.permissions = await permissionsCheck(options.adapter, options.mode, options.timeoutMs, options.sessionMode)
    else if (check === 'session') summary.session = await sessionCheck(options.adapter, options.mode, options.timeoutMs, options.sessionMode)
    else if (check === 'cancel') summary.cancel = await cancelCheck(options.adapter, options.mode, options.timeoutMs, options.sessionMode)
    else if (check === 'usage') summary.usage = await usageCheck(options.adapter, options.mode, options.timeoutMs, options.sessionMode)
    else if (check === 'longrun') summary.longrun = await longrunCheck(options.adapter, options.mode, options.sessionMode, options.longRunMinutes, options.longRunWaitMs)
  }
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
