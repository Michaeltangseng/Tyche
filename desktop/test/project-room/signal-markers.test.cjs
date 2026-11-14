const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CHECKPOINT_MARKER_PREFIX,
  REVIEW_MARKER_PREFIX,
  parseCheckpointSignal,
  parseReviewVerdict,
} = require('../../src/project-room/signal-markers.cjs')
const {
  createAnswerMarkerFilter,
} = require('../../src/collaboration/answer-marker-filter.cjs')

test('checkpoint signals are read only from the last non-empty line', () => {
  assert.equal(
    parseCheckpointSignal('Work done.\n[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]\n\n'),
    'ready',
  )
  assert.equal(
    parseCheckpointSignal('[[MELDWORK_CHECKPOINT:{"signal":"question"}]]'),
    'question',
  )
  assert.equal(
    parseCheckpointSignal('Before\n[[MELDWORK_CHECKPOINT:{"signal":"continue"}]]\nAfter'),
    null,
  )
  assert.equal(parseCheckpointSignal('[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]'), 'ready')
})

test('review verdicts are read only from the last non-empty line', () => {
  assert.equal(
    parseReviewVerdict('Review\n[[MELDWORK_REVIEW:{"verdict":"pass"}]]'),
    'pass',
  )
  assert.equal(
    parseReviewVerdict('Review\n[[MELDWORK_REVIEW:{"verdict":"revise"}]]'),
    'revise',
  )
  assert.equal(
    parseReviewVerdict('Review\n[[MELDWORK_REVIEW:{"verdict":"needs-human"}]]'),
    'needs-human',
  )
  assert.equal(
    parseReviewVerdict('[[MELDWORK_REVIEW:{"verdict":"pass"}]]\nTrailing answer'),
    null,
  )
})

test('malformed, extra, unknown, or wrong markers are missing', () => {
  const cases = [
    '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]',
    '[[MELDWORK_CHECKPOINT:not-json]]',
    '[[MELDWORK_CHECKPOINT:{"signal":"ready","extra":true}]]',
    '[[MELDWORK_CHECKPOINT:{"signal":"done"}]]',
    '[[MELDWORK_CHECKPOINT:{"verdict":"ready"}]]',
    '[[MELDWORK_REVIEW:{"verdict":"approve"}]]',
    '[[MELDWORK_REVIEW:{"verdict":"pass","reason":"x"}]]',
    '[[meldwork_checkpoint:{"signal":"ready"}]]',
    '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]] [[MELDWORK_CHECKPOINT:{"signal":"continue"}]]',
  ]
  for (const value of cases) {
    assert.equal(parseCheckpointSignal(value), null, value)
    assert.equal(parseReviewVerdict(value), null, value)
  }
})

test('the streaming filter hides project-room markers while keeping answer text', () => {
  const filter = createAnswerMarkerFilter({
    stopMarkers: [CHECKPOINT_MARKER_PREFIX, REVIEW_MARKER_PREFIX],
  })
  let visible = ''
  visible += filter.push('Answer ')
  visible += filter.push('[[MELDWORK_CHECK')
  visible += filter.push('POINT:{"signal":"ready"}]]')
  visible += filter.push(' trailing')
  assert.equal(visible, 'Answer ')
  assert.equal(filter.flush(), '')

  const text = createAnswerMarkerFilter({
    stopMarkers: [CHECKPOINT_MARKER_PREFIX, REVIEW_MARKER_PREFIX],
  })
  assert.equal(text.push('Complete answer'), 'Complete answer')
  assert.equal(text.push(' [[MELDWORK_RE'), ' ')
  assert.equal(text.push('VIEW:{"verdict":"pass"}]]'), '')
  assert.equal(text.flush(), '')
})

test('plain and receipt filtering behavior is unchanged', () => {
  const plain = createAnswerMarkerFilter()
  assert.equal(plain.push('Hello [[MELDWORK_CONSENSUS:agree]]'), 'Hello [[MELDWORK_CONSENSUS:agree]]')

  const consensus = createAnswerMarkerFilter({ mode: 'auto' })
  assert.equal(consensus.push('Hello [[MELDWORK_CONSENSUS:agree]]'), 'Hello ')
})
