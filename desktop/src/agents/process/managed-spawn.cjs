const crypto = require('node:crypto')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')

const inspector = require('./process-inspect.cjs')

const MANAGED_PROCESS = Symbol.for('tyche.managed-process')
const CONTROL_DRAIN_TIMEOUT_MS = 5000

function managedError(code) {
  return Object.assign(new Error(code), { code })
}

function assertSupervisor(supervisorPath) {
  try {
    fs.accessSync(supervisorPath, fs.constants.X_OK)
  } catch (error) {
    throw managedError('LOCAL_MANAGED_PROCESS_UNAVAILABLE')
  }
}

class ManagedChild extends EventEmitter {
  constructor(options) {
    super()
    this[MANAGED_PROCESS] = true
    this.supervisor = options.supervisor
    this.stdin = options.supervisor.stdin
    this.stdout = options.supervisor.stdout
    this.stderr = options.supervisor.stderr
    this.pid = options.supervisor.pid
    this.controlChannel = options.supervisor.stdio[3]
    this.exitCode = null
    this.signalCode = null
    this.marker = options.marker
    this.registry = options.registry
    this.invocation = options.invocation || {}
    this.command = options.command
    this.args = options.args || []
    this.env = options.env
    this.cwd = options.cwd
    this.inspect = options.inspect || inspector
    this.closeTimeoutMs = Number.isFinite(options.closeTimeoutMs)
      ? Math.max(0, options.closeTimeoutMs)
      : CONTROL_DRAIN_TIMEOUT_MS
    this.recordId = null
    this.agentPid = null
    this.agentExit = null
    this.finalKill = null
    this.supervisorExit = null
    this.controlEnded = false
    this.supervisorClosed = false
    this.exitEmitted = false
    this.closeEmitted = false
    this.containerChecked = false
    this.errorEmitted = false
    this.stopRequested = false
    this.outputTruncated = false
    this.diagnostics = []
    this.controlBuffer = ''
    this.controlTimer = null
    this.closeTimer = null
    // Avoid an unhandled 'error' event before the adapter attaches its
    // listener; adapters still receive the same event.
    this.on('error', () => {})

    this.controlChannel.setEncoding('utf8')
    this.controlChannel.on('data', (chunk) => this.onControlData(chunk))
    this.controlChannel.on('end', () => this.onControlEnded())
    this.controlChannel.on('error', () => this.onControlEnded())
    this.supervisor.on('exit', (code, signal) => {
      this.supervisorExit = { code, signal }
      if (!this.controlEnded) this.armControlDrainTimeout()
      this.selectExit()
    })
    this.supervisor.on('close', () => {
      this.supervisorClosed = true
      this.maybeClose()
    })
    this.supervisor.on('error', () => this.emitFailure('LOCAL_AGENT_SPAWN_FAILED'))
  }

  async start() {
    try {
      this.recordId = await this.registry.begin({
        invocationId: this.invocation.invocationId,
        groupId: this.invocation.groupId,
        projectId: this.invocation.projectId,
        workdir: this.invocation.workdir || this.cwd,
        permission: this.invocation.permission,
        claims: this.invocation.claims,
        containerMarker: this.marker,
        agentKind: this.invocation.agentKind,
      })
      const leaderStartTime = await this.inspect.processStartTime(this.supervisor.pid)
      await this.registry.markRunning(this.recordId, {
        pgid: this.supervisor.pid,
        leaderStartTime,
      })
      if (this.stopRequested) return
      if (this.supervisor.exitCode !== null || this.supervisor.signalCode !== null) return
      this.controlChannel.write(`${JSON.stringify({
        go: {
          command: this.command,
          args: this.args,
          env: this.env,
          cwd: this.cwd,
        },
      })}\n`)
    } catch (error) {
      this.emitFailure(error && error.code ? error.code : 'LOCAL_MANAGED_PROCESS_UNAVAILABLE')
      try { this.controlChannel.end() } catch { /* already closed */ }
    }
  }

  stop({ force = false } = {}) {
    this.stopRequested = true
    if (this.controlChannel.destroyed) return false
    try {
      this.controlChannel.write(`${JSON.stringify({ stop: { force: force === true } })}\n`)
      return true
    } catch {
      return false
    }
  }

  kill(signal) {
    if (signal === 'SIGKILL') return this.stop({ force: true })
    return this.stop({ force: false })
  }

