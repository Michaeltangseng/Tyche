const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')

const {
  groupEmpty,
  groupMembers,
  processGroupOf,
  processProgramName,
  processStartTime,
  readEnvironmentMarker,
} = require('../../../src/agents/process/process-inspect.cjs')

test('processStartTime reads the process start time and returns null when absent', async () => {
  const calls = []
  const value = await processStartTime(321, {
    execFileFn: async (file, args) => {
      calls.push([file, args])
      return { stdout: 'Sat Nov 14 10:00:00 2026\n' }
    },
  })
  assert.equal(value, 'Sat Nov 14 10:00:00 2026')
  assert.deepEqual(calls[0], ['ps', ['-o', 'lstart=', '-p', '321']])

  const absent = await processStartTime(322, {
    execFileFn: async () => { throw Object.assign(new Error('ps failed'), { code: 1 }) },
  })
  assert.equal(absent, null)
})

test('processGroupOf parses the process group and returns null when absent', async () => {
  const calls = []
  const value = await processGroupOf(321, {
    execFileFn: async (file, args) => {
      calls.push([file, args])
      return { stdout: '9001\n' }
    },
  })
  assert.equal(value, 9001)
  assert.deepEqual(calls[0], ['ps', ['-o', 'pgid=', '-p', '321']])

  const absent = await processGroupOf(322, {
    execFileFn: async () => { throw Object.assign(new Error('ps failed'), { code: 1 }) },
  })
  assert.equal(absent, null)
})

test('processProgramName reports the last path segment and null when absent', async () => {
  const value = await processProgramName(321, {
    execFileFn: async (file, args) => {
      assert.equal(file, 'ps')
      assert.deepEqual(args, ['-o', 'comm=', '-p', '321'])
      return { stdout: '/usr/local/bin/node\n' }
    },
  })
  assert.equal(value, 'node')
  const absent = await processProgramName(322, {
    execFileFn: async () => { throw Object.assign(new Error('ps failed'), { code: 1 }) },
  })
  assert.equal(absent, null)
})

test('groupMembers lists each member with its start time', async () => {
  const calls = []
  const members = await groupMembers(555, {
    execFileFn: async (file, args) => {
      calls.push([file, args])
      if (file === 'pgrep') return { stdout: '100\n200\n' }
      const pid = args[args.length - 1]
      return { stdout: pid === '100' ? 'START-100\n' : 'START-200\n' }
    },
  })
  assert.deepEqual(members, [
    { pid: 100, startTime: 'START-100' },
    { pid: 200, startTime: 'START-200' },
  ])
  assert.deepEqual(calls[0], ['pgrep', ['-g', '555']])
})

test('groupMembers returns an empty list when pgrep finds no members', async () => {
  const members = await groupMembers(556, {
    execFileFn: async () => { throw Object.assign(new Error('no members'), { code: 1 }) },
  })
  assert.deepEqual(members, [])
})

test('groupEmpty distinguishes ESRCH from EPERM and a live group', () => {
  assert.equal(groupEmpty(600, {
    killFn: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
  }), true)
  assert.equal(groupEmpty(600, {
    killFn: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
  }), false)
  assert.equal(groupEmpty(600, { killFn: () => undefined }), false)
})

test('readEnvironmentMarker reads ps output on macOS', async () => {
  const marker = 'marker-darwin'
  const present = await readEnvironmentMarker(100, marker, {
    platform: 'darwin',
    execFileFn: async (file, args) => {
      assert.equal(file, 'ps')
      assert.deepEqual(args, ['-wwE', '-o', 'command=', '-p', '100'])
      return { stdout: `/usr/bin/agent MELDWORK_CONTAINER=${marker} PATH=/usr/bin\n` }
    },
  })
  assert.equal(present, 'present')

  const absent = await readEnvironmentMarker(100, marker, {
    platform: 'darwin',
    execFileFn: async () => ({ stdout: '/usr/bin/agent PATH=/usr/bin MARKS=other\n' }),
  })
  assert.equal(absent, 'absent')

  // macOS 15 exposes neither ps -E nor KERN_PROCARGS2 environment data; an
  // output with no environment-looking token must be reported as unreadable,
  // not as a confirmed absence.
  const hidden = await readEnvironmentMarker(100, marker, {
    platform: 'darwin',
    execFileFn: async () => ({ stdout: '/usr/bin/agent\n' }),
  })
  assert.equal(hidden, 'unreadable')

  const unreadable = await readEnvironmentMarker(100, marker, {
    platform: 'darwin',
    execFileFn: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
  })
  assert.equal(unreadable, 'unreadable')
})

test('readEnvironmentMarker reads /proc on Linux', async () => {
  const marker = 'marker-linux'
  const present = await readEnvironmentMarker(100, marker, {
    platform: 'linux',
    readFileFn: () => Buffer.from(`PATH=/usr/bin\0MELDWORK_CONTAINER=${marker}\0`),
  })
  assert.equal(present, 'present')

  const absent = await readEnvironmentMarker(100, marker, {
    platform: 'linux',
    readFileFn: () => Buffer.from('PATH=/usr/bin\0MELDWORK_CONTAINER=other\0'),
  })
  assert.equal(absent, 'absent')

  const unreadable = await readEnvironmentMarker(100, marker, {
    platform: 'linux',
    readFileFn: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  })
  assert.equal(unreadable, 'unreadable')
})

test('reads a real child process start time, group and environment marker', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process inspection is not available on Windows')
  const marker = `meldwork-inspect-${process.pid}-${Date.now()}`
  const child = spawn('sleep', ['5'], {
    env: { ...process.env, MELDWORK_CONTAINER: marker },
    stdio: 'ignore',
  })
  let exited = false
  child.once('exit', () => { exited = true })
  try {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const startTime = await processStartTime(child.pid)
    assert.ok(startTime)
    const pgid = await processGroupOf(child.pid)
    assert.ok(Number.isInteger(pgid))
    const members = await groupMembers(pgid)
    assert.ok(members.some((member) => member.pid === child.pid))
    const state = await readEnvironmentMarker(child.pid, marker, { platform: process.platform })
    // macOS 15 hides other processes' environments; the marker is present in
    // the child's own environment but cannot be read from outside. Accept
    // `unreadable` there; never accept a confirmed absence.
    assert.ok(state === 'present' || state === 'unreadable', `unexpected marker state: ${state}`)
  } finally {
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      await new Promise((resolve) => {
        child.once('exit', resolve)
        if (child.exitCode !== null || child.signalCode !== null) resolve()
      })
    }
  }
})
