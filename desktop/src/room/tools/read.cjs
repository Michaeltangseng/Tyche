function registerReadChatTool({ dispatcher, timeline, repository = null }) {
  dispatcher.register('read_chat', async (args, context) => {
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50) || 50))
    const beforeSeq = args.beforeSeq ?? null
    const role = repository?.getRole(context.roleId)
    const viewerIsCaptain = role?.isCaptain === true
    const visible = timeline.after(context.chatId, -1)
      .filter(row => row.audience !== 'captain' || viewerIsCaptain)
    const rows = beforeSeq === null
      ? visible.slice().reverse().slice(0, limit + 1)
      : visible.filter(row => row.seq < beforeSeq).reverse().slice(0, limit + 1)
    const hasMore = rows.length > limit
    const messages = rows.slice(0, limit).reverse()
    return { messages, hasMore }
  }, {
    readOnly: true,
    description: 'Read messages from the current chat, newest page first in storage but returned oldest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        beforeSeq: { type: ['number', 'null'] },
        limit: { type: 'number' },
      },
    },
  })
}

module.exports = { registerReadChatTool }
