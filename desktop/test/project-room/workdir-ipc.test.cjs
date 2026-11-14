const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerWorkdirIpc } = require('../../src/shell/workdir-ipc.cjs')

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workdir-ipc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'readme.md'), 'hello world\n')
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]))
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'config'), 'git config\n')
  const state = {
    instances: [{
      id: 'cp-1',
      state: 'gate',
      candidate: 'c'.repeat(40),
      artifactVersions: [{ id: 'version-1', commit: 'a'.repeat(40), files: ['readme.md'] }],
    }],
    placeholders: [],
  }
  const shadowRepo = {
    numstat: async () => [{ path: 'readme.md', added: 1, removed: 0, binary: false }],
    entriesAtCommit: async () => ({
      'readme.md': { kind: 'file', mode: '100644', sha256: 'old-hash' },
    }),
    fileDiff: async () => ({ text: 'diff --git a/readme.md b/readme.md', truncated: false }),
    ...overrides.shadowRepo,
  }
  const service = {
    contextFor: () => ({
      project: { workdir: root },
      shadowRepo,
      store: { current: () => state },
    }),
    snapshot: () => ({
      progress: [{
        checkpointId: 'cp-1',
        name: 'Requirements',
        state: 'accepted',
        hasPendingVersion: true,
        acceptedVersion: {
          id: 'version-1',
          files: ['readme.md', 'docs/plan.md'],
          acceptedAt: '2026-11-14T08:00:00.000Z',
        },
      }],
    }),
    ...overrides.service,
  }
  const handlers = new Map()
  registerWorkdirIpc({
    registerTrustedHandle: (channel, handler) => { handlers.set(channel, handler) },
    getProjectService: () => service,
  })
  return { root, handlers, state }
}

test('workdir IPC lists directories and marks .git metadata', async (t) => {
  const { handlers } = setup(t)
  const result = await handlers.get('workdir:list')({ projectId: 'project-1', relPath: '' })
  const git = result.entries.find(entry => entry.name === '.git')
  assert.equal(git.kind, 'metadata')
  assert.equal(result.hasMore, false)
})

test('workdir IPC reads text, binary, and image previews', async (t) => {
  const { handlers } = setup(t)
  const text = await handlers.get('workdir:read')({
    projectId: 'project-1', relPath: 'readme.md', length: 5,
  })
  assert.equal(text.kind, 'text')
  assert.equal(text.text, 'hello')
  assert.equal(text.eof, false)
  const rest = await handlers.get('workdir:read')({
    projectId: 'project-1', relPath: 'readme.md', offset: 5, length: 100,
  })
  assert.equal(rest.text, ' world\n')
  assert.equal(rest.eof, true)
  const binary = await handlers.get('workdir:read')({
    projectId: 'project-1', relPath: 'binary.bin',
  })
  assert.equal(binary.kind, 'binary')
  const image = await handlers.get('workdir:read')({
    projectId: 'project-1', relPath: 'image.png',
  })
  assert.equal(image.kind, 'image')
  assert.equal(image.mime, 'image/png')
})

test('workdir IPC rejects .git and traversal', async (t) => {
  const { handlers } = setup(t)
  await assert.rejects(
    handlers.get('workdir:read')({ projectId: 'project-1', relPath: '.git/config' }),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
  await assert.rejects(
    handlers.get('workdir:list')({ projectId: 'project-1', relPath: '../' }),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
})

test('workdir IPC returns diff data and describePathChange output', async (t) => {
  const { handlers } = setup(t)
  const result = await handlers.get('workdir:diff')({
    projectId: 'project-1',
    relPath: 'readme.md',
    against: { kind: 'candidate', checkpointId: 'cp-1' },
  })
  assert.equal(result.change.change, 'content-changed')
  assert.equal(result.change.diffAvailable, true)
  assert.equal(result.diff.text, 'diff --git a/readme.md b/readme.md')
  assert.equal(result.numstat.added, 1)
})

test('workdir IPC exposes accepted documents from the project snapshot', async (t) => {
  const { handlers } = setup(t)
  const result = await handlers.get('workdir:acceptedDocuments')({ projectId: 'project-1' })
  assert.equal(result.documents.length, 1)
  assert.equal(result.documents[0].name, 'Requirements')
  assert.deepEqual(result.documents[0].files, ['readme.md', 'docs/plan.md'])
  assert.equal(result.documents[0].hasPendingVersion, true)
  assert.equal(result.documents[0].stale, false)
})

test('workdir IPC returns PROJECT_NOT_FOUND for unknown projects', async (t) => {
  const { handlers } = setup(t, {
    service: { contextFor: () => null },
  })
  await assert.rejects(
    handlers.get('workdir:list')({ projectId: 'missing', relPath: '' }),
    { code: 'PROJECT_NOT_FOUND' },
  )
})
