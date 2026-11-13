#!/usr/bin/env node
'use strict'

// 里程碑 0 任务 0.2 的场景驱动脚本。
//
// 用法：
//   node run-supervisor-scenarios.cjs --scenario A|B|C|escape --runner node
//   node run-supervisor-scenarios.cjs --scenario A|B|C|escape --runner electron
//   node run-supervisor-scenarios.cjs --scenario A|B|C|escape --runner packaged \
//     --electron <打包产物里的 Electron 可执行文件> \
//     --supervisor <解包后的 supervisor-prototype.cjs>
//
// 编排方式：本脚本（orchestrator）为每个场景启动一个子进程扮演「应用 main」，
// 由它启动监护程序并在 A/B 场景中对自己发 SIGKILL。orchestrator 在子进程结束后
// 做断言。这样测试才能观察到「main 死亡」之后容器是否被结束。
//
// 每个场景结束都检查 pgrep 与进程组，确认没有残留；失败时保留临时目录供诊断。

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SUPERVISOR_PATH = path.join(__dirname, 'supervisor-prototype.cjs')
const FAKE_AGENT_PATH = path.join(__dirname, 'fake-agent.sh')

function parseArgs(argv) {
  const options = { scenario: 'C', runner: 'node', role: 'orchestrator' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => argv[++index]
    if (argument === '--scenario') options.scenario = value()
    else if (argument === '--runner') options.runner = value()
    else if (argument === '--role') options.role = value()
    else if (argument === '--dir') options.dir = value()
    else if (argument === '--electron') options.electron = value()
    else if (argument === '--supervisor') options.supervisor = value()
  }
  if (!['A', 'B', 'C', 'escape'].includes(options.scenario)) {
    throw new Error(`unknown scenario: ${options.scenario}`)
  }
  if (!['node', 'electron', 'packaged'].includes(options.runner)) {
    throw new Error(`unknown runner: ${options.runner}`)
  }
  return options
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch {
    return null
  }
}

function fileSize(filename) {
  try {
    return fs.statSync(filename).size
  } catch {
    return 0
  }
}

function groupEmpty(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function leftoverProcesses() {
  try {
    const output = execFileSync('pgrep', ['-fl', '[s]upervisor-prototype|[f]ake-agent'], {
      encoding: 'utf8',
    })
    return output.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 子进程角色：扮演应用 main
// ---------------------------------------------------------------------------

function runMain(options) {
  const dir = options.dir
  const scenario = options.scenario
  const runner = options.runner
  const supervisorPath = runner === 'packaged' ? options.supervisor : SUPERVISOR_PATH
  if (!supervisorPath) throw new Error('--supervisor is required for the packaged runner')

  const electronPath = options.electron
    || require(path.join(__dirname, '..', 'node_modules', 'electron'))
  const execPath = runner === 'node' ? process.execPath : electronPath
  const supervisorEnv = { PATH: process.env.PATH, HOME: process.env.HOME }
  if (runner !== 'node') supervisorEnv.ELECTRON_RUN_AS_NODE = '1'

  const events = []
  const record = (kind, payload) => events.push({ kind, payload, at: Date.now() })
  const writeEvents = () => {
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2))
  }

  const child = spawn(execPath, [supervisorPath], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: supervisorEnv,
  })

  // 模拟「身份落盘」：容器组号（= 监护程序 pid）在放行之前写入磁盘。
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
    supervisorPid: child.pid,
    scenario,
    runner,
    identityWrittenAt: Date.now(),
  }))

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => record('stdout', chunk))
  child.stdout.on('end', () => record('stdout-end', null))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => record('stderr', chunk))

  const channel = child.stdio[3]
  let channelBuffer = ''
  channel.setEncoding('utf8')
  channel.on('data', (chunk) => {
    channelBuffer += chunk
    let index
    while ((index = channelBuffer.indexOf('\n')) >= 0) {
      const line = channelBuffer.slice(0, index)
      channelBuffer = channelBuffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        record('control', JSON.parse(line))
      } catch {
        record('control-invalid', line)
      }
    }
  })
  channel.on('end', () => record('control-end', null))

  child.on('exit', (code, signal) => record('supervisor-exit', { code, signal }))
  child.on('error', (error) => record('supervisor-error', String((error && error.message) || error)))

  if (scenario === 'A') {
    // 身份已落盘，但还没有放行；main 立即死亡。
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 100)
    return
  }

  const goMessage = {
    go: {
      command: '/bin/sh',
      args: [FAKE_AGENT_PATH],
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OUT: dir,
        LOOPS: scenario === 'B' ? '50' : '3',
        ESCAPE: scenario === 'escape' ? '1' : '0',
      },
    },
  }
  channel.write(`${JSON.stringify(goMessage)}\n`)

  if (scenario === 'B') {
    // 放行 1.5 秒后 main 死亡；Agent 与其后台进程应被监护程序结束。
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500)
    return
  }

  const finish = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (scenario === 'escape') {
      const escapedPidPath = path.join(dir, 'escaped.pid')
      const escapedPid = fs.existsSync(escapedPidPath)
        ? Number(fs.readFileSync(escapedPidPath, 'utf8').trim()) || null
        : null
      const escapedPath = path.join(dir, 'escaped')
      const sizeAtExit = fileSize(escapedPath)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const sizeAfter = fileSize(escapedPath)
      record('escaped-growth', {
        escapedPid,
        sizeAtExit,
        sizeAfter,
        growing: sizeAfter > sizeAtExit,
      })
      if (escapedPid) {
        try {
          process.kill(-escapedPid, 'SIGKILL')
        } catch {
          try {
            process.kill(escapedPid, 'SIGKILL')
          } catch {
            // 已退出
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        record('escaped-alive-after-kill', processAlive(escapedPid))
      }
    }
    writeEvents()
    process.exit(0)
  }

  const timeout = setTimeout(() => {
    record('timeout', null)
    writeEvents()
    process.exit(2)
  }, 20000)

  child.on('exit', () => {
    clearTimeout(timeout)
    finish()
  })
}

