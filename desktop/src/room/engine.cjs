const { routeUserMessage, resolveNamed } = require('./routing.cjs')
const { briefing, rosterProviders } = require('./briefing.cjs')
const { safeEvent, safeUsage } = require('./runtime-event-view.cjs')

function settleTrace(steps, event) {
  const safe = safeEvent(event)
  if (!safe || !['tool_call_started', 'tool_call_input', 'tool_call_ended'].includes(safe.kind)) return steps
  const callId = safe.callId || `${safe.toolName || 'tool'}-${steps.length}`
  let step = steps.find(item => item.callId === callId)
  if (!step) {
    step = {
      callId,
      name: safe.toolName || 'tool',
      input: '',
      output: '',
      status: 'running',
    }
    steps.push(step)
  }
  if (safe.toolName) step.name = safe.toolName
  if (typeof safe.input === 'string' && safe.input) step.input = safe.input
  if (typeof safe.output === 'string') step.output = safe.output
  if (safe.status) step.status = safe.status
  if (Number.isInteger(safe.exitCode)) step.exitCode = safe.exitCode
  return steps
}

function mergeSettledUsage(previous, raw) {
  const next = safeUsage(raw)
  if (!next) return previous || null
  if (!previous) return next
  const context = next.context || previous.context
  return {
    ...previous,
    ...next,
    ...(context ? { context } : {}),
  }
}

function mentionNames(content) {
  const names = []
  const pattern = /@([\p{L}\p{N}_-]+)/gu
  for (const match of String(content ?? '').matchAll(pattern)) names.push(match[1])
  return names
}

