const assert = require('node:assert/strict')
const test = require('node:test')

const {
  capabilitiesForNativePermission,
  defaultNativePermission,
  nativePermissionAllowsExec,
  nativePermissionAllowsWrite,
  nativePermissionModes,
} = require('../../src/agents/native-permission-modes.cjs')
const { invocation } = require('../../src/agents/cli/cli-invocations.cjs')

test('native permission descriptors expose provider modes and safe defaults', () => {
  assert.equal(defaultNativePermission('claude'), 'plan')
  assert.equal(defaultNativePermission('codex'), 'read-only')
  assert.equal(defaultNativePermission('gemini'), 'default')
  assert.equal(defaultNativePermission('pi'), 'no-approve')
  assert.equal(defaultNativePermission('openclaw'), 'read-only')
  assert.equal(defaultNativePermission('kimi'), 'read-only')
  assert.equal(nativePermissionAllowsWrite('claude', 'acceptEdits'), true)
  assert.equal(nativePermissionAllowsWrite('claude', 'plan'), false)
  assert.equal(nativePermissionAllowsWrite('codex', 'danger-full-access'), true)
  assert.equal(nativePermissionAllowsWrite('openclaw', 'default'), true)
  assert.equal(nativePermissionAllowsWrite('openclaw', 'read-only'), false)
  assert.equal(nativePermissionAllowsExec('kimi', 'default'), true)
  assert.equal(nativePermissionAllowsExec('kimi', 'read-only'), false)
  assert.deepEqual(capabilitiesForNativePermission('claude', 'acceptEdits'), ['read', 'read-exec', 'write-drafts', 'write-workdir'])
  assert.deepEqual(capabilitiesForNativePermission('claude', 'plan'), ['read'])
  assert.deepEqual(nativePermissionModes('unknown-provider').map(mode => mode.id), ['default'])
})

test('native permission modes are passed through to provider CLI arguments', () => {
  assert.deepEqual(
    invocation('claude', 'claude', '/tmp/work', '', { nativePermission: 'acceptEdits' }).args.slice(-2),
    ['--permission-mode', 'acceptEdits'],
  )
  assert.ok(invocation('claude', 'claude', '/tmp/work', '', { nativePermission: 'bypassPermissions' }).args.includes('--dangerously-skip-permissions'))
  assert.ok(invocation('codex', 'codex', '/tmp/work', '', { nativePermission: 'danger-full-access' }).args.includes('danger-full-access'))
  assert.ok(invocation('gemini', 'gemini', '/tmp/work', '', { nativePermission: 'yolo' }).args.includes('yolo'))
  assert.ok(invocation('pi', 'pi', '/tmp/work', '', { nativePermission: 'approve' }).args.includes('--approve'))
})
