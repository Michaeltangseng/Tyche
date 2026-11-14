const test = require('node:test')
const assert = require('node:assert/strict')
const { createInvocationWatchdog } = require('../../src/runs/invocation-watchdog.cjs')

function fakeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true
    },
    advance(ms) {
      now += ms
      for (;;) {
        const due = timers.find(timer => !timer.cancelled && timer.at <= now)
        if (!due) break
        due.cancelled = true
        due.callback()
      }
    },
  }
}

test('remind mode emits reminders without rejecting the watchdog', async () => {
  const clock = fakeClock()
  const reminders = []
  const watchdog = createInvocationWatchdog({
    timeoutMs: 100,
    toolTimeoutMs: 200,
    mode: 'remind',
    onReminder: error => reminders.push(error.message),
    clock,
  })
  let rejected = false
  watchdog.promise.catch(() => { rejected = true })

  clock.advance(100)
  assert.equal(reminders.length, 1)
  assert.equal(rejected, false)
  clock.advance(100)
  assert.equal(reminders.length, 2)
  assert.equal(rejected, false)
  watchdog.close()
})

test('abort mode still rejects at the inactivity window', async () => {
  const clock = fakeClock()
  const watchdog = createInvocationWatchdog({
    timeoutMs: 100,
    toolTimeoutMs: 200,
    clock,
  })
  const rejection = watchdog.promise.catch(error => error.message)
  clock.advance(100)
  assert.equal(await rejection, 'LOCAL_AGENT_TIMEOUT')
  watchdog.close()
})

test('progress and tool activity refresh the remind window', () => {
  const clock = fakeClock()
  const reminders = []
  const watchdog = createInvocationWatchdog({
    timeoutMs: 100,
    toolTimeoutMs: 200,
    mode: 'remind',
    onReminder: () => reminders.push(clock.now()),
    clock,
  })
  clock.advance(60)
  watchdog.progress()
  clock.advance(60)
  assert.deepEqual(reminders, [])
  clock.advance(40)
  assert.deepEqual(reminders, [160])
  watchdog.close()
})
