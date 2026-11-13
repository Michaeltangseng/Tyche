#!/usr/bin/env node
'use strict'

// 里程碑 0 实测原型：监护程序（M3 3.2–3.5）。
//
// 由 Electron 可执行文件以 ELECTRON_RUN_AS_NODE=1 运行，不依赖任何第三方包。
// 永远不向 fd 1、2 写任何内容：它们是 Agent 的输出通道，诊断消息只走 fd 3。
//
// 协议（main → 监护程序）：
//   {"go": {"command", "args", "env", "cwd"}}
//   {"stop": {"force": boolean}}
// 协议（监护程序 → main）：
//   {"agentExit": {"code", "signal"}}
//   {"finalKill": {"agentAlive", "members": [{"pid", "startTime"}]}}
//   {"error": {"code", "message"}}
//
// 容器 = 以本进程为组长的进程组。main 必须以 detached 方式启动本进程，
// 使它成为新会话、新进程组的组长（组号 = pid），这就是「钉子」。

const { execFileSync, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')

process.on('SIGTERM', () => {})

let released = false
let cleaning = false
let channelClosed = false
let agentChild = null
let agentExit = null
let agentExitSent = false
let buffer = ''

const channel = new net.Socket({ fd: 3, readable: true, writable: true })

function send(message, callback) {
  if (channelClosed) {
    if (callback) callback(new Error('channel closed'))
    return
  }
  try {
    channel.write(`${JSON.stringify(message)}\n`, (error) => {
      if (callback) callback(error)
    })
  } catch (error) {
    if (callback) callback(error)
  }
}

function groupMembers() {
  let pids
  try {
    pids = execFileSync('pgrep', ['-g', String(process.pid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
  return pids
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    .map((pid) => {
      let startTime = null
      try {
        startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
      } catch {
        // 进程已退出：成员清单只用于诊断
      }
      return { pid, startTime }
    })
}

function beginCleanup(force) {
  if (cleaning) return
  cleaning = true
  try {
    process.kill(-process.pid, 'SIGTERM')
  } catch {
    // 组已为空
  }
  const waitMs = force ? 0 : 2500
  setTimeout(() => {
    setImmediate(() => {
      if (agentExit && !agentExitSent) {
        agentExitSent = true
        send({ agentExit })
      }
      const finalKill = { agentAlive: !agentExit, members: groupMembers() }
      let killed = false
      const killNow = () => {
        if (killed) return
        killed = true
        try {
          process.kill(-process.pid, 'SIGKILL')
        } catch {
          // 组已为空
        }
      }
      // 等控制通道写出后再对整组 SIGKILL（M3 3.4 第 4、5 步）；通道不可写时兜底。
      send({ finalKill }, killNow)
      setTimeout(killNow, 1000)
    })
  }, waitMs)
}

function release(go) {
  released = true
  const env = { ...(go.env || {}) }
  delete env.ELECTRON_RUN_AS_NODE
  if (!env.MELDWORK_CONTAINER) env.MELDWORK_CONTAINER = crypto.randomBytes(16).toString('hex')
  agentChild = spawn(go.command, go.args || [], {
    cwd: go.cwd,
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  agentChild.on('exit', (code, signal) => {
    agentExit = { code, signal }
    if (!agentExitSent) {
      agentExitSent = true
      send({ agentExit })
    }
    beginCleanup(false)
  })
  agentChild.on('error', (error) => {
    send({ error: { code: 'SPAWN_FAILED', message: String((error && error.message) || error) } })
    beginCleanup(false)
  })
  // 子进程已继承 0、1、2 的副本；关闭自己持有的这几个描述符，
  // 使 stdout/stderr 的结束只取决于 Agent 及其子进程。
  for (const fd of [0, 1, 2]) {
    try {
      fs.closeSync(fd)
    } catch {
      // 已关闭
    }
  }
  // 实测约束（Node 25 / macOS）：0、1、2 全部关闭后，进程再 spawn 子进程
  // （清理阶段要运行 pgrep/ps）会 SIGABRT——新管道的编号落进这三个空位。
  // 用 /dev/null 立即重新占用它们：仍然不持有 Agent 的输出管道，
  // 同时让后续 spawn 拿到不冲突的描述符。
  try {
    const rebound = [
      fs.openSync('/dev/null', 'r'),
      fs.openSync('/dev/null', 'w'),
      fs.openSync('/dev/null', 'w'),
    ]
    if (rebound[0] !== 0 || rebound[1] !== 1 || rebound[2] !== 2) {
      send({ error: { code: 'STDIO_REBIND_FAILED', message: rebound.join(',') } })
    }
  } catch (error) {
    send({ error: { code: 'STDIO_REBIND_FAILED', message: String((error && error.message) || error) } })
  }
}

channel.setEncoding('utf8')
channel.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!released && message && message.go) {
      release(message.go)
    } else if (message && message.stop) {
      beginCleanup(message.stop.force === true)
    }
  }
})

function onChannelGone() {
  if (channelClosed) return
  channelClosed = true
  // 放行之前控制通道关闭：Agent 从未开始。
  if (!released) process.exit(0)
  beginCleanup(false)
}

channel.on('end', onChannelGone)
channel.on('close', onChannelGone)
channel.on('error', onChannelGone)
