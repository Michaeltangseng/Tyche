import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTeamRoomNavigation } from '../../composables/useTeamRoomNavigation.js'

const cleanup = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })

function setup({ rooms = [], createChat } = {}) {
  let changed = null
  const activeView = ref('home')
  const roomApi = ref({
    listRooms: vi.fn(async () => structuredClone(rooms)),
    createChat: createChat || vi.fn(async ({ roomId, title }) => ({ roomId, chatId: 'created-chat', title })),
    onChanged: vi.fn(callback => {
      changed = callback
      return () => { if (changed === callback) changed = null }
    }),
  })
  const scope = effectScope()
  cleanup.push(() => scope.stop())
  const model = scope.run(() => useTeamRoomNavigation({
    roomApi,
    activeView,
    t: key => key === 'room.newChatTitle' ? 'New chat' : key,
    showError: vi.fn(),
  }))
  return { model, activeView, roomApi, emitChanged: () => changed?.() }
}

const sampleRooms = [{
  id: 'room-1',
  name: 'Alpha',
  primary_chat_id: 'chat-1',
  chats: [
    { id: 'chat-1', title: 'Team chat', is_primary: true },
    { id: 'chat-2', title: 'Research', is_primary: false },
  ],
}]

describe('team room navigation', () => {
  it('loads rooms and opens a room with its primary chat', async () => {
    const { model, activeView } = setup({ rooms: sampleRooms })
    await flushPromises()
    expect(model.rooms.value).toHaveLength(1)

    expect(model.openRoom('room-1')).toBe(true)
    expect(activeView.value).toBe('rooms')
    expect(model.activeRoomId.value).toBe('room-1')
    expect(model.activeChatId.value).toBe('chat-1')
    expect(model.isExpanded('room-1')).toBe(true)
    expect(model.openRequest.value).toMatchObject({ roomId: 'room-1', chatId: 'chat-1' })
  })

  it('toggles an expanded room and opens a collapsed room on row click', async () => {
    const { model } = setup({ rooms: sampleRooms })
    await flushPromises()
    const room = sampleRooms[0]

    model.handleRoomClick(room)
    expect(model.isExpanded('room-1')).toBe(true)
    expect(model.activeRoomId.value).toBe('room-1')

    model.handleRoomClick(room)
    expect(model.isExpanded('room-1')).toBe(false)

    model.handleRoomClick(room)
    expect(model.isExpanded('room-1')).toBe(true)
  })

  it('creates a uniquely named chat and requests it after loading', async () => {
    const createChat = vi.fn(async ({ roomId, title }) => ({ roomId, chatId: 'chat-3', title }))
    const { model } = setup({ rooms: sampleRooms, createChat })
    await flushPromises()

    const result = await model.addChat('room-1')
    expect(result).toMatchObject({ chatId: 'chat-3' })
    expect(createChat).toHaveBeenCalledWith({ roomId: 'room-1', title: 'New chat' })
    expect(model.openRequest.value).toMatchObject({ roomId: 'room-1', chatId: 'chat-3' })
  })

  it('renames a chat and reloads the room list', async () => {
    const renameChat = vi.fn(async ({ title }) => ({ title }))
    const { model, roomApi } = setup({ rooms: sampleRooms })
    roomApi.value.renameChat = renameChat
    await flushPromises()

    await model.renameChat('room-1', 'chat-2', 'Relay jokes')
    expect(renameChat).toHaveBeenCalledWith({ roomId: 'room-1', chatId: 'chat-2', title: 'Relay jokes' })
    expect(roomApi.value.listRooms).toHaveBeenCalledTimes(2)
  })

  it('syncs the active chat reported by the workspace without leaving the rooms view', async () => {
    const { model, activeView } = setup({ rooms: sampleRooms })
    await flushPromises()
    activeView.value = 'rooms'

    model.syncActive({ roomId: 'room-1', chatId: 'chat-2' })
    expect(model.activeRoomId.value).toBe('room-1')
    expect(model.activeChatId.value).toBe('chat-2')
    expect(model.isChatSelected('room-1', 'chat-2')).toBe(true)
  })
})
