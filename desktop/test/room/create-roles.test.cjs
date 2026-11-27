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

function setup(t, { providers = ['claude', 'codex', 'hermes'], onUnavailable = null, rosterWaitsForInstruction = () => true } = {}) {
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
  const canLaunch = provider => provider !== 'hermes'
  const captainAssignment = createCaptainAssignment({
    roomDb,
    repository: repo,
    timeline,
    queueReply: input => {
      queued.push(input)
      return { id: `reply-${queued.length}` }
    },
    requestTick: () => {},
    canLaunch,
    onUnavailable,
  })
  registerCaptainTools({
    dispatcher,
    repository: repo,
    captainAssignment,
    timeline,
    roomDb,
    canLaunch,
    onUnavailable,
    rosterWaitsForInstruction,
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
  assert.notEqual(roles[0].portrait, roles[1].portrait)
  assert.match(roles[0].portrait, /^(0[1-9]|1[0-2])$/)
  assert.match(roles[1].portrait, /^(0[1-9]|1[0-2])$/)
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

test('create_roles repeats a portrait only after every mascot is already in use', async t => {
  const { chatId, captain, dispatcher, repo } = setup(t)
  for (const portrait of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
    const roleId = repo.createRole({
      chatId, displayName: `已有${portrait}`, provider: 'codex', prompt: '已有', portrait,
    })
    repo.addParticipant({ chatId, roleId })
  }
  dispatcher.bindRun('run-full', { chatId, roleId: captain, allowedTools: ['create_roles'] })
  const created = await dispatcher.invoke({
    runId: 'run-full',
    callId: 'roster-full',
    name: 'create_roles',
    args: { roles: [{ displayName: '后来者', provider: 'claude', prompt: '继续' }] },
  })
  assert.match(repo.getRole(created.roleIds[0]).portrait, /^(0[1-9]|1[0-2])$/)
})

test('create_roles can assign in the same turn when the preference does not wait', async t => {
  const { chatId, captain, dispatcher, queued } = setup(t, { rosterWaitsForInstruction: () => false })
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['create_roles', 'assign_in_group'] })
  const created = await dispatcher.invoke({
    runId: 'run1',
    callId: 'roster-1',
    name: 'create_roles',
    args: { roles: [{ displayName: '实现', provider: 'codex', prompt: '改代码' }] },
  })
  await dispatcher.invoke({
    runId: 'run1',
    callId: 'assign-1',
    name: 'assign_in_group',
    args: { text: '开始', roleIds: [created.roleIds[0]] },
  })
  assert.equal(queued.length, 1)
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

test('create_roles reports an unavailable provider to the user', async t => {
  const reports = []
  const { chatId, captain, dispatcher } = setup(t, {
    onUnavailable: payload => reports.push(payload),
  })
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['create_roles'] })
  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run1',
      callId: 'roster-kimi',
      name: 'create_roles',
      args: { roles: [{ displayName: '笑匠丙', provider: 'hermes', prompt: '收尾' }] },
    }),
    /ROOM_ROLE_PROVIDER_NOT_LAUNCHABLE/,
  )
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0].roles, [{
    id: '',
    displayName: '笑匠丙',
    provider: 'hermes',
  }])
  assert.equal(reports[0].requestedBy, captain)
})

test('assign_in_group reports an unavailable teammate instead of queuing', async t => {
  const reports = []
  const { repo, chatId, captain, timeline, dispatcher, queued } = setup(t, {
    onUnavailable: payload => reports.push(payload),
  })
  const hermes = repo.createRole({ chatId, displayName: '笑匠丙', provider: 'hermes', prompt: '收尾' })
  repo.addParticipant({ chatId, roleId: hermes })
  dispatcher.bindRun('run1', { chatId, roleId: captain, allowedTools: ['assign_in_group'] })
  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run1',
      callId: 'assign-kimi',
      name: 'assign_in_group',
      args: { text: '收尾', roleIds: [hermes] },
    }),
    /ROOM_CAPTAIN_TARGET_UNAVAILABLE/,
  )
  assert.equal(queued.length, 0)
  assert.equal(timeline.latest(chatId), undefined)
  assert.equal(reports.length, 1)
  assert.deepEqual(
    reports[0].roles.map(role => ({ id: role.id, displayName: role.displayName, provider: role.provider })),
    [{ id: hermes, displayName: '笑匠丙', provider: 'hermes' }],
  )
  assert.equal(reports[0].requestedBy, captain)
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

test('create_roles stores only skills the inventory accepts and writes nothing when one is rejected', async t => {
  const { roomDb, repo, chatId, captain, timeline, dispatcher } = setup(t)
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
    selectSkills: (provider, ids) => {
      if (provider !== 'claude' || ids.some(id => id !== 'claude/global/frontend-design')) {
        throw new Error('SKILL_INVENTORY_SELECTION_INVALID')
      }
      return ids
    },
  })
  dispatcher.bindRun('run-skills', { chatId, roleId: captain, allowedTools: ['create_roles'] })
  await assert.rejects(
    () => dispatcher.invoke({
      runId: 'run-skills',
      callId: 'bad-skill',
      name: 'create_roles',
      args: { roles: [{ displayName: '实现', provider: 'codex', prompt: '改代码', skills: ['claude/global/frontend-design'] }] },
    }),
    /ROOM_ROLE_SKILL_NOT_AVAILABLE/,
  )
  assert.equal(repo.listParticipants(chatId).length, 1)
  const created = await dispatcher.invoke({
    runId: 'run-skills',
    callId: 'good-skill',
    name: 'create_roles',
    args: { roles: [{ displayName: '设计', provider: 'claude', prompt: '做界面', skills: ['claude/global/frontend-design'] }] },
  })
  assert.deepEqual(repo.getRole(created.roleIds[0]).skills, ['claude/global/frontend-design'])
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
