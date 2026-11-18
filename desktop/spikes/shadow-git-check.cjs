#!/usr/bin/env node
'use strict'

// 里程碑 0 任务 0.7：影子仓库实测（M4/M6 B1、B3、B3.4、B3.5）。
//
// 在 os.tmpdir() 下构造三组临时工作目录：
//   1) 10 万个小文件（本机没有 10 万文件的真实仓库，使用合成目录）；
//   2) 60 MB 大二进制文件（超过 B3.4 的 50 MB 单文件上限，走占位条目）；
//   3) 模拟 LFS（本机未安装 git-lfs，用 .gitattributes 的 filter=lfs 判定，
//      不执行真实的 LFS smudge/clean）。
//
// 每组按 M4/M6 B1 的参数创建影子 git 仓库，执行 B3.1 的快照步骤，记录：
//   首次快照、无改动快照、改动 10 个文件后的快照用时；影子仓库磁盘占用。
// 另外验证 info/attributes 的原始字节行为，以及 git >= 2.32。
//
// 用法：node shadow-git-check.cjs [--keep]

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const KEEP = process.argv.includes('--keep')
const LARGE_FILE_BYTES = 60 * 1024 * 1024
const SINGLE_FILE_LIMIT = 50 * 1024 * 1024
const SMALL_FILE_COUNT = 100000

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function gitEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function git(gitDir, workTree, args, { input } = {}) {
  const fullArgs = [
    `--git-dir=${gitDir}`,
    `--work-tree=${workTree}`,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.autocrlf=false',
    '-c', 'core.fileMode=true',
    '-c', 'core.symlinks=true',
    '-c', 'core.quotepath=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'gc.auto=0',
    '-c', 'user.name=Tyche',
    '-c', 'user.email=tyche@localhost',
    ...args,
  ]
  return execFileSync('git', fullArgs, {
    env: gitEnv(),
    input,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
}

function gitBuffer(gitDir, workTree, args) {
  return execFileSync('git', [
    `--git-dir=${gitDir}`,
    `--work-tree=${workTree}`,
    ...args,
  ], {
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
}

function encodeId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex')
}

function createShadow(baseDir, name, root) {
  const shadow = path.join(baseDir, `${name}.shadow.git`)
  fs.mkdirSync(shadow, { recursive: true })
  git(shadow, root, ['init', '--quiet'])
  git(shadow, root, ['config', 'core.bare', 'false'])
  fs.writeFileSync(
    path.join(shadow, 'info', 'attributes'),
    '* -text -eol -filter -ident -working-tree-encoding\n',
  )
  writeExclude(shadow, [])
  return shadow
}

function writeExclude(shadow, placeholderPaths) {
  const fixed = ['.git', 'node_modules/', '.DS_Store']
  const lines = [...fixed, ...placeholderPaths]
  fs.writeFileSync(path.join(shadow, 'info', 'exclude'), `${lines.join('\n')}\n`)
}

function pathSize(filename) {
  try {
    return fs.lstatSync(filename).size
  } catch {
    return 0
  }
}

function isLfsPath(root, relativePath) {
  try {
    const output = execFileSync('git', ['-C', root, 'check-attr', '-z', '--stdin', 'filter'], {
      input: `${relativePath}\0`,
      env: gitEnv(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return output.includes('\0lfs\0') || output.endsWith('\0lfs')
  } catch {
    return false
  }
}

function placeholderText({ reason, mode, size, sha256 }) {
  return [
    'tyche-placeholder 1',
    `reason ${reason}`,
    `mode ${mode}`,
    `size ${size}`,
    `sha256 ${sha256}`,
    '',
  ].join('\n')
}

function snapshot(root, shadow, effectId, { placeholderCandidates = [] } = {}) {
  const startedAt = nowMs()
  const placeholders = []
  for (const relativePath of placeholderCandidates) {
    const filename = path.join(root, relativePath)
    let stat
    try { stat = fs.lstatSync(filename) } catch { continue }
    if (!stat.isFile()) continue
    const lfs = isLfsPath(root, relativePath)
    if (!lfs && stat.size <= SINGLE_FILE_LIMIT) continue
    const content = fs.readFileSync(filename)
    placeholders.push({
      path: relativePath,
      reason: lfs ? 'lfs' : 'oversize',
      mode: stat.mode & 0o111 ? '100755' : '100644',
      size: stat.size,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    })
  }
  if (placeholders.length) {
    git(shadow, root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...placeholders.map((item) => item.path)])
    writeExclude(shadow, placeholders.map((item) => item.path))
  } else {
    writeExclude(shadow, [])
  }

  git(shadow, root, ['add', '-A'])
  for (const placeholder of placeholders) {
    const text = placeholderText(placeholder)
    const object = git(shadow, root, ['hash-object', '-w', '--stdin'], { input: text }).trim()
    git(shadow, root, ['update-index', '--add', '--cacheinfo', `${placeholder.mode},${object},${placeholder.path}`])
  }
  const tree = git(shadow, root, ['write-tree']).trim()
  const commit = git(shadow, root, ['commit-tree', tree, '-m', `spike:${effectId}`]).trim()
  const ref = `refs/tyche/effects/${encodeId(effectId)}`
  git(shadow, root, ['update-ref', ref, commit])
  return {
    effectId,
    commit,
    tree,
    placeholders,
    elapsedMs: nowMs() - startedAt,
  }
}

function diskUsageKb(gitDir) {
  try {
    const output = execFileSync('du', ['-sk', gitDir], { encoding: 'utf8' })
    return Number(output.split(/\s+/)[0]) || 0
  } catch {
    return null
  }
}

function fileCount(root) {
  try {
    const output = execFileSync('find', [root, '-type', 'f', '-not', '-path', '*/.git/*'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return output.split('\n').filter(Boolean).length
  } catch {
    return null
  }
}

function makeSmallFilesRepo(root) {
  for (let directory = 0; directory < 100; directory += 1) {
    const dir = path.join(root, `d${String(directory).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let file = 0; file < SMALL_FILE_COUNT / 100; file += 1) {
      fs.writeFileSync(
        path.join(dir, `f${String(file).padStart(5, '0')}.txt`),
        `file ${directory}/${file}\n${'x'.repeat(80)}\n`,
      )
    }
  }
}

function measureSmallFiles(baseDir) {
  const root = path.join(baseDir, 'small-files')
  const startedSetup = nowMs()
  makeSmallFilesRepo(root)
  const setupMs = nowMs() - startedSetup
  const count = fileCount(root)
  const shadow = createShadow(baseDir, 'small-files', root)
  const first = snapshot(root, shadow, 'small-first')
  const second = snapshot(root, shadow, 'small-second')
  for (let index = 0; index < 10; index += 1) {
    const file = path.join(root, 'd00', `f${String(index).padStart(5, '0')}.txt`)
    fs.appendFileSync(file, `changed ${index}\n`)
  }
  const changed = snapshot(root, shadow, 'small-changed')
  const beforeGcKb = diskUsageKb(shadow)
  const gcStarted = nowMs()
  git(shadow, root, ['gc', '--prune=now'])
  const gcMs = nowMs() - gcStarted
  const result = {
    root,
    setupMs,
    fileCount: count,
    first,
    second,
    changed,
    diskUsageKb: beforeGcKb,
    gcMs,
    diskUsageKbAfterGc: diskUsageKb(shadow),
  }
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true })
  return result
}

function measureLargeBinary(baseDir) {
  const root = path.join(baseDir, 'large-binary')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# large binary\n')
  fs.writeFileSync(path.join(root, 'large.bin'), crypto.randomBytes(LARGE_FILE_BYTES))
  const shadow = createShadow(baseDir, 'large-binary', root)
  const first = snapshot(root, shadow, 'large-first', { placeholderCandidates: ['large.bin'] })
  const placeholderBlob = gitBuffer(shadow, root, ['cat-file', 'blob', `${first.commit}:large.bin`]).toString('utf8')
  const second = snapshot(root, shadow, 'large-second', { placeholderCandidates: ['large.bin'] })
  const result = {
    root,
    fileBytes: LARGE_FILE_BYTES,
    first,
    second,
    placeholderIsText: placeholderBlob.includes('tyche-placeholder 1'),
    placeholderBlob: placeholderBlob.slice(0, 300),
    diskUsageKb: diskUsageKb(shadow),
  }
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true })
  return result
}

function measureLfs(baseDir) {
  const root = path.join(baseDir, 'lfs')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  fs.writeFileSync(path.join(root, 'asset.bin'), crypto.randomBytes(4096))
  execFileSync('git', ['init', '--quiet'], { cwd: root, env: gitEnv() })
  const shadow = createShadow(baseDir, 'lfs', root)
  const first = snapshot(root, shadow, 'lfs-first', { placeholderCandidates: ['asset.bin'] })
  const placeholderBlob = gitBuffer(shadow, root, ['cat-file', 'blob', `${first.commit}:asset.bin`]).toString('utf8')
  const second = snapshot(root, shadow, 'lfs-second', { placeholderCandidates: ['asset.bin'] })
  const result = {
    root,
    first,
    second,
    placeholderIsText: placeholderBlob.includes('tyche-placeholder 1'),
    placeholderBlob: placeholderBlob.slice(0, 300),
    diskUsageKb: diskUsageKb(shadow),
  }
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true })
  return result
}

function measureRawBytes(baseDir) {
  const root = path.join(baseDir, 'raw-bytes')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt text eol=lf\n')
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'A\r\nB\r\n')
  const shadow = createShadow(baseDir, 'raw-bytes', root)
  const first = snapshot(root, shadow, 'raw-first')
  const crlfBlob = gitBuffer(shadow, root, ['cat-file', 'blob', `${first.commit}:crlf.txt`])
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'A\nB\n')
  const second = snapshot(root, shadow, 'raw-second')
  let diffExit = 0
  try {
    git(shadow, root, ['diff', '--quiet', first.commit, second.commit, '--', 'crlf.txt'])
  } catch (error) {
    diffExit = error.status == null ? -1 : error.status
  }
  const result = {
    root,
    storedHasCrlf: crlfBlob.includes(Buffer.from('\r\n')),
    storedBytes: [...crlfBlob],
    diffExitAfterLineEndingChange: diffExit,
    changedDetected: diffExit !== 0,
  }
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true })
  return result
}

function main() {
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-shadow-spike-'))
  const summary = {
    gitVersion,
    meetsMinimumGit: (() => {
      const match = gitVersion.match(/(\d+)\.(\d+)/)
      return Boolean(match) && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 32))
    })(),
    limits: { snapshotMs: 60000, files: 200000, singleFileBytes: SINGLE_FILE_LIMIT },
    baseDir,
    smallFiles: null,
    largeBinary: null,
    lfs: null,
    rawBytes: null,
  }
  try {
    process.stderr.write('measuring small files\n')
    summary.smallFiles = measureSmallFiles(baseDir)
    process.stderr.write('measuring large binary\n')
    summary.largeBinary = measureLargeBinary(baseDir)
    process.stderr.write('measuring lfs\n')
    summary.lfs = measureLfs(baseDir)
    process.stderr.write('measuring raw bytes\n')
    summary.rawBytes = measureRawBytes(baseDir)
  } finally {
    if (!KEEP) fs.rmSync(baseDir, { recursive: true, force: true })
  }
  console.log(JSON.stringify(summary, null, 2))
}

main()
