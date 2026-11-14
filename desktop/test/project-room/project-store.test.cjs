const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState, parseProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeState(directory, state) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
}

function readState(directory) {
  return parseProjectState(JSON.parse(
    fs.readFileSync(path.join(directory, 'state.json'), 'utf8'),
  ))
}

function byteSize(state) {
  return Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8')
}

function writer({ failure } = {}) {
  let calls = 0
  return {
    calls: () => calls,
    write(filename, contents) {
      calls += 1
      const result = failure?.(calls, filename, contents)
      if (result?.phase === 'before-commit') {
        throw Object.assign(new Error(result.code || 'EIO'), { phase: 'before-commit' })
      }
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, contents)
      if (result?.phase === 'after-commit') {
        throw Object.assign(new Error(result.code || 'EIO'), { phase: 'after-commit' })
      }
    },
  }
}

async function loadedStore(directory, options = {}) {
  const store = new ProjectStore({
    projectDir: directory,
    now: () => at,
    ...options,
  })
  await store.load()
  return store
}

test('commits 100 queued operations in order with consecutive revisions', async (t) => {
  const directory = fixture(t)
  const base = emptyProjectState({ projectId: 'project-1' })
  writeState(directory, base)
  const store = await loadedStore(directory)
  const commits = []
  store.onCommitted(event => commits.push(event))

  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => (
    store.enqueue((state) => {
      state.config.configRevision += 1
      state.preferences.drawerWidth = index + 1
      return { next: state, result: index }
    })
  )))

  assert.deepEqual(results.map(result => result.revision), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.ok(results.every(result => result.durable === true))
  assert.deepEqual(results.map(result => result.result), Array.from({ length: 100 }, (_, i) => i))
  assert.equal(store.current().revision, 100)
  assert.equal(store.current().config.configRevision, 100)
  assert.equal(store.current().preferences.drawerWidth, 100)
  assert.equal(readState(directory).revision, 100)
  assert.equal(readState(directory).config.configRevision, 100)
  assert.deepEqual(commits.map(event => event.revision), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.ok(commits.every(event => event.durable === true))
})

test('a before-commit failure leaves memory and disk unchanged', async (t) => {
  const directory = fixture(t)
  writeState(directory, emptyProjectState({ projectId: 'project-1' }))
  const recording = writer({ failure: call => call === 1 ? { phase: 'before-commit' } : null })
  const store = await loadedStore(directory, { writeFile: recording.write })

  await assert.rejects(store.enqueue((state) => {
    state.config.configRevision = 1
    return { next: state }
  }), { message: 'EIO' })

  assert.equal(store.current().revision, 0)
  assert.equal(store.current().config.configRevision, 0)
  assert.equal(readState(directory).revision, 0)
  assert.equal(recording.calls(), 1)

  const reloaded = await loadedStore(directory)
  assert.equal(reloaded.current().revision, 0)
})

test('an after-commit failure adopts memory and the rewrite confirms durability', async (t) => {
  const directory = fixture(t)
  writeState(directory, emptyProjectState({ projectId: 'project-1' }))
  const recording = writer({ failure: call => call === 1 ? { phase: 'after-commit' } : null })
  const store = await loadedStore(directory, { writeFile: recording.write })
  const commits = []
  store.onCommitted(event => commits.push(event))

  const result = await store.enqueue((state) => {
    state.config.configRevision = 1
    return { next: state }
  })

  assert.deepEqual(result, { revision: 1, durable: true, result: undefined })
  assert.equal(store.current().revision, 1)
  assert.equal(store.current().config.configRevision, 1)
  assert.equal(store.getStorageFault(), null)
  assert.deepEqual(commits, [
    { revision: 1, durable: false },
    { revision: 1, durable: true },
  ])
  assert.equal(readState(directory).revision, 1)
  assert.equal(readState(directory).config.configRevision, 1)
  assert.equal(recording.calls(), 2)
})

test('a failed rewrite keeps the new state in memory and later writes build on it', async (t) => {
  const directory = fixture(t)
  writeState(directory, emptyProjectState({ projectId: 'project-1' }))
  const recording = writer({
    failure: call => (call <= 2 ? { phase: 'after-commit', code: 'EIO' } : null),
  })
  const store = await loadedStore(directory, { writeFile: recording.write })
  const commits = []
  store.onCommitted(event => commits.push(event))

  const first = await store.enqueue((state) => {
    state.config.configRevision = 1
    return { next: state }
  })
  assert.equal(first.durable, false)
  assert.equal(first.revision, 1)
  assert.equal(store.current().revision, 1)
  assert.equal(store.current().config.configRevision, 1)
  assert.equal(store.getStorageFault().phase, 'after-commit')
  assert.equal(store.getStorageFault().revision, 1)

  const second = await store.enqueue((state) => {
    state.config.configRevision += 1
    return { next: state }
  })
  assert.equal(second.durable, true)
  assert.equal(second.revision, 2)
  const saved = readState(directory)
  assert.equal(saved.revision, 2)
  assert.equal(saved.config.configRevision, 2)
  assert.deepEqual(commits, [
    { revision: 1, durable: false },
    { revision: 2, durable: true },
  ])
})

