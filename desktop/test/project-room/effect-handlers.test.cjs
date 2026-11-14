const test = require('node:test')
const assert = require('node:assert/strict')
const { createEffectHandlers } = require('../../src/project-room/effect-handlers.cjs')

function effect(type, params = {}) {
  return { id: `effect-${type}`, type, params }
}

function fakeRepo() {
  const calls = []
  return {
    calls,
    async snapshot(input) {
      calls.push(['snapshot', input])
      return { commit: 'a'.repeat(40), placeholderList: [], skipped: false }
    },
    async driftCheck(input) {
      calls.push(['driftCheck', input])
      return { snapshotCommit: 'b'.repeat(40), drifted: [] }
    },
    async diffQuiet() {
      return false
    },
    async verifyAgainst(input) {
      calls.push(['verifyAgainst', input])
      return { intact: true, differing: [] }
    },
    async acceptCommit(input) {
      calls.push(['acceptCommit', input])
      return 'c'.repeat(40)
    },
    async restoreFiles(input) {
      calls.push(['restoreFiles', input])
      return { restored: [] }
    },
    async dropRefs(refs) {
      calls.push(['dropRefs', refs])
    },
  }
}

test('git handlers forward effect parameters to the shadow repository', async () => {
  const repo = fakeRepo()
  const handlers = createEffectHandlers({ shadowRepo: repo })
  const snapshot = await handlers.snapshot({
    effect: effect('snapshot', {
      targets: ['docs/a.md'], placeholderList: [], limits: {}, isOptional: true,
    }),
  })
  assert.equal(snapshot.commit, 'a'.repeat(40))
  assert.deepEqual(repo.calls[0], ['snapshot', {
    effectId: 'effect-snapshot',
    targets: ['docs/a.md'],
    placeholderList: [],
    limits: {},
    isOptional: true,
  }])

  const verified = await handlers['verify-candidate']({
    effect: effect('verify-candidate', {
      candidate: 'c'.repeat(40), paths: ['docs/a.md'], placeholderList: [], limits: {},
    }),
  })
  assert.equal(verified.intact, true)
  assert.equal(repo.calls[1][1].commit, 'c'.repeat(40))

  const accepted = await handlers['accept-commit']({
    effect: effect('accept-commit', {
      candidate: 'c'.repeat(40), recordPaths: ['meldwork/decisions.md'], parent: null, message: 'Accept',
    }),
  })
  assert.deepEqual(accepted, { commit: 'c'.repeat(40) })

  await handlers['restore-files']({
    effect: effect('restore-files', { commit: 'c'.repeat(40), paths: ['docs/a.md'] }),
  })
  await handlers['drop-snapshot-refs']({
    effect: effect('drop-snapshot-refs', { refs: ['refs/meldwork/snap/x'] }),
  })
  assert.deepEqual(repo.calls.at(-1), ['dropRefs', ['refs/meldwork/snap/x']])
})

test('evaluate-submission compares the target files and the response file', async () => {
  const repo = fakeRepo()
  const seen = []
  repo.diffQuiet = async (previous, candidate, paths) => {
    seen.push([previous, candidate, paths])
    return paths[0] === 'meldwork/reviews/requirements/r2-response.md'
      ? false
      : true
  }
  const handlers = createEffectHandlers({ shadowRepo: repo })
  const result = await handlers['evaluate-submission']({
    effect: effect('evaluate-submission', {
      previousCandidate: 'a'.repeat(40),
      candidate: 'b'.repeat(40),
      targetFiles: ['docs/requirements.md'],
      responseFile: 'meldwork/reviews/requirements/r2-response.md',
    }),
  })
  assert.equal(result.bodyChanged, false)
  assert.equal(result.newResponse, true)
  assert.equal(result.manifestValid, true)
})

test('missing hooks fail closed with EFFECT_HANDLER_UNAVAILABLE', async () => {
  const handlers = createEffectHandlers({ shadowRepo: fakeRepo() })
  await assert.rejects(
    handlers['write-review-file']({ effect: effect('write-review-file', {}) }),
    { code: 'EFFECT_HANDLER_UNAVAILABLE' },
  )
  await assert.rejects(
    handlers['append-decision']({ effect: effect('append-decision', {}) }),
    { code: 'EFFECT_HANDLER_UNAVAILABLE' },
  )
})

test('user repository commits use the injected user-git implementation', async () => {
  const calls = []
  const handlers = createEffectHandlers({
    userGit: {
      async userRepoCommit(input) {
        calls.push(input)
        return { committed: true, commit: 'd'.repeat(40) }
      },
    },
  })
  const result = await handlers['user-git-commit']({
    effect: effect('user-git-commit', {
      workTree: '/tmp/project', paths: ['docs/a.md'], acceptedEntries: {}, message: 'Commit',
      decisionId: 'decision-1',
    }),
  })
  assert.equal(result.committed, true)
  assert.equal(calls[0].decisionId, 'decision-1')
})
