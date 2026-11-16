import { computed, onScopeDispose, ref, watch } from 'vue'

function primaryChatId(room) {
  return room?.primary_chat_id
    || room?.chats?.find(chat => chat.is_primary)?.id
    || room?.chats?.[0]?.id
    || ''
}

export function useTeamRoomNavigation({ roomApi, activeView, t, showError = () => {} } = {}) {
  const rooms = ref([])
  const expandedRoomIds = ref([])
  const activeRoomId = ref('')
  const activeChatId = ref('')
  const openRequest = ref(null)
  const loading = ref(false)
  const error = ref(false)
  let requestGeneration = 0
  let reloadTimer = null
  let unsubscribe = null
  let disposed = false

  const available = computed(() => Boolean(roomApi?.value?.listRooms))

  function scheduleReload() {
    if (disposed) return
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => { void load().catch(() => {}) }, 200)
  }

  async function load() {
    const api = roomApi?.value
    if (!api?.listRooms) {
      rooms.value = []
      return rooms.value
    }
    loading.value = true
    try {
      const data = await api.listRooms()
      if (disposed) return rooms.value
      rooms.value = Array.isArray(data) ? data : []
      if (activeRoomId.value && !rooms.value.some(room => room.id === activeRoomId.value)) {
        activeRoomId.value = ''
        activeChatId.value = ''
      }
      error.value = false
      return rooms.value
    } catch (cause) {
      if (!disposed) error.value = true
      throw cause
    } finally {
      if (!disposed) loading.value = false
    }
  }

  function expand(roomId) {
    const id = String(roomId || '')
    if (!id || expandedRoomIds.value.includes(id)) return
    expandedRoomIds.value = [...expandedRoomIds.value, id]
  }

  function toggleExpanded(roomId) {
    const id = String(roomId || '')
    if (!id) return
    expandedRoomIds.value = expandedRoomIds.value.includes(id)
      ? expandedRoomIds.value.filter(item => item !== id)
      : [...expandedRoomIds.value, id]
  }

  function isExpanded(roomId) {
    return expandedRoomIds.value.includes(String(roomId || ''))
  }

  function requestOpen(roomId, chatId = '') {
    const id = String(roomId || '')
    if (!id) return false
    const room = rooms.value.find(item => item.id === id)
    const targetChat = String(chatId || primaryChatId(room))
    activeRoomId.value = id
    activeChatId.value = targetChat
    activeView.value = 'rooms'
    expand(id)
    openRequest.value = { roomId: id, chatId: targetChat, nonce: ++requestGeneration }
    return true
  }

  function openRoom(roomId, chatId = '') {
    const id = String(roomId || '')
    if (!id || !rooms.value.some(room => room.id === id)) return false
    return requestOpen(id, chatId)
  }

  function handleRoomClick(room) {
    const id = String(room?.id || '')
    if (!id) return
    if (isExpanded(id)) {
      toggleExpanded(id)
      return
    }
    openRoom(id)
  }

  function selectChat(roomId, chatId) {
    return requestOpen(String(roomId || ''), String(chatId || ''))
  }

  function isRoomSelected(roomId) {
    return activeView.value === 'rooms' && activeRoomId.value === String(roomId || '')
  }

  function isChatSelected(roomId, chatId) {
    return isRoomSelected(roomId) && activeChatId.value === String(chatId || '')
  }

  function nextChatTitle(room) {
    const base = t('room.newChatTitle')
    const titles = new Set((room?.chats || []).map(chat => chat.title))
    if (!titles.has(base)) return base
    let index = 2
    while (titles.has(`${base} ${index}`)) index += 1
    return `${base} ${index}`
  }

  async function addChat(roomId) {
    const api = roomApi?.value
    const id = String(roomId || '')
    if (!api?.createChat || !id) return null
    const room = rooms.value.find(item => item.id === id)
    try {
      const result = await api.createChat({ roomId: id, title: nextChatTitle(room) })
      await load()
      if (result?.chatId) requestOpen(id, result.chatId)
      return result
    } catch (cause) {
      showError(cause)
      return null
    }
  }

  async function deleteRoom(roomId) {
    const api = roomApi?.value
    const id = String(roomId || '')
    if (!api?.deleteRoom || !id) return null
    try {
      const result = await api.deleteRoom({ roomId: id })
      const wasActive = activeRoomId.value === id
      await load()
      if (wasActive) {
        const next = rooms.value[0]
        if (next) requestOpen(next.id)
        else {
          activeRoomId.value = ''
          activeChatId.value = ''
          openRequest.value = null
          activeView.value = 'home'
        }
      }
      return result
    } catch (cause) {
      showError(cause)
      return null
    }
  }

  async function deleteChat(roomId, chatId) {
    const api = roomApi?.value
    const id = String(roomId || '')
    const targetChat = String(chatId || '')
    if (!api?.deleteChat || !id || !targetChat) return null
    try {
      const result = await api.deleteChat({ roomId: id, chatId: targetChat })
      const wasActive = activeRoomId.value === id && activeChatId.value === targetChat
      await load()
      if (wasActive) {
        const room = rooms.value.find(item => item.id === id)
        if (room) requestOpen(id, result?.promotedChatId || primaryChatId(room))
        else if (rooms.value[0]) requestOpen(rooms.value[0].id)
        else {
          activeRoomId.value = ''
          activeChatId.value = ''
          openRequest.value = null
          activeView.value = 'home'
        }
      }
      return result
    } catch (cause) {
      showError(cause)
      return null
    }
  }

  function syncActive(payload = {}) {
    const roomId = String(payload.roomId || '')
    if (!roomId) return
    if (roomId !== activeRoomId.value) expand(roomId)
    activeRoomId.value = roomId
    activeChatId.value = String(payload.chatId || '')
  }

  function openWorkspace() {
    activeView.value = 'rooms'
    if (activeRoomId.value) {
      openRequest.value = {
        roomId: activeRoomId.value,
        chatId: activeChatId.value,
        nonce: ++requestGeneration,
      }
    }
  }

  function openCreate() {
    activeView.value = 'rooms'
    if (activeRoomId.value) {
      openRequest.value = {
        roomId: activeRoomId.value,
        chatId: activeChatId.value,
        nonce: ++requestGeneration,
      }
    }
  }

  watch(activeView, view => {
    if (view === 'rooms') void load().catch(() => {})
  })

  watch(roomApi, (api, _previous, onCleanup) => {
    unsubscribe?.()
    unsubscribe = null
    if (!api) {
      rooms.value = []
      return
    }
    unsubscribe = api.onChanged?.(() => scheduleReload()) || null
    onCleanup(() => { unsubscribe?.(); unsubscribe = null })
    void load().catch(() => {})
  }, { immediate: true })

  onScopeDispose(() => {
    disposed = true
    clearTimeout(reloadTimer)
    unsubscribe?.()
  })

  return {
    rooms,
    activeRoomId,
    activeChatId,
    openRequest,
    loading,
    error,
    available,
    load,
    openRoom,
    openWorkspace,
    openCreate,
    handleRoomClick,
    selectChat,
    addChat,
    deleteRoom,
    deleteChat,
    syncActive,
    isRoomSelected,
    isChatSelected,
    isExpanded,
    toggleExpanded,
  }
}
