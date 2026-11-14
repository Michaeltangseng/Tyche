const test = require('node:test')
const assert = require('node:assert/strict')
const { transition } = require('../../src/project-room/checkpoint-transitions.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)
const states = [
  'pending', 'checking', 'drafting', 'leading', 'submitted', 'reviewing',
  'gate', 'accepting', 'accepted', 'stale',
]

function mulberry32(seed) {
  let value = seed >>> 0
  return () => {
    value += 0x6D2B79F5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)]
}

function config(overrides = {}) {
  return {
    checkpoint: {
      key: 'requirements',
      name: 'Requirements',
      type: 'document',
      targetFiles: ['docs/requirements.md'],
      leadSeatId: 'seat-lead',
      reviewerSeatIds: ['seat-reviewer'],
      draftSeatIds: ['seat-draft'],
      gate: 'hard',
      roundLimit: 3,
      continuationLimit: 3,
      producesChecklist: false,
      dependsOn: [],
    },
    readExecSeatIds: [],
    softBlockers: {},
    ...overrides,
  }
}

function instance(overrides = {}) {
  return {
    id: 'cp-1',
    checkpointKey: 'requirements',
    state: 'pending',
    seq: 0,
    epoch: 0,
    round: 0,
    roundsSinceHuman: 0,
    continuations: 0,
    sessionGeneration: 0,
    candidate: null,
    rounds: [],
    roundsSummary: [],
    leaseRequests: [],
    activeInvocations: [],
    pendingStart: null,
    drafts: [],
    interjections: [],
    gate: null,
    blockedOn: null,
    effects: [],
    artifactVersions: [],
    readVersions: {},
    decisions: [],
    ...overrides,
  }
}

function invocation(random, current) {
  const role = pick(random, ['lead', 'draft', 'reviewer'])
  const seatId = role === 'lead' ? 'seat-lead' : (role === 'draft' ? 'seat-draft' : 'seat-reviewer')
  return {
    effectId: `inv-${Math.floor(random() * 1e6)}`,
    role,
    seatId,
    agentKind: 'codex',
    round: Math.max(1, current.round),
    sessionGeneration: current.sessionGeneration,
    claims: [],
    cancellationRequested: false,
    processRegistryId: null,
  }
}

function randomEvent(random, current) {
  const type = pick(random, [
    'DEPS_READY', 'INVOCATION_ENDED', 'EFFECT_RESULT', 'EFFECT_FAILED', 'RETRY_EFFECT',
    'GATE_DECIDED', 'REOPEN', 'INTERJECT', 'STOP_AND_DELIVER', 'UPSTREAM_REOPENED',
    'UPSTREAM_BLOCKERS_CHANGED', 'ACCEPTED_DOC_CHANGED', 'RESTORED', 'LEASE_GRANTED',
  ])
  const event = { type, at }
  if (type === 'INVOCATION_ENDED') {
    const invocationValue = current.activeInvocations.length && random() < 0.7
      ? pick(random, current.activeInvocations)
      : null
    const role = invocationValue?.role || pick(random, ['lead', 'draft', 'reviewer'])
    event.payload = {
      effectId: invocationValue?.effectId || 'missing-invocation',
      role,
      seatId: invocationValue?.seatId || (role === 'lead' ? 'seat-lead' : 'seat-reviewer'),
      round: Math.max(1, current.round),
      sessionGeneration: current.sessionGeneration,
      marker: pick(random, ['ready', 'question', 'continue', 'pass', 'revise', 'needs-human', undefined]),
      ...(random() < 0.1 ? { failed: { code: 'LOCAL_AGENT_EXIT' } } : {}),
      ...(random() < 0.1 ? { cancelled: true } : {}),
    }
  } else if (type === 'EFFECT_RESULT') {
    const effectType = pick(random, ['drift-check', 'evaluate-submission', 'verify-candidate', 'accept-commit'])
    event.payload = {
      type: effectType,
      result: effectType === 'drift-check'
        ? { clean: random() < 0.7 }
        : effectType === 'evaluate-submission'
          ? {
            bodyChanged: random() < 0.6,
            newResponse: random() < 0.4,
            manifestValid: random() < 0.9,
          }
          : effectType === 'verify-candidate'
            ? { intact: random() < 0.8 }
            : { commit },
    }
  } else if (type === 'GATE_DECIDED') {
    event.payload = {
      gateId: current.gate?.id || 'gate-missing',
      gateRevision: current.gate?.revision || 1,
      outcome: pick(random, ['continue', 'accept', 'reject-upstream']),
      candidateCommit: commit,
      comment: 'Decision.',
    }
  } else if (type === 'INTERJECT') {
    event.payload = { content: 'Interjection.' }
  } else if (type === 'ACCEPTED_DOC_CHANGED') {
    event.payload = {
      file: 'docs/requirements.md',
      critical: random() < 0.5,
      snapshot: commit,
    }
  } else if (type === 'LEASE_GRANTED') {
    event.payload = { requestId: current.leaseRequests[0]?.id || 'missing-request' }
  } else if (type === 'EFFECT_FAILED') {
    event.payload = { effectId: 'failed-effect', error: 'EIO' }
  } else if (type === 'RETRY_EFFECT' || type === 'RESTORED') {
    event.payload = { effectId: current.blockedOn?.effectId || 'failed-effect' }
  }
  return event
}

