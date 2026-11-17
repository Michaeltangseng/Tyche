function createSupervisor({ captainReview, startReplies = null, now = () => Date.now(), tickMs = 60_000, debounceMs = 150 }) {
  const timers = new Map()
  let interval = null

  function tick(chatId) {
    try {
      captainReview.review({ chatId })
      const delivered = captainReview.deliver({ chatId })
      if (startReplies && delivered.length > 0) {
        Promise.resolve(startReplies(chatId)).catch(() => { /* launch errors stay on the reply row */ })
      }
    } catch { /* supervisor retries on the next domain change or tick */ }
  }

  function requestTick(chatId = null) {
    const key = chatId ?? '*'
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(key)
      const ids = chatId ? [chatId] : captainReview.chatIds()
      for (const id of ids) tick(id)
    }, debounceMs)
    timer.unref?.()
    timers.set(key, timer)
  }

  return {
    requestTick,
    start() {
      if (interval) return
      interval = setInterval(() => {
        for (const chatId of captainReview.chatIds()) tick(chatId)
      }, tickMs)
      interval.unref?.()
    },
    stop() {
      if (interval) clearInterval(interval)
      interval = null
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

module.exports = { createSupervisor }
