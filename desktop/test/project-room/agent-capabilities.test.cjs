const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CAPABILITIES,
  capabilitiesFor,
  validateSeatCapabilities,
} = require('../../src/project-room/agent-capabilities.cjs')

test('capabilities follow the milestone-0 measurements', () => {
  assert.deepEqual(CAPABILITIES, [
    'fullTrace', 'readExec', 'midTurnCancel', 'writeSessionContinuity', 'usage', 'managedProcess',
  ])
  const claude = capabilitiesFor('claude', { platform: 'darwin' })
  assert.equal(claude.readExec, true)
  assert.equal(claude.fullTrace, true)
  assert.equal(claude.managedProcess, true)
  const codex = capabilitiesFor('codex', { platform: 'darwin' })
  assert.equal(codex.readExec, true)
  const gemini = capabilitiesFor('gemini', { platform: 'darwin' })
  assert.equal(gemini.readExec, false)
  assert.equal(gemini.fullTrace, false)
})

test('Windows reports managedProcess as unavailable', () => {
  const windows = capabilitiesFor('claude', { platform: 'win32' })
  assert.equal(windows.managedProcess, false)
  const validation = validateSeatCapabilities(
    'claude', ['read', 'write-workdir'], { platform: 'win32' },
  )
  assert.equal(validation.ok, false)
  assert.ok(validation.unsupported.some(item => item.reason === 'managed-process-unsupported'))
})

test('read-exec is accepted only for Agents that measured support', () => {
  assert.deepEqual(validateSeatCapabilities('claude', ['read', 'read-exec']).unsupported, [])
  const gemini = validateSeatCapabilities('gemini', ['read', 'read-exec'])
  assert.equal(gemini.ok, false)
  assert.deepEqual(gemini.unsupported, [{
    capability: 'read-exec', reason: 'read-exec-unsupported',
  }])
  assert.equal(validateSeatCapabilities('codex', ['read', 'write-drafts']).ok, true)
})
