import { roleFace } from './room-mascots.js'

export function chatActivityTime(chat) {
  const value = Date.parse(chat?.activity?.created_at || chat?.updated_at || chat?.created_at || '')
  return Number.isFinite(value) ? value : 0
}

export function chatMemberFaces(chat, limit = 3) {
  const members = Array.isArray(chat?.members) ? chat.members : []
  const captain = members.find(member => member.is_captain)
  const rest = members.filter(member => member !== captain)
    .sort((left, right) => (Number(right?.last_seq) || 0) - (Number(left?.last_seq) || 0))
  const visible = (captain ? [captain, ...rest] : rest).slice(0, limit)
  const faces = visible.length ? visible : [{ id: chat?.id || 'chat' }]
  return faces.map(member => {
    const key = member.id || `${member.provider || ''}:${member.name || ''}`
    return { key, mascot: roleFace(member.id ? member : { id: key }) }
  })
}

export function recentRoomChats(rooms) {
  const rows = (Array.isArray(rooms) ? rooms : []).flatMap(room => (
    (Array.isArray(room?.chats) ? room.chats : []).map(chat => ({ room, chat }))
  ))
  return rows.sort((left, right) => chatActivityTime(right.chat) - chatActivityTime(left.chat))
}
