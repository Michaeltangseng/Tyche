const assert = require('node:assert/strict')
const test = require('node:test')
const { briefing } = require('../../src/room/briefing.cjs')

const row = (seq, extra = {}) => ({ id: `m${seq}`, seq, authorType: 'agent', authorId: 'a', status: 'done', content: `c${seq}`, audience: 'chat', data: {}, ...extra })

test('includes unseen completed rows, skips own and in-flight, and blocks the watermark', () => {
  const trigger = row(4, { authorType: 'user', authorId: 'user', content: 'trigger' })
  const result = briefing({ chatTitle: 'C', me: 'a', lastSeq: 0, trigger, nameOf: m => m.authorId,
    rows: [row(1, { authorId: 'b' }), row(2, { authorId: 'a' }), row(3, { authorId: 'b', status: 'working' }), trigger] })
  assert.equal(result.text.includes('c1'), true)
  assert.equal(result.text.includes('c2'), false)
  assert.equal(result.text.includes('trigger'), true)
  assert.equal(result.seen, 2)
  assert.equal(result.omittedSeqs.includes(3), true)
})

test('hides captain-only rows from non-captains and keeps them for the captain', () => {
  const trigger = row(2, { authorType: 'system', authorId: 'system', kind: 'captain_review', content: 'review', audience: 'captain' })
  const hidden = briefing({ chatTitle: 'C', me: 'a', lastSeq: 0, trigger, nameOf: m => m.authorId, rows: [row(1), trigger] })
  const shown = briefing({ chatTitle: 'C', me: 'captain', lastSeq: 0, trigger, nameOf: m => m.authorId, viewerIsCaptain: true, rows: [row(1), trigger] })
  assert.equal(hidden.text.includes('review'), false)
  assert.equal(shown.text.includes('review'), true)
})