function createEngine({
  roomDb, repository, timeline, sessions, outbox, runtime, now = () => Date.now(), onEvent = () => {},
  launchProviders = null,
  canLaunch = null,
  onUnavailable = null,
  skillSource = null,
  rosterWaitsForInstruction = null,
}) {
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
    queueReply({ chatId, roleId, trigger, rootMessageId = null, captainAssignmentId = null, clientId = null }) {
      return roomDb.withTransaction(() => {
        const reply = timeline.append({
          chatId,
          authorType: 'agent',
          authorId: roleId,
          content: '',
          replyTo: trigger.id,
          rootMessageId: rootMessageId ?? trigger.id,
          captainAssignmentId,
          status: 'queued',
          clientId: clientId ?? `reply:${trigger.id}:${roleId}:${captainAssignmentId ?? ''}`,
        })
        outbox.enqueue({
          chatId,
          kind: 'start_reply',
          payload: { replyId: reply.id, roleId, triggerId: trigger.id },
          idempotencyKey: `start_reply:${reply.id}`,
        })
        return reply
      })
    },

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
        const unavailable = []
        for (const roleId of route.targets) {
          const role = participants.find(participant => participant.roleId === roleId)
          if (role && typeof canLaunch === 'function' && canLaunch(role.provider) === false) {
            unavailable.push(role)
            continue
          }
          replies.push(engine.queueReply({ chatId, roleId, trigger: message, rootMessageId: message.id }))
        }
        if (unavailable.length > 0 && typeof onUnavailable === 'function') {
          onUnavailable({ chatId, roles: unavailable, requestedBy: 'user' })
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
        let settledUsage = null
        const settledTrace = []
        const finishData = (data) => {
          const finalData = data && typeof data === 'object' ? { ...data } : {}
          if (settledUsage) finalData.usage = settledUsage
          if (settledTrace.length) finalData.trace = settledTrace.map(step => ({ ...step }))
          return Object.keys(finalData).length > 0 ? finalData : null
        }
        try {
          const role = repository.getRole(reply.authorId)
          if (!role) throw new Error('ROOM_ROLE_NOT_FOUND')
          const chat = repository.getChat(reply.chatId)
          const room = repository.getRoom(chat.roomId)
          const revisionRow = database.prepare('SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?').get(role.id)
          const promptRevision = revisionRow?.revision ?? 1
          let equippedSkills = []
          if (skillSource && Array.isArray(role.skills) && role.skills.length) {
            try {
              equippedSkills = skillSource.materialize(role.provider, role.skills, {
                workspace: room.workspace,
              }).skills || []
            } catch { equippedSkills = [] }
          }
          const skillBindings = equippedSkills.map(skill => ({
            id: skill.id,
            contentHash: skill.contentHash,
            delivery: skill.delivery,
          }))
          const session = sessions.ensureSession({
            scopeType: 'chat',
            scopeId: reply.chatId,
            roleId: role.id,
            provider: role.provider,
            promptRevision,
            permissionMode: room?.workspaceOrigin === 'default' && room?.workspaceConfirmed !== true
              ? 'read-only'
              : (role.nativePermission || 'read-only'),
            workspaceRef: room.workspace,
            skillBindings,
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
          let speakable
          if (role.isCaptain === true) {
            let launchIds
            if (typeof launchProviders === 'function') {
              try {
                const ids = launchProviders()
                if (Array.isArray(ids)) launchIds = ids
              } catch { /* fall back to the providers enabled on the room */ }
            }
            speakable = rosterProviders(room.providers, launchIds)
          }
          let skillInventory
          if (role.isCaptain === true && skillSource) {
            try { skillInventory = skillSource.captainInventory(speakable || room.providers || []) } catch { skillInventory = null }
          }
          const briefingResult = briefing({
            chatTitle: chat.title,
            me: role.id,
            lastSeq,
            rows: timeline.after(reply.chatId, lastSeq),
            trigger,
            nameOf,
            viewerIsCaptain: role.isCaptain === true,
            members: role.isCaptain === true
              ? participants.map(participant => ({
                displayName: participant.displayName,
                provider: participant.provider,
                isCaptain: participant.isCaptain === true,
              }))
              : undefined,
            launchProviders: speakable,
            equippedSkills,
            skillInventory,
            rosterWaitsForInstruction: typeof rosterWaitsForInstruction === 'function'
              ? rosterWaitsForInstruction() !== false
              : true,
          })
          const prompt = briefingResult.text
          const watermark = briefingResult.seen
          const controller = new AbortController()
          handle = runtime.start({
            runId: reply.id,
            chatId: reply.chatId,
            roleId: role.id,
            prompt,
            nativeSessionRef: sessionRow?.native_session_ref ?? null,
            signal: controller.signal,
            onEvent: event => {
              if (event?.kind === 'usage') settledUsage = mergeSettledUsage(settledUsage, event.usage)
              settleTrace(settledTrace, event)
              onEvent({
                runId: reply.id,
                chatId: reply.chatId,
                roleId: role.id,
                mode: 'chat',
                event,
              })
            },
          })
          const launchResult = await handle.launch
          if (launchResult?.nativeSessionRef) {
            sessions.saveNativeRef({ sessionId: session.sessionId, nativeSessionRef: launchResult.nativeSessionRef })
          }
          outbox.succeed(effect.id)
          timeline.transition(reply.id, ['queued'], 'working')
          activeReplies.set(reply.id, { controller, done })
          Promise.resolve(handle.completion).then(outcome => {
            // Keep flags the reply row was born with (for example reviewReply):
            // finishing may add activity, but it must not erase audience data.
            const current = timeline.get(reply.id)
            const finalData = current?.data && typeof current.data === 'object' ? { ...current.data } : {}
            if (outcome.activity !== undefined && outcome.activity !== null) finalData.activity = outcome.activity
            timeline.finish(reply.id, {
              status: outcome.status,
              text: outcome.text ?? '',
              thinking: outcome.thinking ?? '',
              data: finishData(finalData),
            })
            sessions.setParticipantLastSeq({ chatId: reply.chatId, roleId: role.id, seq: watermark })
            resolveDone()
          }).catch(error => {
            try {
              timeline.finish(reply.id, {
                status: 'failed',
                text: error?.message ?? '',
                data: finishData({ error: error?.message ?? String(error) }),
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
              data: finishData({ error: error?.message ?? String(error) }),
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
      // One participant session answers one thing at a time. A queued reply
      // for a role that is still working/stopping waits for the next tick.
      const busyRoles = new Set(database.prepare(`
        SELECT DISTINCT author_id FROM messages
        WHERE chat_id = ? AND author_type = 'agent'
          AND status IN ('working', 'waiting_for_input', 'stopping')
      `).all(chatId).map(row => row.author_id))
      const launches = []
      const errors = []
      for (const list of byRole.values()) {
        if (busyRoles.has(list[0].authorId)) continue
        const chain = (async () => {
          for (const reply of list) {
            const pending = engine.startReply(reply.id)
            launches.push(pending.launched)
            await pending.launched
            await pending.done
          }
        })()
        chain.catch(error => errors.push(error))
      }
      await Promise.all(launches)
      if (errors.length > 0) throw errors[0]
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