// ---------------------------------------------------------------------------
// 编排角色：运行子进程 main，然后断言
// ---------------------------------------------------------------------------

function orderVerdict(events) {
  const find = (predicate) => events.findIndex(predicate)
  const finalAnswer = find((event) => event.kind === 'stdout' && String(event.payload).includes('FINAL-ANSWER'))
  const agentExit = find((event) => event.kind === 'control' && event.payload && event.payload.agentExit)
  const finalKill = find((event) => event.kind === 'control' && event.payload && event.payload.finalKill)
  const stdoutEnd = find((event) => event.kind === 'stdout-end')
  const supervisorExit = find((event) => event.kind === 'supervisor-exit')
  const exitEvent = supervisorExit >= 0 ? events[supervisorExit] : null
  const signal = exitEvent && exitEvent.payload ? exitEvent.payload.signal : null
  const ok = finalAnswer >= 0
    && agentExit > finalAnswer
    && finalKill > agentExit
    && stdoutEnd > finalKill
    && supervisorExit > stdoutEnd
    && signal === 'SIGKILL'
  return {
    ok,
    detail: JSON.stringify({
      finalAnswer,
      agentExit,
      finalKill,
      stdoutEnd,
      supervisorExit,
      supervisorSignal: signal,
    }),
  }
}

async function assertScenario(options, dir) {
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok, detail })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const identity = readJson(path.join(dir, 'identity.json')) || {}
  const pgid = identity.supervisorPid

  if (options.scenario === 'A') {
    await wait(1200)
    record('agent-never-started', !fs.existsSync(path.join(dir, 'started')), 'started marker absent')
    record('container-empty', groupEmpty(pgid), `process.kill(-${pgid}, 0) -> ESRCH`)
  } else if (options.scenario === 'B') {
    await wait(3500)
    const first = fileSize(path.join(dir, 'bg'))
    await wait(1200)
    const second = fileSize(path.join(dir, 'bg'))
    record('writes-stopped', second === first, `bg size ${first} -> ${second}`)
    record('container-empty', groupEmpty(pgid), `process.kill(-${pgid}, 0) -> ESRCH`)
  } else {
    const events = readJson(path.join(dir, 'events.json')) || []
    if (options.scenario === 'C') {
      const order = orderVerdict(events)
      record('event-order', order.ok, order.detail)
      const first = fileSize(path.join(dir, 'bg'))
      await wait(600)
      const second = fileSize(path.join(dir, 'bg'))
      record('writes-stopped', second === first, `bg size ${first} -> ${second}`)
    } else {
      const growth = events.find((event) => event.kind === 'escaped-growth')
      record(
        'escaped-process-survives-group-kill',
        Boolean(growth && growth.payload && growth.payload.growing),
        JSON.stringify(growth ? growth.payload : null),
      )
      const aliveAfterKill = events.find((event) => event.kind === 'escaped-alive-after-kill')
      record(
        'escaped-process-ended-by-harness',
        Boolean(aliveAfterKill && aliveAfterKill.payload === false),
        JSON.stringify(aliveAfterKill ? aliveAfterKill.payload : null),
      )
    }
    record('container-empty', groupEmpty(pgid), `process.kill(-${pgid}, 0) -> ESRCH`)
  }

  const escapedPidPath = path.join(dir, 'escaped.pid')
  if (fs.existsSync(escapedPidPath)) {
    const escapedPid = Number(fs.readFileSync(escapedPidPath, 'utf8').trim()) || null
    const alive = processAlive(escapedPid)
    record('escaped-process-not-left-behind', !alive, `pid ${escapedPid} alive=${alive}`)
    if (alive) {
      try {
        process.kill(-escapedPid, 'SIGKILL')
      } catch {
        try {
          process.kill(escapedPid, 'SIGKILL')
        } catch {
          // 已退出
        }
      }
    }
  }

  const leftovers = leftoverProcesses()
  record('no-leftover-processes', leftovers.length === 0, leftovers.join(' | ') || 'none')
  return results
}

async function runOrchestrator(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-spike0-'))
  const args = [
    __filename,
    '--role', 'main',
    '--scenario', options.scenario,
    '--runner', options.runner,
    '--dir', dir,
  ]
  if (options.electron) args.push('--electron', options.electron)
  if (options.supervisor) args.push('--supervisor', options.supervisor)

  const child = spawn(process.execPath, args, { stdio: 'inherit' })
  const childExit = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })

  const results = await assertScenario(options, dir)
  const summary = {
    scenario: options.scenario,
    runner: options.runner,
    tempDir: dir,
    mainExit: childExit,
    results,
    ok: results.every((result) => result.ok),
  }
  console.log(JSON.stringify(summary, null, 2))
  if (summary.ok) {
    fs.rmSync(dir, { recursive: true, force: true })
  } else {
    console.error(`scenario failed; temp dir kept for diagnosis: ${dir}`)
  }
  process.exit(summary.ok ? 0 : 1)
}

const options = parseArgs(process.argv.slice(2))
if (options.role === 'main') {
  runMain(options)
} else {
  runOrchestrator(options).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
