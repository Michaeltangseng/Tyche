const STORAGE_KEY = 'tyche.roomChatSeen.v1'

export function loadRoomChatSeen() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveRoomChatSeen(seen) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen))
  } catch {
    /* Local read state is best-effort. */
  }
}