function assertInvariants(before, result, event, configuration) {
  const next = result.instance
  const ignored = result.diagnostics.some(diagnostic => (
    diagnostic.code === 'EVENT_IGNORED'
      || diagnostic.code === 'GATE_STALE'
      || diagnostic.code === 'GATE_OUTCOME_UNAVAILABLE'
  ))
  if (ignored) {
    assert.deepEqual(next, before, `ignored ${event.type} changed the instance`)
    assert.deepEqual(result.effects, [])
    return
  }
  assert.ok(states.includes(next.state), `invalid state ${next.state}`)
  assert.equal(next.seq, before.seq + 1)
  assert.equal(next.epoch >= before.epoch, true)
  assert.equal(next.sessionGeneration >= before.sessionGeneration, true)
  assert.equal(next.round >= before.round, true)
  assert.equal(next.roundsSinceHuman >= 0, true)
  assert.equal(next.continuations >= 0, true)

  assert.equal(next.gate === null || typeof next.gate === 'object', true)
  if (next.gate) {
    assert.equal(typeof next.gate.reason, 'string')
    assert.equal(next.gate.revision >= 1, true)
  }

  assert.equal(
    next.roundsSinceHuman <= configuration.checkpoint.roundLimit
      || next.state === 'gate',
    true,
    'roundsSinceHuman exceeded the limit outside a gate',
  )
  assert.equal(
    next.continuations <= configuration.checkpoint.continuationLimit
      || next.state === 'gate',
    true,
    'continuations exceeded the limit outside a gate',
  )

  const invocationIds = new Set()
  const leadActive = next.activeInvocations.some(item => item.role === 'lead')
  const draftActive = next.activeInvocations.some(item => item.role === 'draft')
  assert.equal(leadActive && draftActive, false, 'lead and draft ran together')
  for (const item of next.activeInvocations) {
    assert.equal(invocationIds.has(item.effectId), false, 'duplicate active invocation')
    invocationIds.add(item.effectId)
  }

  const rebuttalIndex = next.rounds.findIndex(round => round.rebuttal)
  if (rebuttalIndex >= 0) {
    assert.equal(rebuttalIndex, next.rounds.length - 1, 'a rebuttal round was followed by another round')
  }

  for (const effect of result.effects) {
    assert.equal(effect.id.startsWith(`${before.id}:`), true)
    assert.equal(effect.epoch, next.epoch)
    assert.equal(effect.status, 'pending')
  }
  const effectIds = new Set(result.effects.map(effect => effect.id))
  assert.equal(effectIds.size, result.effects.length, 'duplicate effect ids')

  const versions = new Set()
  for (const version of next.artifactVersions) {
    assert.equal(typeof version.commit, 'string')
    assert.ok(version.commit.length >= 40)
    assert.equal(versions.has(version.id), false, 'duplicate artifact version id')
    versions.add(version.id)
  }
}

test('random event sequences preserve the M2 invariants', () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    const random = mulberry32(seed)
    let current = instance({ state: 'pending' })
    const configuration = config()
    for (let step = 0; step < 40; step += 1) {
      const before = structuredClone(current)
      const event = randomEvent(random, current)
      let result
      try {
        result = transition(current, event, configuration)
      } catch (error) {
        error.message = `seed ${seed} step ${step}: ${error.message}`
        throw error
      }
      assertInvariants(before, result, event, configuration)
      current = result.instance
    }
  }
})

test('INVOCATION_ENDED for an unknown effect id is ignored', () => {
  const before = instance({
    state: 'reviewing',
    round: 1,
    rounds: [{
      round: 1,
      candidate: commit,
      rebuttal: false,
      bodyChanged: true,
      startedAt: at,
      reviews: [],
    }],
    activeInvocations: [{
      effectId: 'known-invocation',
      role: 'reviewer',
      seatId: 'seat-reviewer',
      agentKind: 'codex',
      round: 1,
      sessionGeneration: 0,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    }],
  })
  const event = {
    type: 'INVOCATION_ENDED',
    at,
    payload: {
      effectId: 'unknown-invocation',
      role: 'reviewer',
      seatId: 'seat-reviewer',
      round: 1,
      sessionGeneration: 0,
      marker: 'pass',
    },
  }
  const result = transition(before, event, config())
  assert.deepEqual(result.instance, before)
  assert.deepEqual(result.effects, [])
})
