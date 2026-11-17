const WAKE_BUDGET = 5

function memberIdentity(member) {
  if (typeof member === 'string') return { id: member, name: member }
  if (!member || typeof member !== 'object') return { id: String(member), name: String(member) }
  return { id: member.id, name: member.name ?? member.id }
}

function memberIds(members) {
  return (members ?? []).map(member => memberIdentity(member).id)
}

function resolveNamed(wanted, members, self) {
  const normalized = (members ?? []).map(memberIdentity)
  const ids = []
  const unknown = []
  for (const raw of wanted ?? []) {
    const want = String(raw)
    const target = normalized.find(member => member.id === raw
      || String(member.name).toLowerCase() === want.toLowerCase())
    if (!target) {
      unknown.push(raw)
      continue
    }
    if (self !== null && self !== undefined && target.id === self) continue
    if (!ids.includes(target.id)) ids.push(target.id)
  }
  return { ids, unknown }
}

function routeUserMessage({ kind, members, mentions, steward }) {
  const participants = memberIds(members)
  const named = resolveNamed(mentions ?? [], members ?? [], null).ids
  if (named.length > 0) return { targets: named, addSteward: false, named }

  if (kind === 'direct') {
    return { targets: participants.slice(0, 1), addSteward: false, named: [] }
  }
  if (steward) {
    return { targets: [steward], addSteward: !participants.includes(steward), named: [] }
  }
  if (participants.length === 1) return { targets: participants, addSteward: false, named: [] }
  return { targets: [], addSteward: false, named: [] }
}

function judgeMention(spent) {
  if (spent > WAKE_BUDGET) return 'capped'
  if (spent === WAKE_BUDGET) return 'wake_last'
  return 'wake'
}

module.exports = { WAKE_BUDGET, routeUserMessage, judgeMention, resolveNamed }
