const { judgeMention, resolveNamed } = require('../routing.cjs')

function registerMentionTool({ dispatcher, roomDb, repository, timeline, queueReply }) {
  const { database } = roomDb

  dispatcher.register('mention', async (args, context) => {
    const participants = repository.listParticipants(context.chatId)
    const members = participants.map(participant => ({ id: participant.roleId, name: participant.displayName }))
    const { ids, unknown } = resolveNamed(args.names ?? [], members, context.roleId)
    if (ids.length === 0) return { targets: [], unknown, wake: 'none', queued: 0 }

    const runRow = database.prepare('SELECT root_message_id FROM messages WHERE id = ?').get(context.runId)
    const rootMessageId = context.rootMessageId ?? runRow?.root_message_id ?? null
    const mention = timeline.append({
      chatId: context.chatId,
      authorType: 'agent',
      authorId: context.roleId,
      kind: 'mention',
      content: args.text ?? '',
      mentions: ids,
      rootMessageId,
      captainAssignmentId: context.captainAssignmentId ?? null,
      status: 'done',
    })

    const count = database.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE chat_id = ? AND kind = 'mention' AND root_message_id IS ?
    `).get(context.chatId, rootMessageId).n
    const wake = judgeMention(count)
    let queued = 0
    if (wake !== 'capped') {
      for (const roleId of ids) {
        queueReply({
          chatId: context.chatId,
          roleId,
          trigger: mention,
          rootMessageId: rootMessageId ?? mention.id,
          captainAssignmentId: context.captainAssignmentId ?? null,
        })
        queued += 1
      }
    }
    return { targets: ids, unknown, wake, queued, messageId: mention.id }
  }, {
    description: 'Mention one or more participants in this chat.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' },
      },
      required: ['names', 'text'],
    },
  })
}

module.exports = { registerMentionTool }
