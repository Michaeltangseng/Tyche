const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createUsageReport } = require('../../src/room/usage-report.cjs')

function usage(input, output, extra = {}) {
  return JSON.stringify({
    usage: {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: 0,
      context: { percent: 2 },
      ...extra,
    },
  })
}

test('aggregates persisted message usage and persists budget settings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-usage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateRoot = path.join(directory, 'private')
  fs.mkdirSync(privateRoot, { recursive: true })
  const roomDb = openRoomDatabase({ directory: path.join(directory, 'room') })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'snake', workspace: directory, providers: ['claude'] })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const role = repo.createRole({ chatId, displayName: 'Claude', provider: 'claude', prompt: 'p' })
  const now = new Date('2026-11-22T12:00:00.000Z')
  const insert = roomDb.database.prepare(`
    INSERT INTO messages (id, chat_id, seq, author_type, author_id, status, data_json, created_at)
    VALUES (?, ?, ?, 'agent', ?, ?, ?, ?)
  `)
  insert.run('m1', chatId, 1, role, 'done', usage(1000, 500), '2026-11-22T10:00:00.000Z')
  insert.run('m2', chatId, 2, role, 'stopped', usage(2000, 1000), '2026-11-22T11:00:00.000Z')
  insert.run('m3', chatId, 3, role, 'done', usage(9000, 9000), '2020-01-01T00:00:00.000Z')
  insert.run('m4', chatId, 4, role, 'done', '{}', '2026-11-22T11:30:00.000Z')

  const report = createUsageReport({ roomDb, privateRoot, now: () => now })
  const month = report.report('month')
  assert.equal(month.totals.turns, 2)
  assert.equal(month.totals.interrupted, 1)
  assert.equal(month.totals.tokens, 4500)
  assert.equal(month.totals.estimated, true)
  assert.equal(Math.round(month.totals.costUsd * 1e6) / 1e6, 0.0315)
  assert.equal(month.agents[0].provider, 'claude')
  assert.equal(month.agents[0].tokens, 4500)
  assert.equal(month.rooms[0].name, 'snake')
  assert.equal(month.rooms[0].costUsd, month.totals.costUsd)
  assert.equal(month.rooms[0].providers.claude.tokens, 4500)
  assert.equal(month.agents[0].rooms[roomId].costUsd, month.totals.costUsd)
  assert.equal(month.series.length, 22)

  const saved = report.updateSettings({ monthlyBudgetUsd: 0.01, warnAtPercent: 70 })
  assert.equal(saved.monthlyBudgetUsd, 0.01)
  assert.equal(saved.warnAtPercent, 70)
  assert.equal(report.settings().monthlyBudgetUsd, 0.01)
  assert.equal(JSON.parse(fs.readFileSync(path.join(privateRoot, 'usage-settings.json'), 'utf8')).monthlyBudgetUsd, 0.01)

  const withBudget = report.report('month')
  assert.equal(withBudget.budget.enforced, false)
  assert.equal(withBudget.budget.warn, true)
  roomDb.close()
})

test('an empty range still returns a zeroed series and agents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-usage-empty-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateRoot = path.join(directory, 'private')
  fs.mkdirSync(privateRoot, { recursive: true })
  const roomDb = openRoomDatabase({ directory: path.join(directory, 'room') })
  const report = createUsageReport({ roomDb, privateRoot, now: () => new Date('2026-11-22T12:00:00.000Z') })
  const today = report.report('today')
  assert.equal(today.totals.costUsd, 0)
  assert.equal(today.totals.tokens, 0)
  assert.equal(today.series.length, 1)
  assert.deepEqual(today.agents, [])
  assert.equal(today.budget.enforced, false)
  roomDb.close()
})
