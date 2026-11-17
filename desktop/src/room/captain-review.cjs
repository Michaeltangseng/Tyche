const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function reviewView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    assignmentId: row.assignment_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    checkpointSeq: row.checkpoint_seq,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    body: row.body,
    data: parseJson(row.data_json, null),
    replyId: row.reply_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assignmentView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    rootMessageId: row.root_message_id,
    targetRoleIds: parseJson(row.target_role_ids_json, []),
    targetReplyIds: parseJson(row.target_reply_ids_json, []),
    status: row.status,
    createdAt: row.created_at,
  }
}

const BUSY_REPLY = new Set(['queued', 'working', 'stopping'])
const OPEN_RUN = new Set(['queued', 'starting', 'running', 'in_progress'])

function createCaptainReview({ roomDb, repository, timeline, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function chatRow(chatId) {
    return database.prepare('SELECT * FROM chats WHERE id = ?').get(chatId)
  }

  return {
    recordAssignment({ chatId, messageId, rootMessageId, targetRoleIds, targetReplyIds }) {
      const message = database.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId)
      if (!message) throw new Error('ROOM_ASSIGNMENT_MESSAGE_NOT_FOUND')
      const id = crypto.randomUUID()
      const createdAt = at()
      roomDb.withTransaction(() => {
        database.prepare(`
          INSERT INTO captain_assignments
            (id, chat_id, message_id, root_message_id, target_role_ids_json, target_reply_ids_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        `).run(
          id, chatId, messageId, rootMessageId ?? messageId,
          JSON.stringify(targetRoleIds ?? []), JSON.stringify(targetReplyIds ?? []), createdAt,
        )
        for (const replyId of targetReplyIds ?? []) {
          database.prepare('UPDATE messages SET captain_assignment_id = ? WHERE id = ? AND chat_id = ?')
            .run(id, replyId, chatId)
        }
      })
      return assignmentView(database.prepare('SELECT * FROM captain_assignments WHERE id = ?').get(id))
    },

    review({ chatId }) {
      const chat = chatRow(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const assignments = database.prepare(`
        SELECT * FROM captain_assignments WHERE chat_id = ? AND status = 'active' ORDER BY created_at ASC
      `).all(chatId)
      if (assignments.length === 0) return []

      const lastReview = database.prepare(`
        SELECT MAX(checkpoint_seq) AS checkpoint FROM captain_reviews WHERE chat_id = ?
      `).get(chatId).checkpoint ?? 0
      const checkpoint = Math.max(chat.captain_reviewed_seq ?? 0, lastReview)
      const created = []

      for (const assignment of assignments) {
        const targetRoleIds = parseJson(assignment.target_role_ids_json, [])
        const targetReplyIds = parseJson(assignment.target_reply_ids_json, [])
        const replies = targetReplyIds.length === 0
          ? []
          : database.prepare(`
              SELECT * FROM messages WHERE id IN (${targetReplyIds.map(() => '?').join(',')})
            `).all(...targetReplyIds)
        if (replies.some(reply => BUSY_REPLY.has(reply.status))) continue
        const waiting = replies.some(reply => reply.status === 'waiting_for_input')

        let tasks = []
        if (targetRoleIds.length > 0) {
          tasks = database.prepare(`
            SELECT * FROM tasks
            WHERE chat_id = ? AND assignee_role_id IN (${targetRoleIds.map(() => '?').join(',')})
              AND status != 'cancelled'
          `).all(chatId, ...targetRoleIds)
        }
        if (tasks.some(task => task.status === 'todo' || task.status === 'in_progress')) continue
        if (tasks.length > 0) {
          const open = database.prepare(`
            SELECT 1 AS open FROM task_runs
            WHERE task_id IN (${tasks.map(() => '?').join(',')})
              AND status IN (${[...OPEN_RUN].map(() => '?').join(',')})
            LIMIT 1
          `).get(...tasks.map(task => task.id), ...OPEN_RUN)
          if (open) continue
        }

        const assignmentMessage = database.prepare('SELECT seq FROM messages WHERE id = ?').get(assignment.message_id)
        const baseline = Math.max(checkpoint, assignmentMessage?.seq ?? 0)
        const blocked = waiting || tasks.some(task => task.status === 'blocked')
        const hasNew = chat.activity_seq > baseline
        if (!hasNew && !blocked) continue

        const kind = blocked ? 'assignment_blocked' : 'assignment_settled'
        const dedupeKey = `${chatId}:${kind}:${chat.activity_seq}`
        const existing = database.prepare('SELECT id FROM captain_reviews WHERE chat_id = ? AND dedupe_key = ?')
          .get(chatId, dedupeKey)
        if (existing) continue

        const id = crypto.randomUUID()
        const body = [
          `assignment ${assignment.id}`,
          `checkpoint ${chat.activity_seq}`,
          `targets ${targetRoleIds.join(',') || 'none'}`,
          `tasks ${tasks.map(task => `${task.id}:${task.status}`).join(',') || 'none'}`,
        ].join(' · ')
        const data = {
          assignmentId: assignment.id,
          checkpoint: chat.activity_seq,
          targetRoleIds,
          targetReplyIds,
          taskIds: tasks.map(task => task.id),
          waiting,
        }
        const createdAt = at()
        database.prepare(`
          INSERT INTO captain_reviews
            (id, chat_id, assignment_id, kind, dedupe_key, checkpoint_seq, status, body, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(
          id, chatId, assignment.id, kind, dedupeKey, chat.activity_seq,
          body, JSON.stringify(data), createdAt, createdAt,
        )
        created.push(reviewView(database.prepare('SELECT * FROM captain_reviews WHERE id = ?').get(id)))
      }
      return created
    },

    deliver({ chatId }) {
      const chat = chatRow(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const captain = repository.listParticipants(chatId).find(participant => participant.isCaptain)
      if (!captain) return []
      const busy = database.prepare(`
        SELECT 1 AS busy FROM messages
        WHERE chat_id = ? AND author_id = ? AND status IN ('queued', 'working', 'stopping')
        LIMIT 1
      `).get(chatId, captain.roleId)
      if (busy) return []
      const pending = database.prepare(`
        SELECT * FROM captain_reviews WHERE chat_id = ? AND status = 'pending'
        ORDER BY created_at ASC, rowid ASC LIMIT 20
      `).all(chatId)
      if (pending.length === 0) return []
      const reviewIds = pending.map(review => review.id)
      const body = pending.map(review => review.body).join('\n\n').slice(0, 12_000)
      const promptRevision = database.prepare(`
        SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?
      `).get(captain.roleId).revision ?? 1
      const checkpoint = Math.max(...pending.map(review => review.checkpoint_seq))

      return roomDb.withTransaction(() => {
        const message = timeline.append({
          chatId,
          authorType: 'system',
          authorId: 'system',
          kind: 'captain_review',
          content: body,
          mentions: [],
          audience: 'captain',
          status: 'done',
          data: { reviewIds, checkpoint, promptRevision },
        })
        const reply = timeline.append({
          chatId,
          authorType: 'agent',
          authorId: captain.roleId,
          content: '',
          replyTo: message.id,
          rootMessageId: message.id,
          audience: 'captain',
          status: 'queued',
          data: { reviewReply: true, reviewIds, checkpoint, promptRevision },
        })
        for (const review of pending) {
          database.prepare("UPDATE captain_reviews SET status = 'completed', reply_id = ?, updated_at = ? WHERE id = ?")
            .run(reply.id, at(), review.id)
        }
        database.prepare('UPDATE chats SET captain_reviewed_seq = ?, updated_at = ? WHERE id = ?')
          .run(checkpoint, at(), chatId)
        return [{ message, reply, reviewIds, checkpoint }]
      })
    },

    chatIds() {
      return database.prepare(`
        SELECT DISTINCT chat_id FROM captain_assignments WHERE status = 'active'
      `).all().map(row => row.chat_id)
    },
  }
}

module.exports = { createCaptainReview }