test('invalid operations and states reject without committing', async (t) => {
  const directory = fixture(t)
  writeState(directory, emptyProjectState({ projectId: 'project-1' }))
  const store = await loadedStore(directory)

  await assert.rejects(store.enqueue(() => {
    throw new Error('operation-failed')
  }), { message: 'operation-failed' })
  assert.equal(store.current().revision, 0)

  await assert.rejects(store.enqueue((state) => {
    state.config.seats = [{ id: 'broken' }]
    return { next: state }
  }), { code: 'PROJECT_STATE_INVALID' })
  assert.equal(store.current().revision, 0)
  assert.equal(readState(directory).revision, 0)

  await assert.rejects(store.enqueue((state) => {
    state.projectId = 'another-project'
    return { next: state }
  }), (error) => {
    assert.equal(error.code, 'PROJECT_STATE_INVALID')
    assert.equal(error.details.reason, 'project-id-mismatch')
    return true
  })
  assert.equal(store.current().revision, 0)
})

function oversizedState(base, characters) {
  const state = structuredClone(base)
  state.config.profiles = [{
    id: 'profile-1',
    seatId: 'seat-1',
    version: 1,
    text: 'x'.repeat(characters),
    createdAt: at,
    source: 'default',
  }]
  return state
}

test('a regular write that stays too large records a project fault and rejects', async (t) => {
  const directory = fixture(t)
  const base = emptyProjectState({ projectId: 'project-1' })
  writeState(directory, base)
  const baseSize = byteSize(base)
  const store = await loadedStore(directory, {
    limits: { regular: baseSize + 100, control: baseSize + 2000 },
  })

  await assert.rejects(store.enqueue(() => ({
    next: oversizedState(base, 600),
  })), (error) => {
    assert.equal(error.code, 'PROJECT_STATE_TOO_LARGE')
    assert.equal(error.details.limit, baseSize + 100)
    return true
  })

  const faulted = readState(directory)
  assert.equal(faulted.revision, 1)
  assert.equal(faulted.projectBlockedOn.error, 'PROJECT_STATE_TOO_LARGE')
  assert.equal(store.current().revision, 1)
  assert.equal(store.current().projectBlockedOn.error, 'PROJECT_STATE_TOO_LARGE')

  const recovered = await store.enqueue((state) => {
    state.config.profiles = []
    state.projectBlockedOn = null
    return { next: state, control: true }
  })
  assert.equal(recovered.durable, true)
  assert.equal(recovered.revision, 2)
  assert.equal(store.current().projectBlockedOn, null)
  assert.equal(readState(directory).projectBlockedOn, null)
})

test('a control write may use the space between the regular and hard limits', async (t) => {
  const directory = fixture(t)
  const base = emptyProjectState({ projectId: 'project-1' })
  writeState(directory, base)
  const baseSize = byteSize(base)
  const store = await loadedStore(directory, {
    limits: { regular: baseSize + 100, control: baseSize + 2000 },
  })

  const result = await store.enqueue(() => ({
    next: oversizedState(base, 600),
    control: true,
  }))
  assert.equal(result.durable, true)
  assert.equal(result.revision, 1)
  assert.equal(readState(directory).config.profiles[0].text.length, 600)
})

test('a control write over the hard limit writes fault.json and turns read-only', async (t) => {
  const directory = fixture(t)
  const base = emptyProjectState({ projectId: 'project-1' })
  writeState(directory, base)
  const baseSize = byteSize(base)
  const store = await loadedStore(directory, {
    limits: { regular: baseSize + 50, control: baseSize + 100 },
  })

  await assert.rejects(store.enqueue(() => ({
    next: oversizedState(base, 600),
    control: true,
  })), (error) => {
    assert.equal(error.code, 'PROJECT_STATE_TOO_LARGE')
    assert.equal(error.details.limit, baseSize + 100)
    return true
  })
  assert.equal(store.isReadOnly(), true)
  assert.equal(fs.existsSync(path.join(directory, 'fault.json')), true)
  assert.equal(readState(directory).revision, 0)

  await assert.rejects(store.enqueue((state) => ({ next: state })), {
    code: 'PROJECT_READ_ONLY',
  })

  const reloaded = await loadedStore(directory)
  assert.equal(reloaded.isReadOnly(), true)
  assert.equal(reloaded.current().revision, 0)
})

test('a missing state file or an existing fault file is reported on load', async (t) => {
  const directory = fixture(t)
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  await assert.rejects(store.load(), (error) => {
    assert.equal(error.code, 'PROJECT_STATE_INVALID')
    assert.equal(error.details.reason, 'missing')
    return true
  })

  writeState(directory, emptyProjectState({ projectId: 'project-1' }))
  fs.writeFileSync(path.join(directory, 'fault.json'), JSON.stringify({ code: 'PROJECT_STATE_TOO_LARGE' }))
  const faulted = await loadedStore(directory)
  assert.equal(faulted.isReadOnly(), true)
  await assert.rejects(faulted.enqueue((state) => ({ next: state })), {
    code: 'PROJECT_READ_ONLY',
  })
})