  onControlData(chunk) {
    this.controlBuffer += chunk
    let index
    while ((index = this.controlBuffer.indexOf('\n')) >= 0) {
      const line = this.controlBuffer.slice(0, index)
      this.controlBuffer = this.controlBuffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.started && Number.isInteger(message.started.agentPid)) {
        this.agentPid = message.started.agentPid
      } else if (message.agentExit) {
        this.agentExit = message.agentExit
        if (!this.exitEmitted) {
          this.emitExit(
            message.agentExit.code == null ? null : message.agentExit.code,
            message.agentExit.signal == null ? null : message.agentExit.signal,
            {},
          )
        }
      } else if (message.finalKill) {
        this.finalKill = message.finalKill
      } else if (message.error && message.error.code) {
        this.diagnostics.push(message.error)
      }
    }
  }

  onControlEnded() {
    if (this.controlEnded) return
    this.controlEnded = true
    this.selectExit()
  }

  armControlDrainTimeout() {
    if (this.controlTimer) return
    this.controlTimer = setTimeout(() => {
      this.controlTimer = null
      if (this.controlEnded) return
      this.outputTruncated = true
      this.controlEnded = true
      try { this.stdout.destroy() } catch { /* already closed */ }
      try { this.stderr.destroy() } catch { /* already closed */ }
      this.selectExit()
      this.maybeClose(true)
    }, CONTROL_DRAIN_TIMEOUT_MS)
    this.controlTimer.unref?.()
  }

  selectExit() {
    if (this.exitEmitted || !this.supervisorExit || !this.controlEnded) return
    if (this.agentExit) return
    if (this.finalKill) {
      if (this.finalKill.agentAlive) {
        this.emitExit(null, 'SIGKILL', { terminatedBy: 'cleanup' })
      } else {
        this.emitExit(null, null, {
          failureCode: 'LOCAL_AGENT_EXIT_UNKNOWN',
          terminatedBy: 'cleanup',
        })
      }
      return
    }
    this.emitExit(null, null, { failureCode: 'LOCAL_AGENT_SUPERVISOR_LOST' })
  }

  emitExit(code, signal, info) {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.exitCode = code
    this.signalCode = signal
    if (this.controlTimer) {
      clearTimeout(this.controlTimer)
      this.controlTimer = null
    }
    this.emit('exit', code, signal, info || {})
    // M3 3.4: after `exit`, wait at most 5 seconds for the output pipes to
    // drain; a process that still holds them (or an unresponsive container)
    // must not keep `close` pending forever.
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      if (this.closeEmitted) return
      this.outputTruncated = true
      try { this.stdout.destroy() } catch { /* already closed */ }
      try { this.stderr.destroy() } catch { /* already closed */ }
      this.maybeClose(true)
    }, this.closeTimeoutMs)
    this.closeTimer.unref?.()
    this.maybeClose()
  }

  maybeClose(force = false) {
    if (this.closeEmitted || !this.exitEmitted) return
    if (!this.supervisorClosed && !force) return
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.closeEmitted = true
    this.emit('close', this.exitCode, this.signalCode,
      this.outputTruncated ? { outputTruncated: true } : {})
    this.checkContainer()
  }

  async checkContainer() {
    if (this.containerChecked || !this.closeEmitted) return
    this.containerChecked = true
    // The supervisor's final SIGKILL can leave short-lived zombies whose
    // process-group membership survives until their new parent reaps them.
    // Poll briefly before declaring the container non-empty.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.inspect.groupEmpty(this.pid)) {
        this.emit('container-empty')
        if (this.recordId) this.registry.markEnded(this.recordId).catch(() => {})
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (this.recordId) {
      this.registry.markEnding(this.recordId, {
        finalKillMembers: this.finalKill && Array.isArray(this.finalKill.members)
          ? this.finalKill.members
          : [],
      }).catch(() => {})
    }
  }

  emitFailure(code) {
    if (this.errorEmitted) return
    this.errorEmitted = true
    this.emit('error', managedError(code))
  }
}

function managedProcessSupported(platform = process.platform) {
  return platform !== 'win32'
}

function createManagedSpawn({
  registry,
  invocation,
  supervisorPath,
  platform = process.platform,
  inspect = inspector,
  closeTimeoutMs,
} = {}) {
  return function spawnManaged(command, args = [], options = {}) {
    if (!managedProcessSupported(platform)) throw managedError('LOCAL_MANAGED_PROCESS_UNAVAILABLE')
    if (!registry) throw managedError('LOCAL_MANAGED_PROCESS_UNAVAILABLE')
    assertSupervisor(supervisorPath)
    const marker = crypto.randomBytes(16).toString('hex')
    const env = { ...(options.env || process.env), TYCHE_CONTAINER: marker }
    const supervisor = spawn(supervisorPath, [], {
      cwd: options.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
      windowsHide: true,
    })
    const child = new ManagedChild({
      supervisor,
      marker,
      registry,
      invocation,
      command,
      args,
      env,
      cwd: options.cwd || process.cwd(),
      inspect,
      closeTimeoutMs,
    })
    child.start()
    return child
  }
}

module.exports = {
  CONTROL_DRAIN_TIMEOUT_MS,
  MANAGED_PROCESS,
  ManagedChild,
  createManagedSpawn,
  managedProcessSupported,
}
