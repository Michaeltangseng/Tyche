const { routeUserMessage, resolveNamed } = require('./routing.cjs')
const { briefing } = require('./briefing.cjs')

function mentionNames(content) {
  const names = []
  const pattern = /@([\p{L}\p{N}_-]+)/gu
  for (const match of String(content ?? '').matchAll(pattern)) names.push(match[1])
  return names
}

function createEngine({ roomDb, repository, timeline, sessions, outbox, runtime, now = () => Date.now() }) {
  const { database } = roomDb
  const activeReplies = new Map()

  function repliesFor(chatId, rootMessageId) {
    return database.prepare(`
      SELECT id FROM messages
      WHERE chat_id = ? AND reply_to = ? AND author_type = 'agent'
      ORDER BY seq ASC
    `).all(chatId, rootMessageId).map(row => timeline.get(row.id))
  }

  const engine = {
    submitUserMessage({ chatId, authorId = 'user', content, clientId = null }) {
      if (clientId !== null && clientId !== undefined) {
        const existing = database.prepare('SELECT id FROM messages WHERE chat_id = ? AND client_id = ?').get(chatId, clientId)
        if (existing) return { message: timeline.get(existing.id), replies: repliesFor(chatId, existing.id) }
      }
      const participants = repository.listParticipants(chatId)
      const members = participants.map(participant => ({ id: participant.roleId, name: participant.displayName }))
      const named = resolveNamed(mentionNames(content), members, null).ids
      const captain = participants.find(participant => participant.isCaptain)
      const route = routeUserMessage({
        kind: participants.length === 1 ? 'direct' : 'group',
        members,
        mentions: named,
        steward: captain ? captain.roleId : null,
      })
      return roomDb.withTransaction(() => {
        const message = timeline.append({
          chatId,
          authorType: 'user',
          authorId,
          content: content ?? '',
          clientId,
          status: 'done',
        })
        const replies = []
        for (const roleId of route.targets) {
          const reply = timeline.append({
            chatId,
            authorType: 'agent',
            authorId: roleId,
            content: '',
            replyTo: message.id,
            rootMessageId: message.id,
            status: 'queued',
            clientId: `reply:${message.id}:${roleId}`,
          })
          outbox.enqueue({
            chatId,
            kind: 'start_reply',
            payload: { replyId: reply.id, roleId, triggerId: message.id },
            idempotencyKey: `start_reply:${reply.id}`,
          })
          replies.push(reply)
        }
        return { message, replies }
      })
    },

    startReply(replyId) {
      const reply = timeline.get(replyId)
      if (!reply) throw new Error('ROOM_MESSAGE_NOT_FOUND')
      if (reply.status !== 'queued') throw new Error('ROOM_REPLY_NOT_QUEUED')
      const effect = outbox.findByIdempotencyKey(`start_reply:${replyId}`)
      if (!effect) throw new Error('ROOM_REPLY_EFFECT_NOT_FOUND')

      let resolveDone
      let rejectDone
      const done = new Promise((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })
      done.catch(() => { /* an ignored completion promise must not crash the process */ })

      const launched = (async () => {
        const claimed = outbox.claim(effect.id)
        if (!claimed) throw new Error('ROOM_REPLY_EFFECT_NOT_PENDING')
        let handle
        try {
          const role = repository.getRole(reply.authorId)
          if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
          const chat = repository.getChat(reply.chatId)
          const room = repository.getRoom(chat.roomId)
          const revisionRow = database.prepare('SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?').get(role.id)
          const promptRevision = revisionRow?.revision ?? 1
          const session = sessions.ensureSession({
            scopeType: 'chat',
            scopeId: reply.chatId,
            roleId: role.id,
            provider: role.provider,
            promptRevision,
            permissionMode: role.nativePermission || 'read-only',
            workspaceRef: room.workspace,
            skillBindings: [],
            model: role.model,
            thinkingLevel: null,
            created: () => {},
          })
          const sessionRow = database.prepare('SELECT * FROM sessions WHERE id = ?').get(session.sessionId)
          const lastSeq = sessions.getParticipantLastSeq({ chatId: reply.chatId, roleId: role.id })
          const trigger = timeline.get(reply.replyTo) ?? reply
          const participants = repository.listParticipants(reply.chatId)
          const nameOf = row => {
            if (row.authorType === 'user') return 'user'
            if (row.authorType === 'system') return 'system'
            return participants.find(participant => participant.roleId === row.authorId)?.displayName ?? row.authorId
          }
          const prompt = briefing({
            chatTitle: chat.title,
            me: role.id,
            lastSeq,
            rows: timeline.after(reply.chatId, lastSeq),
            trigger,
            nameOf,
          }).text
          const controller = new AbortController()
          handle = runtime.start({
            runId: reply.id,
            chatId: reply.chatId,
            roleId: role.id,
            prompt,
            nativeSessionRef: sessionRow?.native_session_ref ?? null,
            signal: controller.signal,
            onEvent: () => {},
          })
          const launchResult = await handle.launch
          if (launchResult?.nativeSessionRef) {
            sessions.saveNativeRef({ sessionId: session.sessionId, nativeSessionRef: launchResult.nativeSessionRef })
          }
          outbox.succeed(effect.id)
          timeline.transition(reply.id, ['queued'], 'working')
          activeReplies.set(reply.id, { controller, done })
          Promise.resolve(handle.completion).then(outcome => {
            timeline.finish(reply.id, {
              status: outcome.status,
              text: outcome.text ?? '',
              thinking: outcome.thinking ?? '',
              data: outcome.activity ?? null,
            })
            sessions.setParticipantLastSeq({ chatId: reply.chatId, roleId: role.id, seq: reply.seq })
            resolveDone()
          }).catch(error => {
            try {
              timeline.finish(reply.id, {
                status: 'failed',
                text: error?.message ?? '',
                data: { error: error?.message ?? String(error) },
              })
            } catch { /* preserve the completion error */ }
            rejectDone(error)
          }).finally(() => activeReplies.delete(reply.id))
          return outbox.get(effect.id)
        } catch (error) {
          outbox.fail(effect.id, error)
          try {
            timeline.finish(reply.id, {
              status: 'failed',
              text: error?.message ?? '',
              data: { error: error?.message ?? String(error) },
            })
          } catch { /* preserve the launch error */ }
          throw error
        }
      })()

      launched.catch(error => rejectDone(error))
      return { effectId: effect.id, launched, done }
    },

    async startQueuedReplies({ chatId }) {
      const rows = database.prepare(`
        SELECT id FROM messages
        WHERE chat_id = ? AND author_type = 'agent' AND status = 'queued'
        ORDER BY seq ASC
      `).all(chatId)
      const byRole = new Map()
      for (const row of rows) {
        const reply = timeline.get(row.id)
        if (!byRole.has(reply.authorId)) byRole.set(reply.authorId, [])
        byRole.get(reply.authorId).push(reply)
      }
      const launches = []
      for (const list of byRole.values()) {
        const chain = (async () => {
          for (const reply of list) {
            const pending = engine.startReply(reply.id)
            launches.push(pending.launched)
            await pending.launched
            await pending.done
          }
        })()
        chain.catch(() => { /* individual reply failure is surfaced on its row */ })
      }
      await Promise.all(launches)
    },

    async stopReply({ replyId }) {
      const active = activeReplies.get(replyId)
      if (active) {
        active.controller.abort()
        await active.done
        return
      }
      const reply = timeline.get(replyId)
      if (!reply) throw new Error('ROOM_MESSAGE_NOT_FOUND')
      if (reply.status === 'queued' || reply.status === 'working' || reply.status === 'waiting_for_input') {
        timeline.transition(replyId, [reply.status], 'stopped')
      }
    },
  }
  return engine
}

module.exports = { createEngine }
