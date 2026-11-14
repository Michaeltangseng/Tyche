import { computed, onScopeDispose, ref } from 'vue'
import { desktopApi } from '../desktop.js'

function mergeSteps(existing, incoming) {
  const bySeq = new Map()
  for (const step of [...existing, ...incoming]) {
    if (!step || !Number.isSafeInteger(step.seq)) continue
    bySeq.set(step.seq, step)
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

export function useTraceStream({
  runId,
  agentRunId,
  api = null,
  pageSize = 100,
} = {}) {
  const traceApi = api || desktopApi()?.trace || null
  const steps = ref([])
  const status = ref(null)
  const loading = ref(false)
  const error = ref('')
  const hasMore = ref(false)
  const viewing = ref(false)
  const atBottom = ref(true)
  let cursor = null
  let unsubscribe = null
  let requestToken = 0

  const runKey = computed(() => `${runId?.value || ''}:${agentRunId?.value || ''}`)
  const hasFullTrace = computed(() => (status.value?.lastSeq || 0) > 0)
  const incomplete = computed(() => status.value?.incomplete === true)
  const complete = computed(() => status.value?.complete === true)

  function subscribe() {
    if (unsubscribe || !traceApi || typeof traceApi.onAppended !== 'function') return
    unsubscribe = traceApi.onAppended((payload) => {
      if (!viewing.value || !atBottom.value) return
      if (String(payload?.runId || '') !== String(runId?.value || '')) return
      if (String(payload?.agentRunId || '') !== String(agentRunId?.value || '')) return
      void refreshLatest()
    }) || null
  }

  function unsubscribeAppended() {
    if (typeof unsubscribe === 'function') unsubscribe()
    unsubscribe = null
  }

  async function open() {
    if (!traceApi || !runId?.value || !agentRunId?.value) return
    const token = ++requestToken
    loading.value = true
    error.value = ''
    try {
      const [page, nextStatus] = await Promise.all([
        traceApi.page({
          runId: runId.value,
          agentRunId: agentRunId.value,
          direction: 'backward',
          limit: pageSize,
        }),
        traceApi.status({ runId: runId.value, agentRunId: agentRunId.value }),
      ])
      if (token !== requestToken) return
      steps.value = mergeSteps([], page.steps || [])
      cursor = page.cursor || null
      hasMore.value = page.hasMore === true
      status.value = nextStatus || null
      subscribe()
    } catch (cause) {
      if (token === requestToken) error.value = String(cause?.message || cause || 'TRACE_LOAD_FAILED')
    } finally {
      if (token === requestToken) loading.value = false
    }
  }

  async function loadOlder() {
    if (!traceApi || !hasMore.value || !cursor) return
    loading.value = true
    try {
      const page = await traceApi.page({
        runId: runId.value,
        agentRunId: agentRunId.value,
        cursor,
        direction: 'backward',
        limit: pageSize,
      })
      steps.value = mergeSteps(page.steps || [], steps.value)
      cursor = page.cursor || null
      hasMore.value = page.hasMore === true
    } catch (cause) {
      error.value = String(cause?.message || cause || 'TRACE_LOAD_FAILED')
    } finally {
      loading.value = false
    }
  }

  async function refreshLatest() {
    if (!traceApi || !runId?.value || !agentRunId?.value) return
    try {
      const [page, nextStatus] = await Promise.all([
        traceApi.page({
          runId: runId.value,
          agentRunId: agentRunId.value,
          direction: 'backward',
          limit: pageSize,
        }),
        traceApi.status({ runId: runId.value, agentRunId: agentRunId.value }),
      ])
      steps.value = mergeSteps(steps.value, page.steps || [])
      status.value = nextStatus || status.value
    } catch { /* appended notifications are best effort */ }
  }

  async function loadBlob(blobId, { offset = 0, length = 256 * 1024 } = {}) {
    if (!traceApi || !runId?.value || !agentRunId?.value) return null
    return traceApi.blob({
      runId: runId.value,
      agentRunId: agentRunId.value,
      blobId,
      offset,
      length,
    })
  }

  function setViewing(value) {
    viewing.value = value === true
    if (viewing.value) {
      subscribe()
      if (atBottom.value) void refreshLatest()
    } else {
      unsubscribeAppended()
    }
  }

  function setAtBottom(value) {
    atBottom.value = value === true
  }

  onScopeDispose(unsubscribeAppended)

  return {
    atBottom,
    complete,
    error,
    hasFullTrace,
    hasMore,
    incomplete,
    loadBlob,
    loadOlder,
    loading,
    open,
    refreshLatest,
    runKey,
    setAtBottom,
    setViewing,
    status,
    steps,
    viewing,
  }
}
