const test = require('node:test')
const assert = require('node:assert/strict')
const { invocation } = require('../../src/agents/cli/cli-invocations.cjs')
const { automaticPermissionResponse } = require('../../src/agents/agent-permission-policy.cjs')

function request(kind) {
  return {
    toolCall: { kind },
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ],
  }
}

test('read-exec approves execute but rejects edits; read-only rejects execute', () => {
  assert.deepEqual(automaticPermissionResponse(request('execute'), {
    allowWrite: false, readExec: true,
  }), { status: 'approved', optionId: 'allow-once' })
  assert.equal(automaticPermissionResponse(request('edit'), {
    allowWrite: false, readExec: true,
  }).status, 'rejected')
  assert.equal(automaticPermissionResponse(request('execute'), {
    allowWrite: false, readExec: false,
  }).status, 'rejected')
  assert.deepEqual(automaticPermissionResponse(request('read'), {
    allowWrite: false, readExec: false,
  }), { status: 'approved', optionId: 'allow-once' })
})

test('Claude print read-exec uses tool lists and no permission mode', () => {
  const spec = invocation('claude', '/bin/claude', '/tmp', '', { sandbox: 'read-exec' })
  assert.equal(spec.args.includes('--permission-mode'), false)
  assert.ok(spec.args.includes('--allowedTools'))
  assert.equal(spec.args[spec.args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Bash')
  assert.ok(spec.args.includes('--disallowedTools'))
  assert.equal(
    spec.args[spec.args.indexOf('--disallowedTools') + 1],
    'Edit,Write,MultiEdit,NotebookEdit',
  )
  assert.equal(spec.args.at(-1), '--')

  const resumed = invocation('claude', '/bin/claude', '/tmp', 'session-1', { sandbox: 'read-exec' })
  assert.deepEqual(resumed.args.slice(-3), ['--resume', 'session-1', '--'])
})

test('Codex exec read-exec uses the read-only sandbox', () => {
  const spec = invocation('codex', '/bin/codex', '/tmp', '', { sandbox: 'read-exec' })
  const index = spec.args.indexOf('--sandbox')
  assert.equal(spec.args[index + 1], 'read-only')
})

test('unsupported CLI kinds refuse read-exec instead of degrading', () => {
  assert.throws(
    () => invocation('gemini', '/bin/gemini', '/tmp', '', { sandbox: 'read-exec' }),
    (error) => {
      assert.equal(error.code, 'PROJECT_CAPABILITY_UNSUPPORTED')
      assert.equal(error.details.capability, 'read-exec')
      return true
    },
  )
})
