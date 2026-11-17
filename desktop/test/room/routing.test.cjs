const assert = require('node:assert/strict')
const test = require('node:test')
const { routeUserMessage, judgeMention, resolveNamed } = require('../../src/room/routing.cjs')

test('routes named members, then steward, then a single member', () => {
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: ['b'], steward: 'a' }).targets, ['b'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: [], steward: 'a' }).targets, ['a'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a'], mentions: [], steward: null }).targets, ['a'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: [], steward: null }).targets, [])
})

test('caps mention wakes at five', () => {
  assert.equal(judgeMention(1), 'wake')
  assert.equal(judgeMention(5), 'wake_last')
  assert.equal(judgeMention(6), 'capped')
})

test('resolves names case-insensitively and excludes self', () => {
  const members = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
  assert.deepEqual(resolveNamed(['alice', 'nobody'], members, '2'), { ids: ['1'], unknown: ['nobody'] })
})
