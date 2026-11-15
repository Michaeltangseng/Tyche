import { computed, onScopeDispose, ref } from 'vue'

export function useRoomWorkspace({ api, pollMs = 1500 } = {}) {
  const rooms = ref([])
  const snapshot = ref(null)
  const roomId = ref('')
  const chatId = ref('')
  const busy = ref(false)
  const error = ref(false)
  const staleAssignments = ref([])
  let generation = 0
  let disposed = false
  let timer = null
  let refreshing = null
  const chat = computed(() => snapshot.value?.chats.find(item => item.id === chatId.value) || null)
  const tasks = computed(() => (snapshot.value?.tasks || []).filter(item => item.chat_id === chatId.value))
  const assignments = computed(() => (snapshot.value?.assignments || []).filter(item => tasks.value.some(task => task.id === item.task_id)))
  const roles = computed(() => (snapshot.value?.roles || []).filter(item => item.chat_id === chatId.value))
  const messages = computed(() => (snapshot.value?.messages || []).filter(item => item.chat_id === chatId.value && !item.deleted_at))
  const reports = computed(() => (snapshot.value?.reports || []).filter(item => tasks.value.some(task => task.id === item.task_id)))
  const attentions = computed(() => (snapshot.value?.attentions || []).filter(item => item.chat_id === chatId.value && item.status === 'open'))

  function schedule() {
    clearTimeout(timer)
    if (!disposed && roomId.value) timer = setTimeout(() => { void refresh() }, pollMs)
  }

  async function refresh({ afterCurrent = false } = {}) {
    if (disposed || !roomId.value) return null
    if (refreshing?.generation === generation) {
      if (!afterCurrent) return refreshing.promise
      const expectedGeneration = generation
      await refreshing.promise
      if (disposed || generation !== expectedGeneration) return null
      return refresh()
    }
    clearTimeout(timer)
    const requestGeneration = generation
    const requestedRoom = roomId.value
    const promise = (async () => {
      try {
        const data = await api.snapshot({ roomId: requestedRoom })
        if (disposed || generation !== requestGeneration) return null
        snapshot.value = data
        if (typeof api.listStaleAssignments === 'function') {
          try {
            const stale = await api.listStaleAssignments({ roomId: requestedRoom, timeoutMs: 120_000 }) || []
            if (disposed || generation !== requestGeneration || roomId.value !== requestedRoom) return null
            staleAssignments.value = stale
          }
          catch { if (!disposed && generation === requestGeneration && roomId.value === requestedRoom) staleAssignments.value = [] }
        } else staleAssignments.value = []
        if (!data.chats.some(item => item.id === chatId.value)) chatId.value = data.room.primary_chat_id || data.chats[0]?.id || ''
        error.value = false
        return data
      } catch {
        if (!disposed && generation === requestGeneration) error.value = true
        return null
      } finally {
        if (generation === requestGeneration && !disposed) { refreshing = null; schedule() }
      }
    })()
    refreshing = { generation: requestGeneration, promise }
    return promise
  }

  async function openRoom(id) {
    generation++
    clearTimeout(timer)
    roomId.value = id
    snapshot.value = null
    staleAssignments.value = []
    chatId.value = ''
    error.value = false
    return refresh()
  }

  async function load() {
    try {
      const data = await api.listRooms()
      if (disposed) return
      rooms.value = data
      if (!roomId.value && data[0]) await openRoom(data[0].id)
    } catch { if (!disposed) error.value = true }
  }

  async function mutate(operation) {
    if (busy.value || disposed) return null
    busy.value = true
    error.value = false
    try { return await operation() } catch { if (!disposed) error.value = true; return null }
    finally { busy.value = false }
  }

  async function createRoom(input) {
    return mutate(async () => {
      const result = await api.bootstrap(input)
      if (disposed) return result
      rooms.value = await api.listRooms()
      await openRoom(result.roomId)
      return result
    })
  }

  async function createChat(title) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.createChat({ roomId: targetRoom, title })
      if (!disposed && roomId.value === targetRoom) {
        await refresh({ afterCurrent: true })
        if (!disposed && roomId.value === targetRoom) chatId.value = result.chatId
      }
      return result
    })
  }

  async function send(content) {
    const targetChat = chatId.value
    return mutate(async () => {
      const result = await api.submitMessage({ chatId: targetChat, content })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function command(input) {
    const targetChat = chatId.value
    return mutate(async () => {
      const commandId = crypto.randomUUID()
      const payload = { ...input, chatId: targetChat }
      if (['set_workspace_write', 'stop_task', 'retry_task', 'handoff_task', 'update_role_prompt'].includes(input.type)) payload.commandId = commandId
      const result = await api.applyUserCommand(payload)
      await refresh({ afterCurrent: true })
      return result
    })
  }

  onScopeDispose(() => { disposed = true; generation++; clearTimeout(timer) })
  return { rooms, snapshot, roomId, chatId, chat, tasks, assignments, roles, messages, reports, attentions, staleAssignments,
    busy, error, load, refresh, openRoom, createRoom, createChat, send, command }
}
