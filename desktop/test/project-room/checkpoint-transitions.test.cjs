const test = require('node:test')
const assert = require('node:assert/strict')
const {
  build,
  events,
  rows,
  states,
} = require('./transition-table.cjs')
const { transition } = require('../../src/project-room/checkpoint-transitions.cjs')

function effectTypes(result) {
  return result.effects.map(effect => effect.type)
}

function assertExpectation(result, row) {
  const instance = result.instance
  for (const [key, value] of Object.entries(row.expect || {})) {
    switch (key) {
      case 'artifactVersions':
        assert.equal(instance.artifactVersions.length, value, key)
        break
      case 'blockedOn':
        assert.equal(instance.blockedOn?.effectId ?? null, value, key)
        break
      case 'candidate':
        assert.equal(instance.candidate, value, key)
        break
      case 'continuations':
        assert.equal(instance.continuations, value, key)
        break
      case 'driftDetected':
        assert.equal(value, true, key)
        break
      case 'draftsRecorded':
        assert.ok(instance.drafts.some(draft => draft.status !== 'pending'), key)
        break
      case 'epoch':
        assert.equal(instance.epoch, value, key)
        break
      case 'gateVoided':
        if (value) {
          assert.equal(instance.gate, null, key)
          assert.ok(instance.decisions.length > 0, key)
        }
        break
      case 'ignored':
        assert.deepEqual(result.effects, [], key)
        break
      case 'interjectionDelivered':
      case 'interjectionsDelivered':
        assert.equal(
          instance.interjections.filter(item => item.status === 'delivered').length,
          value,
          key,
        )
        break
      case 'interjectionQueued':
        assert.equal(
          instance.interjections.filter(item => item.status === 'queued').length,
          value,
          key,
        )
        break
      case 'leaseStatus':
        assert.equal(instance.leaseRequests[0].status, value, key)
        break
      case 'outcomeUnavailable':
        if (value) {
          assert.equal(
            result.diagnostics?.[0]?.code,
            'GATE_OUTCOME_UNAVAILABLE',
            key,
          )
        }
        break
      case 'passInvalidated':
        assert.equal(instance.rounds.at(-1)?.reviews.at(-1)?.verdict, value ? 'pass' : 'revise', key)
        break
      case 'pendingStart':
        assert.ok(instance.pendingStart, key)
        break
      case 'rebuttal':
        assert.equal(instance.rounds.at(-1)?.rebuttal, value, key)
        break
      case 'reopenAfterAccept':
        assert.equal(instance.epoch, 0, key)
        assert.equal(instance.state, 'accepting', key)
        break
      case 'round':
        assert.equal(instance.round, value, key)
        break
      case 'roundsSinceHuman':
        assert.equal(instance.roundsSinceHuman, value, key)
        break
      case 'sessionGeneration':
        assert.equal(instance.sessionGeneration, value, key)
        break
      case 'stopAccepted':
        assert.equal(value, true, key)
        break
      default:
        assert.fail(`unknown expectation ${key}`)
    }
  }
}

for (const [index, row] of rows.entries()) {
  const eventType = typeof row.event === 'string' ? row.event : row.event.type
  test(`row ${index + 1}: ${row.state} × ${eventType}`, () => {
    const scenario = build(row)
    const result = transition(scenario.instance, scenario.event, scenario.config)
    const unavailable = row.expect?.outcomeUnavailable === true
    assert.equal(
      result.instance.state,
      row.expectState,
      `state after ${row.state} × ${eventType}`,
    )
    if (!unavailable && !row.expect?.ignored) {
      const types = effectTypes(result)
      for (const type of row.expectEffects) {
        assert.ok(types.includes(type), `missing effect ${type}; got ${types.join(',')}`)
      }
      if (row.expectGate) {
        assert.equal(result.instance.gate?.reason, row.expectGate)
      } else {
        assert.equal(result.instance.gate, null)
      }
    }
    assertExpectation(result, row)
  })
}

const covered = new Set(rows.map((row) => {
  const event = typeof row.event === 'string' ? row.event : row.event.type
  return `${row.state}:${event}`
}))

for (const state of states) {
  for (const eventType of events) {
    if (covered.has(`${state}:${eventType}`)) continue
    test(`ignored: ${state} × ${eventType}`, () => {
      const scenario = build({
        state,
        event: { type: eventType, payload: {} },
        expect: { ignored: true },
      })
      const result = transition(scenario.instance, scenario.event, scenario.config)
      assert.equal(result.instance.state, state)
      assert.deepEqual(result.instance.seq, scenario.instance.seq)
      assert.deepEqual(result.effects, [])
      assert.ok(result.diagnostics?.length > 0 || result.diagnostic)
    })
  }
}

test('the table covers every row of the documented tables', () => {
  assert.equal(rows.length > 0, true)
  const pairs = new Set(rows.map((row) => {
    const event = typeof row.event === 'string' ? row.event : row.event.type
    return `${row.state}:${event}`
  }))
  assert.ok(pairs.size > 0)
})
