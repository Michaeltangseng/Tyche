const crypto = require('node:crypto')

const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const MASCOT_IDS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']

function hashedMascotId(key) {
  let hash = 0
  const text = String(key || '')
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return MASCOT_IDS[hash % MASCOT_IDS.length]
}

function shownFace(role) {
  return MASCOT_IDS.includes(role?.portrait) ? role.portrait : hashedMascotId(role?.id || role?.display_name || role?.provider)
}

function takePortrait(used) {
  const free = MASCOT_IDS.find(id => !(used.get(id) > 0))
  const pick = free || MASCOT_IDS.reduce((least, id) => (
    (used.get(id) || 0) < (used.get(least) || 0) ? id : least
  ), MASCOT_IDS[0])
  used.set(pick, (used.get(pick) || 0) + 1)
  return pick
}

function maxNativePermission(provider) {
  if (provider === 'claude') return 'bypassPermissions'
  if (provider === 'codex') return 'danger-full-access'
  return 'default'
}

function cleanName(value) {
  if (typeof value !== 'string') throw new Error('ROOM_ROLE_NAME_REQUIRED')
  const text = value.trim()
  if (!text || text.length > 120 || text.includes('\u0000')) throw new Error('ROOM_ROLE_NAME_REQUIRED')
  return text
}

function cleanPrompt(value) {
  if (typeof value !== 'string') throw new Error('ROOM_ROLE_PROMPT_REQUIRED')
  const text = value.trim()
  if (!text || text.length > 100_000 || text.includes('\u0000')) throw new Error('ROOM_ROLE_PROMPT_REQUIRED')
  return text
}

function cleanResponsibilities(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 4000 || value.includes('\u0000')) {
    throw new Error('ROOM_ROLE_RESPONSIBILITIES_INVALID')
  }
  return value
}

function createCaptainAssignment({
  roomDb, repository, timeline, review, queueReply, requestTick,
  canLaunch = null, onUnavailable = null,
}) {
  const { database } = roomDb

  function requireCaptain(chatId, captainRoleId) {
    const role = repository.getRole(captainRoleId)
    if (!role || !role.isCaptain || role.chatId !== chatId) throw new Error('ROOM_CAPTAIN_REQUIRED')
    return role
  }

  function resolveTargets(chatId, captainRoleId, roleIds) {
    const requested = Array.isArray(roleIds) ? roleIds.filter(Boolean) : []
    if (requested.includes(captainRoleId)) throw new Error('ROOM_CAPTAIN_SELF_TARGET')
    let targets = requested
    if (targets.length === 0) {
      const candidates = repository.listParticipants(chatId).filter(participant => !participant.isCaptain)
      if (candidates.length !== 1) throw new Error('ROOM_CAPTAIN_TARGET_REQUIRED')
      targets = [candidates[0].roleId]
    }
    const unavailable = []
    for (const roleId of targets) {
      const role = repository.getRole(roleId)
      if (!role || role.chatId !== chatId || role.status !== 'active') throw new Error('ROOM_CAPTAIN_TARGET_INVALID')
      if (role.isCaptain) throw new Error('ROOM_CAPTAIN_SELF_TARGET')
      if (typeof canLaunch === 'function' && canLaunch(role.provider) === false) {
        unavailable.push(role)
      }
    }
    if (unavailable.length > 0) {
      if (typeof onUnavailable === 'function') {
        onUnavailable({ chatId, roles: unavailable, requestedBy: captainRoleId })
      }
      throw new Error(`ROOM_CAPTAIN_TARGET_UNAVAILABLE: ${unavailable.map(role => role.displayName || role.id).join(', ')}`)
    }
    return targets
  }

  return {
    assign({ chatId, captainRoleId, text, roleIds = [] }) {
      requireCaptain(chatId, captainRoleId)
      const targets = resolveTargets(chatId, captainRoleId, roleIds)
      const result = roomDb.withTransaction(() => {
        const message = timeline.append({
          chatId,
          authorType: 'agent',
          authorId: captainRoleId,
          content: text ?? '',
          mentions: targets,
          status: 'done',
        })
        const assignmentId = crypto.randomUUID()
        const replies = targets.map(roleId => queueReply({
          chatId,
          roleId,
          trigger: message,
          rootMessageId: message.id,
          captainAssignmentId: assignmentId,
        }))
        const targetReplyIds = replies.filter(Boolean).map(reply => reply.id)
        const createdAt = new Date().toISOString()
        database.prepare(`
          INSERT INTO captain_assignments
            (id, chat_id, message_id, root_message_id, target_role_ids_json, target_reply_ids_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        `).run(
          assignmentId, chatId, message.id, message.id,
          JSON.stringify(targets), JSON.stringify(targetReplyIds), createdAt,
        )
        return {
          message,
          assignment: {
            id: assignmentId,
            chatId,
            messageId: message.id,
            rootMessageId: message.id,
            targetRoleIds: targets,
            targetReplyIds,
            status: 'active',
            createdAt,
          },
          replies,
        }
      })
      if (typeof requestTick === 'function') requestTick(chatId)
      return result
    },
  }
}

