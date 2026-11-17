import { computed, onScopeDispose, ref, watch } from 'vue'

/**
 * Renderer-side room domain adapter.
 *
 * The domain service is authoritative. This composable keeps the last
 * display-safe snapshot, paginates older messages, and sends narrow commands;
 * it never invents task, report, or review state.
 */
export function useRoomWorkspace({ api, pollMs = 5000 } = {}) {
  const rooms = ref([])
  const snapshot = ref(null)
  const roomId = ref('')
  const chatId = ref('')
  const busy = ref(false)
  const error = ref(false)
  const olderMessages = ref({})
  const olderMessagesAvailable = ref({})
  const loadingOlderMessages = ref(false)
  const liveRuns = ref({})
  const chatUsage = ref(null)
  const optimistic = ref([])
  let generation = 0
  let disposed = false
  let timer = null
  let changedTimer = null
  let refreshing = null
  let unsubscribeChanges = null
  let unsubscribeRuntimeEvents = null

  const chat = computed(() => snapshot.value?.chats.find(item => item.id === chatId.value) || null)
  const roomsById = computed(() => new Map(rooms.value.map(room => [room.id, room])))
  const tasks = computed(() => (snapshot.value?.tasks || []).filter(item => item.chat_id === chatId.value))
  const roles = computed(() => (snapshot.value?.roles || []).filter(item => item.chat_id === chatId.value))
  const captainAssignments = computed(() => (
    snapshot.value?.assignments || []
  ).filter(item => item.chat_id === chatId.value))
  const runs = computed(() => (
    snapshot.value?.runs || []
  ).filter(run => tasks.value.some(task => task.id === run.task_id)))
  const reports = computed(() => (
    snapshot.value?.reports || []
  ).filter(report => tasks.value.some(task => task.id === report.task_id)))
  const reviews = computed(() => (
    snapshot.value?.reviews || []
  ).filter(review => review.chat_id === chatId.value))
  const attentions = computed(() => (
    snapshot.value?.attentions || []
  ).filter(item => item.chat_id === chatId.value && item.status === 'open'))
  const artifacts = computed(() => snapshot.value?.artifacts || [])
  const messages = computed(() => {
    const current = (snapshot.value?.messages || []).filter(item => item.chat_id === chatId.value)
    const knownClientIds = new Set(current.map(item => item.client_id).filter(Boolean))
    const pending = optimistic.value.filter(item => (
      item.chat_id === chatId.value && !knownClientIds.has(item.client_id)
    ))
    const combined = [...(olderMessages.value[chatId.value] || []), ...current, ...pending]
    return [...new Map(combined.filter(item => !item.deleted_at).map(item => [item.id, item])).values()]
      .sort((left, right) => left.sequence - right.sequence)
  })
  const hasOlderMessages = computed(() => (
    olderMessagesAvailable.value[chatId.value]
      ?? Boolean(snapshot.value?.messages_have_older?.includes(chatId.value))
  ))
  const writeAuthorized = computed(() => snapshot.value?.room?.write_authorized === true)

  function schedule() {
    clearTimeout(timer)
    if (!disposed && roomId.value) timer = setTimeout(() => { void refresh() }, pollMs)
  }

  if (typeof api.onChanged === 'function') {
    unsubscribeChanges = api.onChanged(() => {
      if (disposed || !roomId.value) return
      clearTimeout(changedTimer)
      changedTimer = setTimeout(() => { void refresh({ afterCurrent: true }) }, 80)
    })
  }

  async function loadChatUsage() {
    if (disposed || !roomId.value || !chatId.value || typeof api.runtimeEvents !== 'function') return null
    try {
      const events = await api.runtimeEvents({
        roomId: roomId.value,
        chatId: chatId.value,
        limit: 500,
      })
      if (disposed) return null
      for (let index = (events || []).length - 1; index >= 0; index -= 1) {
        const payload = events[index]?.payload
        if (payload?.kind === 'usage' && payload.usage) {
          chatUsage.value = payload.usage
          return payload.usage
        }
      }
      return null
    } catch {
      return null
    }
  }

  watch(chatId, () => { void loadChatUsage() })

  function liveState(runId) {
    if (!liveRuns.value[runId]) {
      liveRuns.value = {
        ...liveRuns.value,
        [runId]: { text: '', reasoning: '', tools: [], usage: null, status: 'running', lastSeq: 0 },
      }
    }
    return liveRuns.value[runId]
  }

  function updateLive(runId, update) {
    liveRuns.value = {
      ...liveRuns.value,
      [runId]: { ...liveState(runId), ...update },
    }
  }

  function applyRuntimeEvent(payload) {
    if (disposed || !payload?.runId || payload.chatId !== chatId.value) return
    const event = payload.event || {}
    const current = liveState(payload.runId)
    if (Number.isInteger(event.seq) && event.seq < current.lastSeq) return
    const lastSeq = Number.isInteger(event.seq) ? event.seq : current.lastSeq
    if (event.kind === 'text_delta') {
      updateLive(payload.runId, { text: `${current.text}${event.text || ''}`.slice(-32 * 1024), lastSeq })
      return
    }
    if (event.kind === 'reasoning') {
      updateLive(payload.runId, {
        reasoning: `${current.reasoning}${event.text || ''}`.slice(-16 * 1024),
        lastSeq,
      })
      return
    }
    if (event.kind === 'tool_call_started' || event.kind === 'tool_call_input' || event.kind === 'tool_call_ended') {
      const callId = event.callId || event.toolName || `tool-${event.seq || current.tools.length}`
      const existing = current.tools.find(tool => tool.callId === callId)
      const next = {
        callId,
        name: event.toolName || existing?.name || 'tool',
        input: event.input ?? existing?.input ?? '',
        output: event.output ?? existing?.output ?? '',
        status: event.status || existing?.status || 'running',
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      }
      updateLive(payload.runId, {
        tools: existing
          ? current.tools.map(tool => (tool.callId === callId ? next : tool))
          : [...current.tools, next],
        lastSeq,
      })
      return
    }
    if (event.kind === 'usage' && event.usage) {
      updateLive(payload.runId, { usage: event.usage, lastSeq })
      chatUsage.value = event.usage
      return
    }
    if (event.kind === 'turn_ended' || event.kind === 'failure' || event.kind === 'exited') {
      updateLive(payload.runId, {
        status: event.kind === 'turn_ended' ? 'completed' : 'failed',
        lastSeq,
      })
    }
  }

  if (typeof api.onRuntimeEvent === 'function') {
    unsubscribeRuntimeEvents = api.onRuntimeEvent(applyRuntimeEvent)
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
        const data = await api.snapshot({ roomId: requestedRoom, includeCaptain: true })
        if (disposed || generation !== requestGeneration) return null
        snapshot.value = data
        if (!data.chats.some(item => item.id === chatId.value)) {
          chatId.value = data.room.primary_chat_id || data.chats[0]?.id || ''
        }
        error.value = false
        return data
      } catch {
        if (!disposed && generation === requestGeneration) error.value = true
        return null
      } finally {
        if (generation === requestGeneration && !disposed) {
          refreshing = null
          schedule()
        }
      }
    })()
    refreshing = { generation: requestGeneration, promise }
    return promise
  }

  async function openRoom(id, targetChatId = '') {
    generation++
    clearTimeout(timer)
    roomId.value = id
    snapshot.value = null
    olderMessages.value = {}
    olderMessagesAvailable.value = {}
    liveRuns.value = {}
    chatUsage.value = null
    optimistic.value = []
    chatId.value = targetChatId || ''
    error.value = false
    const data = await refresh()
    if (data && targetChatId && !data.chats.some(item => item.id === targetChatId)) {
      chatId.value = data.room.primary_chat_id || data.chats[0]?.id || ''
    }
    return data
  }

  async function load() {
    try {
      const data = await api.listRooms()
      if (disposed) return
      rooms.value = data
      if (!roomId.value && data[0]) await openRoom(data[0].id)
      else if (roomId.value && !data.some(room => room.id === roomId.value)) {
        roomId.value = ''
        chatId.value = ''
        snapshot.value = null
      }
    } catch {
      if (!disposed) error.value = true
    }
  }

  async function mutate(operation) {
    if (busy.value || disposed) return null
    busy.value = true
    error.value = false
    try {
      return await operation()
    } catch {
      if (!disposed) error.value = true
      return null
    } finally {
      busy.value = false
    }
  }

  async function createRoom(input) {
    return mutate(async () => {
      const result = await api.bootstrap(input)
      if (disposed) return result
      rooms.value = await api.listRooms()
      await openRoom(result.roomId, result.chatId)
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

  async function deleteChat(targetChatId) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.deleteChat({ roomId: targetRoom, chatId: targetChatId })
      if (!disposed && roomId.value === targetRoom) {
        await refresh({ afterCurrent: true })
        if (!disposed && chatId.value === targetChatId) {
          chatId.value = snapshot.value?.room?.primary_chat_id || snapshot.value?.chats?.[0]?.id || ''
        }
      }
      return result
    })
  }

  async function deleteRoom(targetRoomId = roomId.value) {
    return mutate(async () => {
      const result = await api.deleteRoom({ roomId: targetRoomId })
      if (disposed) return result
      rooms.value = await api.listRooms()
      if (roomId.value === targetRoomId) {
        const next = rooms.value[0]
        if (next) await openRoom(next.id)
        else {
          roomId.value = ''
          chatId.value = ''
          snapshot.value = null
        }
      }
      return result
    })
  }

  async function send(content, { clientId = crypto.randomUUID() } = {}) {
    if (busy.value || disposed) return null
    const targetRoom = roomId.value
    const targetChat = chatId.value
    const sequence = Number.MAX_SAFE_INTEGER
    optimistic.value = [...optimistic.value, {
      id: `optimistic:${clientId}`,
      client_id: clientId,
      chat_id: targetChat,
      sequence,
      revision: 1,
      audience: 'chat',
      author_type: 'user',
      author_id: 'user',
      author_name: 'user',
      kind: 'message',
      content,
      mentions: [],
      status: 'sending',
      data: null,
      created_at: new Date().toISOString(),
    }]
    busy.value = true
    error.value = false
    try {
      const result = await api.submitMessage({
        roomId: targetRoom,
        chatId: targetChat,
        content,
        clientId,
      })
      await refresh({ afterCurrent: true })
      return result
    } catch {
      if (!disposed) error.value = true
      return null
    } finally {
      optimistic.value = optimistic.value.filter(item => item.client_id !== clientId)
      if (!disposed) busy.value = false
    }
  }

  async function loadOlderMessages() {
    if (loadingOlderMessages.value || !hasOlderMessages.value || !messages.value.length
        || typeof api.chatMessages !== 'function') return null
    const targetRoom = roomId.value
    const targetChat = chatId.value
    const beforeSeq = Math.min(...messages.value.map(item => item.sequence))
    loadingOlderMessages.value = true
    try {
      const page = await api.chatMessages({
        roomId: targetRoom,
        chatId: targetChat,
        beforeSeq,
        limit: 100,
        includeCaptain: true,
      })
      if (disposed || roomId.value !== targetRoom || chatId.value !== targetChat) return null
      const merged = [...(olderMessages.value[targetChat] || []), ...(page.messages || [])]
      olderMessages.value = {
        ...olderMessages.value,
        [targetChat]: [...new Map(merged.map(item => [item.id, item])).values()],
      }
      olderMessagesAvailable.value = {
        ...olderMessagesAvailable.value,
        [targetChat]: Boolean(page.hasMore),
      }
      return page
    } catch {
      if (!disposed) error.value = true
      return null
    } finally {
      loadingOlderMessages.value = false
    }
  }

  async function acceptTask(taskId) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.acceptTask({
        roomId: targetRoom,
        taskId,
        commandId: crypto.randomUUID(),
      })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function stopReply(replyId) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.stopReply({ roomId: targetRoom, replyId })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function answerAttention(attentionId, resolution) {
    const targetRoom = roomId.value
    const targetChat = chatId.value
    return mutate(async () => {
      const result = await api.answerAttention({
        roomId: targetRoom,
        chatId: targetChat,
        attentionId,
        resolution,
        commandId: crypto.randomUUID(),
      })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function setWriteAuthorized(authorized) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.setWriteAuthorized({ roomId: targetRoom, authorized: authorized === true })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function createRole(input) {
    const targetRoom = roomId.value
    const targetChat = chatId.value
    return mutate(async () => {
      const result = await api.createRole({ roomId: targetRoom, chatId: targetChat, ...input })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function updateRole(roleId, input) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.updateRole({ roomId: targetRoom, roleId, ...input })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function deleteRole(roleId) {
    const targetRoom = roomId.value
    return mutate(async () => {
      const result = await api.deleteRole({ roomId: targetRoom, roleId })
      await refresh({ afterCurrent: true })
      return result
    })
  }

  async function runtimeEvents({ runId = null, limit = 500 } = {}) {
    const targetRoom = roomId.value
    const targetChat = chatId.value
    if (!targetRoom || !targetChat) return []
    return api.runtimeEvents({ roomId: targetRoom, chatId: targetChat, runId, limit })
  }

  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    clearTimeout(changedTimer)
    unsubscribeChanges?.()
    unsubscribeRuntimeEvents?.()
  })

  return {
    rooms,
    roomsById,
    snapshot,
    roomId,
    chatId,
    chat,
    tasks,
    roles,
    captainAssignments,
    runs,
    reports,
    reviews,
    attentions,
    artifacts,
    messages,
    liveRuns,
    chatUsage,
    hasOlderMessages,
    loadingOlderMessages,
    busy,
    error,
    writeAuthorized,
    load,
    refresh,
    openRoom,
    createRoom,
    createChat,
    deleteChat,
    deleteRoom,
    send,
    loadOlderMessages,
    acceptTask,
    stopReply,
    answerAttention,
    setWriteAuthorized,
    createRole,
    updateRole,
    deleteRole,
    runtimeEvents,
  }
}
