#!/usr/bin/env node
'use strict'

// 里程碑 0 任务 0.6：可写 ACP 调用每轮启动的延迟（M3 3.9）。
//
// 对每个可用的 ACP Agent 测：
//   冷启动 5 次：spawn → initialize → newSession/resumeSession → setSessionMode
//                → prompt → 第一个 sessionUpdate 事件；取中位数。
//   常驻进程：同一进程连续两轮，测第二轮 prompt → 第一个事件的耗时。
//
// 用法：
//   node acp-latency-check.cjs
//   node acp-latency-check.cjs --targets deepseek,claude,codex --runs 5
//
// 客户端使用桌面端 SDK 0.23.0；Claude/Codex 使用临时安装的 ACP 适配器。

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

const ACP_DIR = process.env.ACP_SPIKE_DIR || '/tmp/tyche-acp-spike'
const ADAPTER_PATHS = {
  claude: path.join(ACP_DIR, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'),
  codex: path.join(ACP_DIR, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'),
}

function parseArgs(argv) {
  const options = { targets: 'deepseek,claude,codex', runs: 5, timeoutMs: 180000 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => argv[++index]
    if (argument === '--targets') options.targets = value()
    else if (argument === '--runs') options.runs = Number(value())
    else if (argument === '--timeout-ms') options.timeoutMs = Number(value())
  }
  options.targets = options.targets.split(',').map((value) => value.trim()).filter(Boolean)
  return options
}

function now() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function targetSpec(name) {
  if (name === 'claude') {
    return {
      name,
      command: process.execPath,
      args: [ADAPTER_PATHS.claude],
      sessionMode: 'default',
      sessionStrategy: 'ACP 适配器支持 resumeSession（0.4 已验证）；表里尚未登记',
    }
  }
  if (name === 'codex') {
    return {
      name,
      command: process.execPath,
      args: [ADAPTER_PATHS.codex],
      sessionMode: 'workspace-write',
      sessionStrategy: 'ACP 适配器支持 resumeSession（0.4 已验证）；表里尚未登记',
    }
  }
  if (name === 'deepseek') {
    return {
      name,
      command: 'deepseek',
      args: [
        '--profile', 'acp',
        '--sandbox-mode', 'workspace-write',
        '--approval-policy', 'never',
      ],
      sessionMode: null,
      sessionStrategy: '默认（非 new）；cli-invocations.cjs 未显式设置 acpSessionStrategy',
    }
  }
  return null
}

function startTarget(spec, cwd) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.PATH = `${path.join(ACP_DIR, 'node_modules', '.bin')}:${env.PATH || ''}`
  const child = spawn(spec.command, spec.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const runtime = {
    child,
    events: 0,
    firstEventAt: null,
    firstSubstantiveAt: null,
    firstMessageAt: null,
    permissionRequests: 0,
    stderr: '',
    closed: false,
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { runtime.stderr += chunk })
  const client = {
    async requestPermission(params) {
      runtime.permissionRequests += 1
      const options = Array.isArray(params && params.options) ? params.options : []
      const option = options.find((candidate) => candidate && candidate.kind === 'allow_once')
        || options.find((candidate) => candidate && candidate.kind === 'allow_always')
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate(params) {
      runtime.events += 1
      const at = now()
      if (runtime.firstEventAt === null) runtime.firstEventAt = at
      const type = params && params.update ? params.update.sessionUpdate : null
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(type)
          && runtime.firstSubstantiveAt === null) {
        runtime.firstSubstantiveAt = at
      }
      if (type === 'agent_message_chunk' && runtime.firstMessageAt === null) {
        runtime.firstMessageAt = at
      }
    },
  }
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  runtime.connection = new ClientSideConnection(() => client, stream)
  return runtime
}

async function closeTarget(runtime) {
  if (!runtime || runtime.closed) return
  runtime.closed = true
  try { runtime.child.stdin.end() } catch { /* gone */ }
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

async function initialize(runtime, cwd, sessionMode) {
  const initialized = await runtime.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  const session = await runtime.connection.newSession({ cwd, mcpServers: [] })
  if (sessionMode) {
    await runtime.connection.setSessionMode({ sessionId: session.sessionId, modeId: sessionMode })
  }
  return { initialized, session }
}

async function resume(runtime, cwd, sessionId, sessionMode) {
  const session = await runtime.connection.resumeSession({
    sessionId,
    cwd,
    mcpServers: [],
  })
  if (sessionMode) {
    await runtime.connection.setSessionMode({
      sessionId: session.sessionId || sessionId,
      modeId: sessionMode,
    })
  }
  return session
}

async function promptOnce(runtime, sessionId, text, timeoutMs) {
  runtime.firstEventAt = null
  runtime.firstSubstantiveAt = null
  runtime.firstMessageAt = null
  const started = now()
  const result = await Promise.race([
    runtime.connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
    delay(timeoutMs).then(() => ({ timedOut: true })),
  ])
  const finished = now()
  return {
    started,
    finished,
    firstEventAt: runtime.firstEventAt,
    firstSubstantiveAt: runtime.firstSubstantiveAt,
    firstMessageAt: runtime.firstMessageAt,
    result,
  }
}

async function coldRun(spec, cwd, sessionId, timeoutMs) {
  const t0 = now()
  const runtime = startTarget(spec, cwd)
  try {
    const initializedAt = now()
    const initialized = await runtime.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const initDone = now()
    const session = sessionId
      ? await resume(runtime, cwd, sessionId, spec.sessionMode)
      : (await initialize(runtime, cwd, spec.sessionMode)).session
    const sessionDone = now()
    const promptText = 'Reply with exactly OK.'
    const prompt = await promptOnce(runtime, session.sessionId || sessionId, promptText, timeoutMs)
    return {
      ok: !prompt.result.timedOut,
      sessionId: session.sessionId || sessionId || null,
      timings: {
        spawnToInitStart: initializedAt - t0,
        init: initDone - initializedAt,
        session: sessionDone - initDone,
        spawnToPrompt: prompt.started - t0,
        promptToFirstEvent: prompt.firstEventAt == null ? null : prompt.firstEventAt - prompt.started,
        promptToFirstSubstantive: prompt.firstSubstantiveAt == null ? null : prompt.firstSubstantiveAt - prompt.started,
        promptToFirstMessage: prompt.firstMessageAt == null ? null : prompt.firstMessageAt - prompt.started,
        promptToDone: prompt.finished - prompt.started,
        totalToFirstEvent: prompt.firstEventAt == null ? null : prompt.firstEventAt - t0,
        totalToFirstSubstantive: prompt.firstSubstantiveAt == null ? null : prompt.firstSubstantiveAt - t0,
        totalToFirstMessage: prompt.firstMessageAt == null ? null : prompt.firstMessageAt - t0,
        totalToDone: prompt.finished - t0,
      },
      protocolVersion: initialized.protocolVersion,
      permissionRequests: runtime.permissionRequests,
      timedOut: prompt.result.timedOut === true,
    }
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      stderrTail: runtime.stderr.slice(-1500),
    }
  } finally {
    await closeTarget(runtime)
  }
}

async function warmRun(spec, cwd, timeoutMs) {
  const runtime = startTarget(spec, cwd)
  try {
    const { session } = await initialize(runtime, cwd, spec.sessionMode)
    const first = await promptOnce(runtime, session.sessionId, 'Reply with exactly ONE.', timeoutMs)
    const second = await promptOnce(runtime, session.sessionId, 'Reply with exactly TWO.', timeoutMs)
    return {
      ok: !second.result.timedOut,
      first: {
        firstEventMs: first.firstEventAt == null ? null : first.firstEventAt - first.started,
        firstSubstantiveMs: first.firstSubstantiveAt == null ? null : first.firstSubstantiveAt - first.started,
        firstMessageMs: first.firstMessageAt == null ? null : first.firstMessageAt - first.started,
        doneMs: first.finished - first.started,
      },
      second: {
        firstEventMs: second.firstEventAt == null ? null : second.firstEventAt - second.started,
        firstSubstantiveMs: second.firstSubstantiveAt == null ? null : second.firstSubstantiveAt - second.started,
        firstMessageMs: second.firstMessageAt == null ? null : second.firstMessageAt - second.started,
        doneMs: second.finished - second.started,
      },
      timedOut: second.result.timedOut === true,
    }
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      stderrTail: runtime.stderr.slice(-1500),
    }
  } finally {
    await closeTarget(runtime)
  }
}

async function measureTarget(name, runs, timeoutMs) {
  const spec = targetSpec(name)
  if (!spec) return { target: name, available: false, reason: '没有对应的启动配置' }
  if (name !== 'deepseek' && !fs.existsSync(spec.args[0])) {
    return { target: name, available: false, reason: `适配器不存在：${spec.args[0]}` }
  }
  if (name === 'deepseek') {
    try {
      const { execFileSync } = require('node:child_process')
      execFileSync('deepseek', ['--version'], { stdio: 'ignore' })
    } catch (error) {
      return { target: name, available: false, reason: `deepseek 不可用：${error.code || error.message}` }
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-acp-latency-${name}-`))
  const result = {
    target: name,
    available: true,
    sessionStrategy: spec.sessionStrategy,
    sessionMode: spec.sessionMode,
    coldRuns: [],
    warm: null,
  }
  let sessionId = null
  try {
    for (let index = 0; index < runs; index += 1) {
      const run = await coldRun(spec, dir, index === 0 ? null : sessionId, timeoutMs)
      if (run.sessionId) sessionId = run.sessionId
      result.coldRuns.push(run)
      if (!run.ok) break
    }
    const okRuns = result.coldRuns.filter((run) => run.ok)
    result.coldMedians = {
      promptToFirstEvent: median(okRuns.filter((run) => run.timings.promptToFirstEvent != null).map((run) => run.timings.promptToFirstEvent)),
      promptToFirstSubstantive: median(okRuns.filter((run) => run.timings.promptToFirstSubstantive != null).map((run) => run.timings.promptToFirstSubstantive)),
      promptToFirstMessage: median(okRuns.filter((run) => run.timings.promptToFirstMessage != null).map((run) => run.timings.promptToFirstMessage)),
      totalToFirstEvent: median(okRuns.filter((run) => run.timings.totalToFirstEvent != null).map((run) => run.timings.totalToFirstEvent)),
      totalToFirstSubstantive: median(okRuns.filter((run) => run.timings.totalToFirstSubstantive != null).map((run) => run.timings.totalToFirstSubstantive)),
      totalToFirstMessage: median(okRuns.filter((run) => run.timings.totalToFirstMessage != null).map((run) => run.timings.totalToFirstMessage)),
      promptToDone: median(okRuns.map((run) => run.timings.promptToDone)),
      totalToDone: median(okRuns.map((run) => run.timings.totalToDone)),
    }
    result.warm = await warmRun(spec, dir, timeoutMs)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
  }
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const summary = { desktopSdk: require(path.join(SDK_PATH, 'package.json')).version, protocolVersion: PROTOCOL_VERSION, targets: [] }
  for (const target of options.targets) {
    process.stderr.write(`measuring ${target}\n`)
    summary.targets.push(await measureTarget(target, options.runs, options.timeoutMs))
  }
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
