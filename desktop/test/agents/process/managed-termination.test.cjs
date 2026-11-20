const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  MANAGED_PROCESS,
  terminateAgentProcess,
} = require('../../../src/agents/cli/cli-process-support.cjs')

class FakeManagedChild extends EventEmitter {
  constructor() {
    super()
    this[MANAGED_PROCESS] = true
    this.stopCalls = []
    this.closeEmitted = false
  }

  stop(options) {
    this.stopCalls.push(options)
    setImmediate(() => {
      this.closeEmitted = true
      this.emit('close', 0, 'SIGKILL', {})
    })
    return true
  }
}

function spyOnProcessKill(t) {
  const original = process.kill
  const calls = []
  process.kill = (...args) => {
    calls.push(args)
    return true
  }
  t.after(() => { process.kill = original })
  return calls
}

test('cancelling a managed child uses stop without direct signals', async (t) => {
  const calls = spyOnProcessKill(t)
  const child = new FakeManagedChild()
  await terminateAgentProcess(child, { force: false })
  assert.deepEqual(child.stopCalls, [{ force: false }])
  assert.deepEqual(calls, [])
})

test('forcing a managed child uses stop force without direct signals', async (t) => {
  const calls = spyOnProcessKill(t)
  const child = new FakeManagedChild()
  await terminateAgentProcess(child, { force: true })
  assert.deepEqual(child.stopCalls, [{ force: true }])
  assert.deepEqual(calls, [])
})

test('an already closed managed child is not stopped again', async (t) => {
  const calls = spyOnProcessKill(t)
  const child = new FakeManagedChild()
  child.closeEmitted = true
  await terminateAgentProcess(child, { force: true })
  assert.deepEqual(child.stopCalls, [])
  assert.deepEqual(calls, [])
})

test('unmanaged children still use the direct process-group signal path', async (t) => {
  const calls = spyOnProcessKill(t)
  const child = new EventEmitter()
  child.pid = 424242
  child.exitCode = null
  child.signalCode = null
  const finished = terminateAgentProcess(child, { force: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(calls, [[-424242, 'SIGKILL']])
  child.emit('close', null, 'SIGKILL')
  await finished
})
