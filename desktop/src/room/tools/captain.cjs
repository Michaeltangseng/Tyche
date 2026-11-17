const crypto = require('node:crypto')

function createCaptainAssignment({ roomDb, repository, timeline, review, queueReply, requestTick }) {
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
    for (const roleId of targets) {
      const role = repository.getRole(roleId)
      if (!role || role.chatId !== chatId || role.status !== 'active') throw new Error('ROOM_CAPTAIN_TARGET_INVALID')
      if (role.isCaptain) throw new Error('ROOM_CAPTAIN_SELF_TARGET')
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

function registerCaptainTools({ dispatcher, repository, captainAssignment, timeline }) {
  dispatcher.register('assign_in_group', async (args, context) => {
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

module.exports = { createCaptainAssignment, registerCaptainTools }
