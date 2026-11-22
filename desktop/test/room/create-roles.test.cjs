const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createRoomReadModel } = require('../../src/room/read-model.cjs')
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')
const { createCaptainAssignment, registerCaptainTools } = require('../../src/room/tools/captain.cjs')

function setup(t, { providers = ['claude', 'codex', 'hermes'] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  t.after(() => roomDb.close())
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory, providers })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const captain = repo.createRole({
    chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true,
  })
  repo.addParticipant({ chatId, roleId: captain })
  const timeline = createTimeline({ roomDb, repository: repo })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  const queued = []
  const captainAssignment = createCaptainAssignment({
    roomDb,
    repository: repo,
    timeline,
    queueReply: input => {
      queued.push(input)
      return { id: `reply-${queued.length}` }
    },
    requestTick: () => {},
  })
  registerCaptainTools({
    dispatcher,
    repository: repo,
    captainAssignment,
    timeline,
    roomDb,
    canLaunch: provider => provider !== 'hermes',
  })
  return { roomDb, repo, roomId, chatId, captain, timeline, dispatcher, queued }
}

function promptOf(roomDb, roleId) {
  return roomDb.database.prepare(`
    SELECT prompt, created_by FROM role_prompt_revisions
    WHERE role_id = ? ORDER BY revision DESC LIMIT 1
  `).get(roleId)
}

test('create_roles writes the same role record the dialog writes, at max permission, without waking anyone', async t => {
  const { roomDb, repo, roomId, chatId, captain, timeline, dispatcher } = setup(t)
  dispatcher.bindRun('run1', {
    chatId,
    roleId: captain,
    allowedTools: ['create_roles', 'assign_in_group'],
  })
  const result = await dispatcher.invoke({
    runId: 'run1',
    callId: 'roster-1',
    name: 'create_roles',
    args: {
      roles: [
        {
          displayName: '研究员',
          provider: 'claude',
          responsibilities: '查资料',
          prompt: '研究问题并给出出处。',
          nativePermission: 'plan',
        },
        {
          displayName: '实现',
          provider: 'codex',
          responsibilities: '改代码',
          prompt: '按任务改代码并收尾。',
        },
      ],
    },
  })

  assert.equal(result.roleIds.length, 2)
  const roles = result.roleIds.map(id => repo.getRole(id))
  assert.deepEqual(roles.map(role => role.displayName), ['研究员', '实现'])
  assert.deepEqual(roles.map(role => role.nativePermission), ['bypassPermissions', 'danger-full-access'])
  assert.deepEqual(roles.map(role => role.responsibilities), ['查资料', '改代码'])
  assert.equal(roles.every(role => role.isCaptain === false), true)
  assert.equal(promptOf(roomDb, roles[0].id).prompt, '研究问题并给出出处。')
  assert.equal(promptOf(roomDb, roles[0].id).created_by, captain)
  assert.deepEqual(
    repo.listParticipants(chatId).map(participant => participant.roleId).sort(),
    [captain, ...result.roleIds].sort(),
  )

  const message = timeline.latest(chatId)
  assert.equal(message.authorId, captain)
  assert.deepEqual(message.mentions, [])
  assert.deepEqual(message.data.roleIds, result.roleIds)
  const visible = createRoomReadModel({ roomDb }).snapshot({ roomId }).messages
    .find(row => row.id === message.id)
  assert.deepEqual(visible.data.roleIds, result.roleIds)

  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run1',
      callId: 'assign-1',
      name: 'assign_in_group',
      args: { text: '开始', roleIds: [result.roleIds[0]] },
    }),
    /ROOM_ROSTER_ASSIGN_WAIT/,
  )
  assert.equal(timeline.latest(chatId).id, message.id)
})

test('a later run can assign the members create_roles stored', async t => {
  const { chatId, captain, dispatcher, queued } = setup(t)
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['create_roles', 'assign_in_group'] })
  const created = await dispatcher.invoke({
    runId: 'run1',
    callId: 'roster-1',
    name: 'create_roles',
    args: { roles: [{ displayName: '实现', provider: 'codex', prompt: '改代码' }] },
  })
  dispatcher.bindRun('run2', { chatId, roleId: captain, allowedTools: ['assign_in_group'] })
  await dispatcher.invoke({
    runId: 'run2',
    callId: 'assign-1',
    name: 'assign_in_group',
    args: { text: '开始', roleIds: [created.roleIds[0]] },
  })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].roleId, created.roleIds[0])
})

test('create_roles rejects a provider that cannot speak and leaves the chat unchanged', async t => {
  const { repo, chatId, captain, timeline, dispatcher } = setup(t)
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['create_roles'] })
  const before = repo.listParticipants(chatId).length
  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run1',
      callId: 'roster-hermes',
      name: 'create_roles',
      args: { roles: [{ displayName: 'Hermes', provider: 'hermes', prompt: '沉默' }] },
    }),
    /ROOM_ROLE_PROVIDER_NOT_LAUNCHABLE/,
  )
  assert.equal(repo.listParticipants(chatId).length, before)
  assert.equal(timeline.latest(chatId), undefined)
})

test('create_roles can use a provider that can speak even when the room did not start with it', async t => {
  const { repo, roomId, chatId, captain, dispatcher } = setup(t, { providers: ['claude'] })
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['create_roles'] })
  const created = await dispatcher.invoke({
    runId: 'run1',
    callId: 'roster-codex',
    name: 'create_roles',
    args: { roles: [{ displayName: '实现', provider: 'codex', prompt: '改代码' }] },
  })
  assert.equal(repo.getRole(created.roleIds[0]).provider, 'codex')
  assert.equal(repo.getRole(created.roleIds[0]).nativePermission, 'danger-full-access')
  assert.deepEqual(repo.getRoom(roomId).providers, ['claude', 'codex'])
})

test('rename_chat stores one sentence and then respects a user lock', async t => {
  const { roomDb, repo, chatId, captain, dispatcher } = setup(t)
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['rename_chat'] })
  const renamed = await dispatcher.invoke({
    runId: 'run1',
    callId: 'rename-1',
    name: 'rename_chat',
    args: { title: 'Plan the snake page' },
  })
  assert.deepEqual(renamed, { renamed: true, title: 'Plan the snake page', locked: false })
  assert.equal(repo.getChat(chatId).title, 'Plan the snake page')

  roomDb.database.prepare('UPDATE chats SET title_locked = 1 WHERE id = ?').run(chatId)
  const locked = await dispatcher.invoke({
    runId: 'run1',
    callId: 'rename-2',
    name: 'rename_chat',
    args: { title: 'A different name' },
  })
  assert.equal(locked.renamed, false)
  assert.equal(locked.locked, true)
  assert.equal(repo.getChat(chatId).title, 'Plan the snake page')
})

test('create_roles rejects a caller that is not the captain', async t => {
  const { repo, chatId, dispatcher } = setup(t)
  const worker = repo.createRole({ chatId, displayName: 'Worker', provider: 'codex', prompt: 'work' })
  repo.addParticipant({ chatId, roleId: worker })
  dispatcher.bindRun('run1', { chatId, roleId: worker, allowedTools: ['create_roles'] })
  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run1',
      callId: 'roster-worker',
      name: 'create_roles',
      args: { roles: [{ displayName: '实现', provider: 'codex', prompt: '改代码' }] },
    }),
    /ROOM_CAPTAIN_REQUIRED/,
  )
})
