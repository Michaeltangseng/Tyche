const test = require('node:test')
const assert = require('node:assert/strict')

const {
  describePathChange,
  driftOptions,
  pathStateFromEntry,
} = require('../../src/project-room/path-change.cjs')

const absent = { kind: 'absent' }
const file = (mode = '100644', sha256 = 'a', size = 1) => ({ kind: 'file', mode, sha256, size })
const placeholder = (mode = '100644', sha256 = 'p', size = 100) => ({
  kind: 'placeholder', mode, sha256, size,
})
const link = target => ({ kind: 'link', target })

test('pathStateFromEntry recognizes all four states', () => {
  assert.deepEqual(pathStateFromEntry(null), { kind: 'absent' })
  assert.deepEqual(pathStateFromEntry({ kind: 'absent' }), { kind: 'absent' })
  assert.deepEqual(
    pathStateFromEntry({ path: 'a', reason: 'oversize', mode: '100644', size: 4, sha256: 'x' }),
    { kind: 'placeholder', mode: '100644', size: 4, sha256: 'x' },
  )
  assert.deepEqual(
    pathStateFromEntry({ kind: 'link', target: 'a.txt' }),
    { kind: 'link', target: 'a.txt' },
  )
  assert.deepEqual(
    pathStateFromEntry({ mode: '100755', size: 2, sha256: 'y' }),
    { kind: 'file', mode: '100755', size: 2, sha256: 'y' },
  )
})

test('describePathChange covers additions, deletions and unchanged states', () => {
  assert.deepEqual(describePathChange(absent, absent).change, 'unchanged')
  const added = describePathChange(absent, file())
  assert.equal(added.change, 'added')
  assert.equal(added.diffAvailable, true)
  assert.equal(describePathChange(absent, placeholder()).change, 'added')
  assert.equal(describePathChange(absent, placeholder()).diffAvailable, false)
  assert.equal(describePathChange(absent, link('x')).change, 'added')
  assert.equal(describePathChange(file(), absent).change, 'deleted')
  assert.equal(describePathChange(file(), absent).diffAvailable, true)
  assert.equal(describePathChange(placeholder(), absent).change, 'deleted')
  assert.equal(describePathChange(link('x'), absent).change, 'deleted')
  assert.equal(describePathChange(file(), file()).change, 'unchanged')
  assert.equal(describePathChange(link('x'), link('x')).change, 'unchanged')
})

test('describePathChange covers content, mode, placeholder and type changes', () => {
  const content = describePathChange(file('100644', 'a'), file('100644', 'b'))
  assert.equal(content.change, 'content-changed')
  assert.equal(content.diffAvailable, true)

  const mode = describePathChange(file('100644', 'a'), file('100755', 'a'))
  assert.equal(mode.change, 'mode-changed')
  assert.equal(mode.details.contentChanged, false)
  assert.equal(mode.diffAvailable, true)

  const modeAndContent = describePathChange(file('100644', 'a'), file('100755', 'b'))
  assert.equal(modeAndContent.change, 'mode-changed')
  assert.equal(modeAndContent.details.contentChanged, true)

  assert.equal(describePathChange(file(), placeholder()).change, 'large-file-changed')
  assert.equal(describePathChange(file(), placeholder()).diffAvailable, false)
  assert.equal(describePathChange(placeholder(), file()).change, 'large-file-changed')
  assert.equal(describePathChange(placeholder(), placeholder('100644', 'q')).change, 'large-file-changed')

  assert.equal(describePathChange(file(), link('x')).change, 'type-changed')
  assert.equal(describePathChange(link('x'), file()).change, 'type-changed')
  assert.equal(describePathChange(placeholder(), link('x')).change, 'type-changed')
  assert.equal(describePathChange(link('x'), link('y')).change, 'link-target-changed')
})

test('driftOptions disables restore only for placeholder accepted states', () => {
  assert.deepEqual(driftOptions(absent), { workdir: true, accepted: true, reason: null })
  assert.deepEqual(driftOptions(file()), { workdir: true, accepted: true, reason: null })
  assert.deepEqual(driftOptions(link('x')), { workdir: true, accepted: true, reason: null })
  assert.deepEqual(driftOptions(placeholder()), {
    workdir: true,
    accepted: false,
    reason: 'placeholder-has-no-content',
  })
})
