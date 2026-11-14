const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ATTRIBUTES_LINE,
  MANAGED_EXCLUDE_MARKER,
  ShadowRepo,
  checkGitVersion,
  encodeId,
} = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-invocation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('encodeId is a full lowercase SHA-256 hex string', () => {
  const value = encodeId('cp:1:0')
  assert.match(value, /^[a-f0-9]{64}$/)
  assert.equal(value, encodeId('cp:1:0'))
  assert.notEqual(value, encodeId('cp:1:1'))
})

test('git passes the shadow repository arguments and a scrubbed environment', async () => {
  const calls = []
  const repo = new ShadowRepo({
    gitDir: '/tmp/shadow.git',
    workTree: '/tmp/work',
    execFileFn: async (file, args, options) => {
      calls.push({ file, args, options })
      return { stdout: '', stderr: '' }
    },
  })
  const previousGitDir = process.env.GIT_DIR
  process.env.GIT_DIR = '/should-not-leak'
  try {
    await repo.git(['status'], { input: 'input', indexFile: '/tmp/index' })
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousGitDir
  }
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.file, 'git')
  assert.ok(call.args.includes('--git-dir=/tmp/shadow.git'))
  assert.ok(call.args.includes('--work-tree=/tmp/work'))
  assert.ok(call.args.includes('core.hooksPath=/dev/null'))
  assert.ok(call.args.includes('core.autocrlf=false'))
  assert.ok(call.args.includes('core.fileMode=true'))
  assert.ok(call.args.includes('core.symlinks=true'))
  assert.ok(call.args.includes('core.quotepath=false'))
  assert.ok(call.args.includes('core.fsmonitor=false'))
  assert.ok(call.args.includes('gc.auto=0'))
  assert.equal('GIT_DIR' in call.options.env, false)
  assert.equal(call.options.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(call.options.env.GIT_INDEX_FILE, '/tmp/index')
  assert.equal(call.options.input, 'input')
  assert.equal(call.options.shell, undefined)
})

test('a created shadow repository has raw-byte attributes and fixed excludes', async (t) => {
  const directory = fixture(t)
  const workTree = path.join(directory, 'work')
  const gitDir = path.join(directory, 'shadow.git')
  fs.mkdirSync(workTree)
  const repo = await ShadowRepo.create({ gitDir, workTree })
  assert.equal(fs.readFileSync(path.join(gitDir, 'info', 'attributes'), 'utf8'), ATTRIBUTES_LINE)
  const exclude = fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')
  assert.match(exclude, /^\.git$/m)
  assert.match(exclude, /^node_modules\/$/m)
  assert.match(exclude, /^\.DS_Store$/m)
  assert.ok(exclude.includes(MANAGED_EXCLUDE_MARKER))

  const autocrlf = await repo.git(['config', '--get', 'core.autocrlf'])
  assert.equal(autocrlf.stdout.trim(), 'false')
  const hooks = await repo.git(['config', '--get', 'core.hooksPath'])
  assert.equal(hooks.stdout.trim(), '/dev/null')
})

test('the user global git configuration does not affect the shadow repository', async (t) => {
  const directory = fixture(t)
  const home = path.join(directory, 'home')
  const workTree = path.join(directory, 'work')
  const gitDir = path.join(directory, 'shadow.git')
  fs.mkdirSync(home)
  fs.mkdirSync(workTree)
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[core]',
    '  autocrlf = true',
    '[user]',
    '  name = Outside User',
    '  email = outside@example.com',
    '',
  ].join('\n'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const repo = await ShadowRepo.create({ gitDir, workTree })
    const name = await repo.git(['config', '--get', 'user.name'])
    assert.equal(name.stdout.trim(), 'Meldwork')
    const autocrlf = await repo.git(['config', '--get', 'core.autocrlf'])
    assert.equal(autocrlf.stdout.trim(), 'false')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('encoded ids are valid reference names', async (t) => {
  const directory = fixture(t)
  const workTree = path.join(directory, 'work')
  const gitDir = path.join(directory, 'shadow.git')
  fs.mkdirSync(workTree)
  const repo = await ShadowRepo.create({ gitDir, workTree })
  const tree = (await repo.git(['write-tree'])).stdout.trim()
  const commit = (await repo.git(['commit-tree', tree, '-m', 'test'])).stdout.trim()
  const ref = `refs/meldwork/effects/${encodeId('cp:1:0')}`
  await repo.git(['update-ref', ref, commit])
  const refs = await repo.git(['show-ref'])
  assert.match(refs.stdout, new RegExp(ref))
})

test('withLock serializes operations in arrival order', async (t) => {
  const directory = fixture(t)
  const repo = new ShadowRepo({
    gitDir: path.join(directory, 'shadow.git'),
    workTree: directory,
  })
  const order = []
  const first = repo.withLock(async () => {
    order.push('first-start')
    await new Promise(resolve => setTimeout(resolve, 20))
    order.push('first-end')
  })
  const second = repo.withLock(async () => {
    order.push('second-start')
    await new Promise(resolve => setTimeout(resolve, 1))
    order.push('second-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('checkGitVersion requires git 2.32 or newer', async () => {
  const current = await checkGitVersion('git')
  assert.equal(current.ok, true)
  assert.equal(typeof current.version, 'string')
  const older = await checkGitVersion('git', {
    execFileFn: async () => ({ stdout: 'git version 2.31.1\n', stderr: '' }),
  })
  assert.equal(older.ok, false)
  const newer = await checkGitVersion('git', {
    execFileFn: async () => ({ stdout: 'git version 2.40.0\n', stderr: '' }),
  })
  assert.equal(newer.ok, true)
  assert.equal(newer.version, '2.40')
})
