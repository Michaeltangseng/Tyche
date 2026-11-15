function createEffectPump({ runNext, onError = error => console.error('[room-effects]', error) } = {}) {
  if (typeof runNext !== 'function') throw new TypeError('ROOM_EFFECT_PUMP_EXECUTOR_REQUIRED')
  let running = null
  let requested = false
  let closed = false
  const abort = new AbortController()

  function request() {
    if (closed) return Promise.resolve()
    requested = true
    if (running) return running
    running = Promise.resolve().then(async () => {
      while (requested && !closed) {
        requested = false
        let result
        do {
          if (closed) break
          result = await runNext({ signal: abort.signal })
          if (result?.error) onError(result.error)
        } while (result && !closed)
      }
    }).catch(onError).finally(() => {
      running = null
      if (requested && !closed) request()
    })
    return running
  }

  async function close() {
    closed = true
    abort.abort()
    await running
  }

  return { request, close }
}

module.exports = { createEffectPump }
