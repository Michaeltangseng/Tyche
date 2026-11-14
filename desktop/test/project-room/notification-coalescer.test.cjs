const test = require('node:test')
const assert = require('node:assert/strict')
const { coalesceNotifications } = require('../../src/project-room/notification-coalescer.cjs')

function item(overrides = {}) {
  return {
    type: 'gate',
    projectId: 'project-1',
    projectName: 'Project One',
    checkpointId: 'cp-1',
    checkpointName: 'Requirements',
    reason: 'needs-human',
    itemId: 'gate-1',
    ...overrides,
  }
}

test('new items wait for the merge window and then become one notification', () => {
  const first = coalesceNotifications({
    previousItems: [],
    nextItems: [item()],
    now: 1000,
  })
  assert.deepEqual(first.notifications, [])
  assert.equal(first.pending.length, 1)
  assert.equal(first.nextAt, 31000)

  const early = coalesceNotifications({
    previousItems: [],
    nextItems: [item()],
    now: 30999,
    pending: first.pending,
  })
  assert.deepEqual(early.notifications, [])

  const emitted = coalesceNotifications({
    previousItems: [],
    nextItems: [item()],
    now: 31000,
    pending: first.pending,
  })
  assert.deepEqual(emitted.notifications, [{
    projectId: 'project-1',
    projectName: 'Project One',
    checkpointNames: ['Requirements'],
    reasonKeys: ['projectRoom.notification.needs-human'],
    count: 1,
    at: 31000,
  }])
  assert.deepEqual(emitted.pending, [])
  assert.equal(emitted.nextAt, null)
})

test('items in the window merge into one notification with a count', () => {
  const first = coalesceNotifications({
    previousItems: [],
    nextItems: [item()],
    now: 1000,
  })
  const second = coalesceNotifications({
    previousItems: [],
    nextItems: [
      item(),
      item({ type: 'drift', itemId: 'drift-1', reason: 'drift', checkpointName: '' }),
    ],
    now: 2000,
    pending: first.pending,
  })
  assert.deepEqual(second.notifications, [])
  assert.equal(second.pending[0].items.length, 2)

  const emitted = coalesceNotifications({
    previousItems: [],
    nextItems: [],
    now: 31000,
    pending: second.pending,
  })
  assert.equal(emitted.notifications.length, 1)
  assert.equal(emitted.notifications[0].count, 2)
  assert.deepEqual(emitted.notifications[0].reasonKeys, [
    'projectRoom.notification.needs-human',
    'projectRoom.notification.drift',
  ])
})

test('items already present in the previous projection are not re-notified', () => {
  const result = coalesceNotifications({
    previousItems: [item()],
    nextItems: [item()],
    now: 1000,
  })
  assert.deepEqual(result.notifications, [])
  assert.deepEqual(result.pending, [])
})

test('viewing a project suppresses and clears its notifications', () => {
  const first = coalesceNotifications({
    previousItems: [],
    nextItems: [item(), item({ projectId: 'project-2', itemId: 'gate-2' })],
    now: 1000,
  })
  assert.equal(first.pending.length, 2)

  const viewed = coalesceNotifications({
    previousItems: [],
    nextItems: [item()],
    now: 2000,
    viewingProjectId: 'project-1',
    pending: first.pending,
  })
  assert.equal(viewed.pending.some(buffer => buffer.projectId === 'project-1'), false)
  assert.equal(viewed.pending.some(buffer => buffer.projectId === 'project-2'), true)
})

test('notification payloads contain only names and localization keys', () => {
  const result = coalesceNotifications({
    previousItems: [],
    nextItems: [item({ comment: 'SECRET COMMENT', path: '/secret/path' })],
    now: 1000,
  })
  const emitted = coalesceNotifications({
    previousItems: [],
    nextItems: [],
    now: 31000,
    pending: result.pending,
  })
  const text = JSON.stringify(emitted.notifications)
  assert.equal(text.includes('SECRET'), false)
  assert.equal(text.includes('/secret/path'), false)
  assert.equal(text.includes('comment'), false)
})