function chosenSkills(selectSkills, provider, skills) {
  const requested = Array.isArray(skills) ? skills : []
  if (requested.length === 0) return []
  if (typeof selectSkills !== 'function') throw new Error('ROOM_ROLE_SKILL_NOT_AVAILABLE')
  try {
    return selectSkills(provider, requested)
  } catch {
    throw new Error('ROOM_ROLE_SKILL_NOT_AVAILABLE')
  }
}

function registerCaptainTools({
  dispatcher, repository, captainAssignment, timeline, roomDb, canLaunch = () => true,
  onUnavailable = null,
  selectSkills = null,
  rosterWaitsForInstruction = () => true,
}) {
  if (!roomDb) throw new TypeError('ROOM_CAPTAIN_TOOLS_DATABASE_REQUIRED')
  const { database } = roomDb

  function rosterCreatedThisRun(runId) {
    return Boolean(database.prepare(`
      SELECT 1 AS hit FROM tool_calls
      WHERE run_id = ? AND tool_name = 'create_roles' AND status = 'succeeded'
      LIMIT 1
    `).get(runId))
  }

  function createRoles({ chatId, captainRoleId, roles }) {
    const choose = (provider, skills) => chosenSkills(selectSkills, provider, skills)
    const captain = repository.getRole(captainRoleId)
    if (!captain || !captain.isCaptain || captain.chatId !== chatId) throw new Error('ROOM_CAPTAIN_REQUIRED')
    if (!Array.isArray(roles) || roles.length === 0) throw new Error('ROOM_ROSTER_INVALID')
    const chat = repository.getChat(chatId)
    const room = repository.getRoom(chat.roomId)
    const specs = roles.map(role => {
      if (!role || typeof role !== 'object' || Array.isArray(role)) throw new Error('ROOM_ROSTER_INVALID')
      const provider = typeof role.provider === 'string' ? role.provider.trim() : ''
      if (!PROVIDER.test(provider)) throw new Error('ROOM_ROLE_PROVIDER_NOT_ALLOWED')
      if (canLaunch(provider) === false) {
        if (typeof onUnavailable === 'function') {
          onUnavailable({
            chatId,
            roles: [{
              id: '',
              displayName: typeof role.displayName === 'string' && role.displayName.trim()
                ? role.displayName.trim()
                : provider,
              provider,
            }],
            requestedBy: captainRoleId,
          })
        }
        throw new Error('ROOM_ROLE_PROVIDER_NOT_LAUNCHABLE')
      }
      return {
        displayName: cleanName(role.displayName),
        provider,
        prompt: cleanPrompt(role.prompt),
        responsibilities: cleanResponsibilities(role.responsibilities),
        nativePermission: maxNativePermission(provider),
        skills: choose(provider, role.skills),
      }
    })
    return roomDb.withTransaction(() => {
      const usedFaces = new Map()
      for (const row of database.prepare(
        "SELECT id, display_name, provider, portrait FROM chat_roles WHERE chat_id = ? AND status = 'active'",
      ).all(chatId)) {
        const face = shownFace(row)
        usedFaces.set(face, (usedFaces.get(face) || 0) + 1)
      }
      const enabled = [...room.providers]
      for (const spec of specs) {
        if (!enabled.includes(spec.provider)) enabled.push(spec.provider)
      }
      if (enabled.length !== room.providers.length) {
        database.prepare('UPDATE rooms SET providers_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(enabled), new Date().toISOString(), room.id)
      }
      const roleIds = specs.map(spec => {
        const roleId = repository.createRole({
          chatId,
          displayName: spec.displayName,
          provider: spec.provider,
          prompt: spec.prompt,
          responsibilities: spec.responsibilities,
          nativePermission: spec.nativePermission,
          skills: spec.skills,
          portrait: takePortrait(usedFaces),
          isCaptain: false,
          createdBy: captain.id,
        })
        repository.addParticipant({ chatId, roleId })
        return roleId
      })
      const message = timeline.append({
        chatId,
        authorType: 'agent',
        authorId: captain.id,
        content: `Added ${specs.map(spec => spec.displayName).join(', ')}.`,
        status: 'done',
        data: { roleIds },
      })
      return { roleIds, messageId: message.id }
    })
  }

  dispatcher.register('assign_in_group', async (args, context) => {
    const waits = typeof rosterWaitsForInstruction === 'function' ? rosterWaitsForInstruction() !== false : true
    if (waits && rosterCreatedThisRun(context.runId)) throw new Error('ROOM_ROSTER_ASSIGN_WAIT')
    return captainAssignment.assign({
      chatId: context.chatId,
      captainRoleId: context.roleId,
      text: args.text ?? '',
      roleIds: args.roleIds ?? [],
    })
  }, {
    description: 'Assign work to one or more participants in this chat with one visible message.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        roleIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
  })

  dispatcher.register('create_roles', async (args, context) => {
    return createRoles({
      chatId: context.chatId,
      captainRoleId: context.roleId,
      roles: args.roles,
    })
  }, {
    description: 'Add members to this chat by writing each member name, provider, responsibilities, prompt, and skill ids chosen from the briefing inventory. The platform stores the maximum permission for that provider. New members are not woken until assign_in_group. Follow the briefing on whether to assign in this turn or wait for the next user message.',
    inputSchema: {
      type: 'object',
      properties: {
        roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              displayName: { type: 'string' },
              provider: { type: 'string' },
              responsibilities: { type: 'string' },
              prompt: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } },
            },
            required: ['displayName', 'provider', 'prompt'],
          },
        },
      },
      required: ['roles'],
    },
  })

  dispatcher.register('rename_chat', async (args, context) => {
    const role = repository.getRole(context.roleId)
    if (!role || !role.isCaptain || role.chatId !== context.chatId) throw new Error('ROOM_CAPTAIN_REQUIRED')
    const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 80 || title.includes('\u0000')) throw new Error('ROOM_CHAT_TITLE_INVALID')
    const row = database.prepare('SELECT title, title_locked FROM chats WHERE id = ?').get(context.chatId)
    if (!row) throw new Error('ROOM_CHAT_NOT_FOUND')
    if (row.title_locked) return { renamed: false, title: row.title, locked: true }
    if (row.title === title) return { renamed: false, title, locked: false }
    database.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), context.chatId)
    return { renamed: true, title, locked: false }
  }, {
    description: 'Rename this chat to one short sentence that states the user request. Skip when the result says the title is locked.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  })

  dispatcher.register('post_in_chat', async (args, context) => {
    const role = repository.getRole(context.roleId)
    if (!role || !role.isCaptain || role.chatId !== context.chatId) throw new Error('ROOM_CAPTAIN_REQUIRED')
    return timeline.append({
      chatId: context.chatId,
      authorType: 'agent',
      authorId: context.roleId,
      content: args.text ?? '',
      audience: 'chat',
      status: 'done',
    })
  }, {
    description: 'Post a public message in the current chat.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  })
}

module.exports = { createCaptainAssignment, registerCaptainTools, hashedMascotId, takePortrait }
