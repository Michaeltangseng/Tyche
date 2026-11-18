const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const test = require('node:test')

const { pidFilePath, sweepRuntimeProcesses } = require('../../src/room/runtime-processes.cjs')
const { groupEmpty, processStartTime } = require('../../src/agents/process/process-inspect.cjs')

test('sweep stops a recorded detached runtime group and forgets its pid file', {
  skip: process.platform === 'win32',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-runtime-processes-'))
  const previous = process.env.LC_ALL
  process.env.LC_ALL = 'C'
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    process.env.LC_ALL = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await once(child, 'spawn')
  const started = await processStartTime(child.pid)
  assert.ok(started)
  const file = pidFilePath(directory, 'run-1')
  fs.writeFileSync(file, `${child.pid}\t${started}\n`)

  const result = await sweepRuntimeProcesses({ directory })
  assert.equal(result.killed, 1)
  assert.equal(fs.existsSync(file), false)
  await once(child, 'exit')
  assert.equal(groupEmpty(child.pid), true)
})

test('sweep never signals a reused pid', {
  skip: process.platform === 'win32',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-runtime-processes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = pidFilePath(directory, 'run-2')
  fs.writeFileSync(file, `${process.pid}\tMon Jan  1 00:00:00 2000\n`)

  const result = await sweepRuntimeProcesses({ directory })
  assert.equal(result.killed, 0)
  assert.equal(result.skipped, 1)
  assert.equal(fs.existsSync(file), false)
})
