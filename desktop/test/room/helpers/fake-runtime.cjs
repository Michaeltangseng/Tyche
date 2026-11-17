function createFakeRuntime({ deferCompletion = false } = {}) {
  const starts = []
  let pending = []

  function start(input) {
    starts.push(input)
    let resolveLaunch
    let rejectLaunch
    const launch = new Promise((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject })
    let resolveCompletion
    let rejectCompletion
    const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
    pending.push({ input, resolveLaunch, rejectLaunch, resolveCompletion, rejectCompletion })
    queueMicrotask(() => {
      resolveLaunch({ nativeSessionRef: `fake-native-${input.runId}` })
      if (!deferCompletion) {
        queueMicrotask(() => resolveCompletion({ status: 'done', text: '', thinking: '' }))
      }
    })
    return { launch, completion }
  }

  function finish(outcome) {
    for (const item of pending) item.resolveCompletion(outcome)
    pending = []
  }

  function fail(error) {
    for (const item of pending) item.rejectCompletion(error)
    pending = []
  }

  return { starts, start, finish, fail }
}

module.exports = { createFakeRuntime }
