import { computed, onScopeDispose, ref } from 'vue'
import {
  PROJECT_ROOM_METHODS,
  errorCode,
  projectRoomApi,
  projectRoomErrorKey,
} from '../desktop.js'

const ACTION_METHODS = PROJECT_ROOM_METHODS.filter(method => method !== 'snapshot')
const MAX_STALE_RETRIES = 3

export function useProjectRoom({ api = null, onError = null } = {}) {
  const activeProjectId = ref('')
  const project = ref(null)
  const loading = ref(false)
  const errorKey = ref('')
  const revision = ref(-1)
  const pendingRevision = ref(-1)
  const isOpen = computed(() => Boolean(activeProjectId.value))

  let generation = 0
  let refreshPromise = null
  let refreshAgain = false
  let subscribedApi = null
  let unsubscribe = null

  function resolveApi() {
    return api || projectRoomApi()
  }

  function recordError(error) {
    errorKey.value = projectRoomErrorKey(errorCode(error))
    if (typeof onError === 'function') onError(error)
  }

  function handleChanged(payload) {
    const projectId = String(payload?.projectId || '')
    if (!projectId || projectId !== activeProjectId.value) return
    const nextRevision = Number(payload?.revision)
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) return
    if (nextRevision <= revision.value) return
    pendingRevision.value = Math.max(pendingRevision.value, nextRevision)
    void refresh()
  }

  function ensureSubscription() {
    const bridge = resolveApi()
    if (!bridge || subscribedApi === bridge) return
    if (typeof unsubscribe === 'function') unsubscribe()
    subscribedApi = bridge
    unsubscribe = typeof bridge.onChanged === 'function'
      ? bridge.onChanged(handleChanged) || null
      : null
  }

  async function performRefresh() {
    const bridge = resolveApi()
    const projectId = activeProjectId.value
    if (!bridge || !projectId) return null
    const requestGeneration = generation
    const requestedRevision = pendingRevision.value
    try {
      const snapshot = await bridge.snapshot({ projectId })
      if (requestGeneration !== generation || projectId !== activeProjectId.value) return null
      const snapshotRevision = Number(snapshot?.revision)
      if (Number.isSafeInteger(requestedRevision) && requestedRevision >= 0
          && Number.isSafeInteger(snapshotRevision) && snapshotRevision < requestedRevision) {
        refreshAgain = true
        return null
      }
      project.value = snapshot
      if (Number.isSafeInteger(snapshotRevision)) revision.value = snapshotRevision
      errorKey.value = ''
      return snapshot
    } catch (error) {
      if (requestGeneration === generation && projectId === activeProjectId.value) {
        recordError(error)
      }
      return null
    }
  }

  function refresh() {
    if (!resolveApi() || !activeProjectId.value) return Promise.resolve(null)
    if (refreshPromise) {
      refreshAgain = true
      return refreshPromise
    }
    loading.value = true
    refreshPromise = (async () => {
      let result = null
      let staleRetries = 0
      do {
        refreshAgain = false
        result = await performRefresh()
        if (refreshAgain) {
          staleRetries += 1
          if (staleRetries >= MAX_STALE_RETRIES) refreshAgain = false
        } else {
          staleRetries = 0
        }
      } while (refreshAgain && activeProjectId.value)
      return result
    })().finally(() => {
      loading.value = false
      refreshPromise = null
    })
    return refreshPromise
  }

  function open(projectId) {
    const id = String(projectId || '')
    if (!id) return close()
    if (activeProjectId.value !== id) {
      generation += 1
      activeProjectId.value = id
      project.value = null
      revision.value = -1
      pendingRevision.value = -1
      errorKey.value = ''
    }
    ensureSubscription()
    return refresh()
  }

  function close() {
    generation += 1
    activeProjectId.value = ''
    project.value = null
    revision.value = -1
    pendingRevision.value = -1
    errorKey.value = ''
    loading.value = false
    refreshAgain = false
  }

  const actions = {}
  for (const method of ACTION_METHODS) {
    actions[method] = async (...args) => {
      const bridge = resolveApi()
      if (!bridge || typeof bridge[method] !== 'function') {
        recordError(new Error('project-room-api-unavailable'))
        throw new Error('project-room-api-unavailable')
      }
      try {
        return await bridge[method](...args)
      } catch (error) {
        recordError(error)
        throw error
      }
    }
  }

  onScopeDispose(() => {
    generation += 1
    if (typeof unsubscribe === 'function') unsubscribe()
    unsubscribe = null
    subscribedApi = null
  })

  return {
    activeProjectId,
    project,
    loading,
    errorKey,
    revision,
    isOpen,
    open,
    close,
    refresh,
    ...actions,
  }
}
