const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createProjectNotificationCoordinator,
  notificationBody,
} = require('../../src/project-room/project-notifications.cjs')

function coordinatorFixture(locale = 'zh') {
  let now = 0
  const timers = []
  const sent = []
  const coordinator = createProjectNotificationCoordinator({
    send: notification => sent.push(notification),
    now: () => now,
    setTimer: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { if (timer) timer.cancelled = true },
    locale: () => locale,
  })
  return {
    coordinator,
    sent,
    timers,
    advanceTo(value) { now = value },
  }
}

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

test('gate items are merged for 30 seconds and then notified once', () => {
  const { coordinator, sent, timers, advanceTo } = coordinatorFixture('zh')
  coordinator.update([item(), item({ itemId: 'gate-2', checkpointName: 'Design' })])
  assert.equal(sent.length, 0)
  assert.equal(timers.length, 1)

  advanceTo(30000)
  timers[0].callback()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].projectId, 'project-1')
  assert.match(sent[0].title, /项目室/)
  assert.match(sent[0].body, /Project One/)
  assert.match(sent[0].body, /需要你决定/)
  assert.match(sent[0].body, /2 项/)
  coordinator.stop()
})

test('viewing the project suppresses its notifications', () => {
  const { coordinator, sent, timers, advanceTo } = coordinatorFixture()
  coordinator.update([item()], { viewingProjectId: 'project-1' })
  assert.equal(timers.length, 0)
  advanceTo(30000)
  assert.equal(sent.length, 0)
})

test('notification bodies contain names and reasons but no comments or paths', () => {
  const body = notificationBody({
    projectId: 'project-1',
    projectName: 'Project One',
    checkpointNames: ['Requirements'],
    reasonKeys: ['projectRoom.notification.needs-human'],
    count: 1,
  }, 'zh')
  assert.match(body, /Requirements/)
  assert.match(body, /需要你决定/)
  assert.equal(body.includes('SECRET'), false)

  const english = notificationBody({
    projectId: 'project-1',
    projectName: 'Project One',
    checkpointNames: ['Requirements'],
    reasonKeys: ['projectRoom.notification.drift'],
    count: 1,
  }, 'en')
  assert.match(english, /diverged from the accepted version/)
})
