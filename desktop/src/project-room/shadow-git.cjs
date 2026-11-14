const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ATTRIBUTES_LINE = '* -text -eol -filter -ident -working-tree-encoding\n'
const FIXED_EXCLUDES = Object.freeze(['.git', 'node_modules/', '.DS_Store'])
const MANAGED_EXCLUDE_MARKER = '# meldwork: managed placeholders'
const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({
  maxDurationMs: 60000,
  maxFiles: 200000,
  maxFileBytes: 50 * 1024 * 1024,
})

function shadowError(code, cause) {
  const error = Object.assign(new Error(code), { code })
  if (cause) error.cause = cause
  return error
}

function encodeId(id) {
  return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex')
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: options.encoding === undefined ? 'utf8' : options.encoding,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
    if (options.input == null) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

function gitEnvironment(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return { ...env, ...extra }
}

function writeExclude(gitDir, placeholderPaths = []) {
  const infoDirectory = path.join(gitDir, 'info')
  fs.mkdirSync(infoDirectory, { recursive: true })
  const lines = [
    ...FIXED_EXCLUDES,
    MANAGED_EXCLUDE_MARKER,
    ...placeholderPaths,
  ]
  fs.writeFileSync(path.join(infoDirectory, 'exclude'), `${lines.join('\n')}\n`)
}

function normalizeShadowPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function parseStatusPaths(output) {
  const paths = []
  const tokens = String(output || '').split('\0').filter(Boolean)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const type = token[0]
    if (type === '?' || type === '!') {
      if (token[1] === ' ') paths.push(token.slice(2))
      continue
    }
    if (type === '1') {
      const fields = token.split(' ')
      if (fields.length >= 9) paths.push(fields.slice(8).join(' '))
      continue
    }
    if (type === '2') {
      const fields = token.split(' ')
      if (fields.length >= 10) paths.push(fields.slice(9).join(' '))
      index += 1
      continue
    }
    if (type === 'u') {
      const fields = token.split(' ')
      if (fields.length >= 11) paths.push(fields.slice(10).join(' '))
    }
  }
  return paths
}

function statRecord(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    recordedAt: Date.now(),
  }
}

function sameStat(previous, current) {
  return previous
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => previous[key] === current[key])
}

function placeholderSha256(filename, stat, previous) {
  const current = statRecord(stat)
  if (previous && previous.stat && previous.sha256 && sameStat(previous.stat, current)) {
    const recordedAt = Number(previous.stat.recordedAt)
    const notRacy = Number.isFinite(recordedAt)
      && Math.abs(recordedAt - Number(previous.stat.mtimeMs)) >= 2000
      && Math.abs(recordedAt - Number(previous.stat.ctimeMs)) >= 2000
    if (notRacy) return previous.sha256
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function placeholderText(entry) {
  return [
    'meldwork-placeholder 1',
    `reason ${entry.reason}`,
    `mode ${entry.mode}`,
    `size ${entry.size}`,
    `sha256 ${entry.sha256}`,
    '',
  ].join('\n')
}

function parseLsTreeEntry(output) {
  const text = String(output || '')
  const tab = text.indexOf('\t')
  if (tab < 0) return null
  const fields = text.slice(0, tab).split(' ')
  if (fields.length < 3) return null
  return {
    mode: fields[0],
    type: fields[1],
    object: fields[2],
    path: text.slice(tab + 1).replace(/\0$/, ''),
  }
}

function parseLfsPaths(output) {
  const paths = new Set()
  const tokens = String(output || '').split('\0')
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const relative = normalizeShadowPath(tokens[index])
    const attribute = tokens[index + 1]
    const value = tokens[index + 2]
    if (relative && attribute === 'filter' && value === 'lfs') paths.add(relative)
  }
  return paths
}

class ShadowRepo {
  constructor({ gitDir, workTree, gitExecutable = 'git', execFileFn, excludePaths = [] } = {}) {
    if (typeof gitDir !== 'string' || !gitDir) throw shadowError('SHADOW_GIT_DIRECTORY_REQUIRED')
    if (typeof workTree !== 'string' || !workTree) throw shadowError('SHADOW_WORKTREE_REQUIRED')
    this.gitDir = path.resolve(gitDir)
    this.workTree = path.resolve(workTree)
    this.gitExecutable = gitExecutable
    this.execFileFn = typeof execFileFn === 'function' ? execFileFn : defaultExecFile
    this.excludePaths = Array.isArray(excludePaths)
      ? excludePaths.map(entry => normalizeShadowPath(entry)).filter(Boolean)
      : []
    this.lock = Promise.resolve()
  }

  static async create({ gitDir, workTree, gitExecutable, execFileFn, excludePaths = [] } = {}) {
    if (typeof workTree !== 'string' || !fs.existsSync(workTree)
        || !fs.statSync(workTree).isDirectory()) {
      throw shadowError('SHADOW_WORKTREE_INVALID')
    }
    fs.mkdirSync(path.resolve(gitDir), { recursive: true })
    const repo = new ShadowRepo({ gitDir, workTree, gitExecutable, execFileFn, excludePaths })
    await repo.git(['init', '--quiet'])
    await repo.git(['config', 'core.bare', 'false'])
    fs.mkdirSync(path.join(repo.gitDir, 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo.gitDir, 'info', 'attributes'), ATTRIBUTES_LINE)
    writeExclude(repo.gitDir, repo.excludePaths)
    return repo
  }

  commandArgs(args) {
    return [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.workTree}`,
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.autocrlf=false',
      '-c', 'core.fileMode=true',
      '-c', 'core.symlinks=true',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0',
      '-c', 'user.name=Meldwork',
      '-c', 'user.email=meldwork@localhost',
      ...args,
    ]
  }

  async git(args, { env = {}, input, indexFile } = {}) {
    const extra = { ...env }
    if (indexFile) extra.GIT_INDEX_FILE = indexFile
    return this.execFileFn(this.gitExecutable, this.commandArgs(args), {
      cwd: this.workTree,
      env: gitEnvironment(extra),
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  async gitBuffer(args, { env = {}, input, indexFile } = {}) {
    const extra = { ...env }
    if (indexFile) extra.GIT_INDEX_FILE = indexFile
    return this.execFileFn(this.gitExecutable, this.commandArgs(args), {
      cwd: this.workTree,
      env: gitEnvironment(extra),
      input,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  withLock(operation) {
    if (typeof operation !== 'function') throw shadowError('SHADOW_GIT_LOCK_OPERATION_REQUIRED')
    const run = this.lock.then(() => operation(), () => operation())
    this.lock = run.then(() => undefined, () => undefined)
    return run
  }

  async userGit(args, { input } = {}) {
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_OPTIONAL_LOCKS = '0'
    return this.execFileFn(this.gitExecutable, ['-C', this.workTree, ...args], {
      cwd: this.workTree,
      env,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  async statusPaths() {
    try {
      const { stdout } = await this.git([
        'status', '--porcelain=v2', '-z', '--untracked-files=all',
      ])
      return parseStatusPaths(stdout)
    } catch {
      return []
    }
  }

  async lfsPaths(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return new Set()
    try {
      const inside = await this.userGit(['rev-parse', '--is-inside-work-tree'])
      if (inside.stdout.trim() !== 'true') return new Set()
    } catch {
      return new Set()
    }
    try {
      const input = candidates.map(relative => `${relative}\0`).join('')
      const { stdout } = await this.userGit(['check-attr', '-z', '--stdin', 'filter'], { input })
      return parseLfsPaths(stdout)
    } catch {
      return new Set()
    }
  }

  async snapshot({
    effectId,
    targets = [],
    placeholderList = [],
    limits = {},
    isOptional = false,
  } = {}) {
    if (typeof effectId !== 'string' || !effectId) throw shadowError('SHADOW_EFFECT_ID_REQUIRED')
    const config = { ...DEFAULT_SNAPSHOT_LIMITS, ...(limits || {}) }
    return this.withLock(async () => {
      const started = Date.now()
      const ref = `refs/meldwork/effects/${encodeId(effectId)}`
      try {
        const existing = await this.git(['rev-parse', '--verify', '--quiet', ref])
        const commit = String(existing.stdout || '').trim()
        if (commit) {
          return {
            commit,
            placeholderList: Array.isArray(placeholderList) ? placeholderList : [],
            skipped: false,
          }
        }
      } catch { /* the reference does not exist yet */ }

      const previous = Array.isArray(placeholderList)
        ? placeholderList.filter(entry => entry && typeof entry.path === 'string')
        : []
      const previousByPath = new Map(previous.map(entry => [normalizeShadowPath(entry.path), entry]))
      const statusPaths = await this.statusPaths()
      const candidates = [...new Set([...previousByPath.keys(), ...statusPaths])]
      if (candidates.length > config.maxFiles) {
        if (isOptional) return { skipped: true, reason: 'files', placeholderList: previous }
        throw shadowError('SHADOW_SNAPSHOT_LIMIT')
      }

      const targetSet = new Set(targets.map(normalizeShadowPath).filter(Boolean))
      const targetFiles = []
      for (const target of targetSet) {
        const filename = path.join(this.workTree, target)
        let stat
        try { stat = fs.lstatSync(filename) } catch { continue }
        if (!stat.isFile()) continue
        if (stat.size > config.maxFileBytes) {
          throw Object.assign(shadowError('SHADOW_TARGET_TOO_LARGE'), { file: target })
        }
        targetFiles.push(target)
      }

      const lfs = await this.lfsPaths(candidates)
      const placeholders = []
      const removeFromIndex = []
      for (const relative of candidates) {
        if (targetSet.has(relative)) continue
        const filename = path.join(this.workTree, relative)
        let stat
        try { stat = fs.lstatSync(filename) } catch { continue }
        if (!stat.isFile()) continue
        if (stat.size > config.maxFileBytes || lfs.has(relative)) {
          const previousEntry = previousByPath.get(relative)
          const sha256 = placeholderSha256(filename, stat, previousEntry)
          placeholders.push({
            path: relative,
            reason: lfs.has(relative) ? 'lfs' : 'oversize',
            mode: stat.mode & 0o111 ? '100755' : '100644',
            size: stat.size,
            sha256,
            stat: statRecord(stat),
          })
          removeFromIndex.push(relative)
        }
      }

      writeExclude(this.gitDir, [
        ...this.excludePaths,
        ...placeholders.map(entry => entry.path),
      ])
      if (removeFromIndex.length) {
        await this.git(['rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', ...removeFromIndex])
      }
      await this.git(['add', '-A'])
      if (targetFiles.length) await this.git(['add', '-f', '--', ...targetFiles])
      for (const entry of placeholders) {
        const object = (await this.git(['hash-object', '-w', '--stdin'], {
          input: placeholderText(entry),
        })).stdout.trim()
        await this.git([
          'update-index', '--add', '--cacheinfo',
          `${entry.mode},${object},${entry.path}`,
        ])
      }

      if (Date.now() - started > config.maxDurationMs) {
        if (isOptional) return { skipped: true, reason: 'duration', placeholderList: previous }
        throw shadowError('SHADOW_SNAPSHOT_LIMIT')
      }
      const tree = (await this.git(['write-tree'])).stdout.trim()
      const commit = (await this.git(['commit-tree', tree, '-m', `snapshot:${effectId}`])).stdout.trim()
      await this.git(['update-ref', ref, commit])
      return { commit, placeholderList: placeholders, skipped: false }
    })
  }

  async diffQuiet(a, b, paths = []) {
    const args = ['diff', '--quiet', a, b]
    if (paths.length) args.push('--', ...paths)
    try {
      await this.git(args)
      return true
    } catch (error) {
      if (error.code === 1) return false
      throw error
    }
  }

  async nameStatus(a, b, paths = []) {
    const args = ['diff', '--name-status', '-z', a, b]
    if (paths.length) args.push('--', ...paths)
    const { stdout } = await this.git(args)
    const tokens = String(stdout || '').split('\0').filter(Boolean)
    const entries = []
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++]
      if (!status) continue
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = tokens[index++]
        const newPath = tokens[index++]
        entries.push({ status, path: newPath, oldPath })
      } else {
        entries.push({ status, path: tokens[index++] })
      }
    }
    return entries
  }

  async verifyAgainst({ effectId, commit, paths = [], placeholderList, limits } = {}) {
    const snapshot = await this.snapshot({
      effectId,
      targets: paths,
      placeholderList,
      limits,
    })
    const intact = await this.diffQuiet(commit, snapshot.commit, paths)
    return {
      intact,
      differing: intact
        ? []
        : (await this.nameStatus(commit, snapshot.commit, paths)).map(entry => entry.path),
    }
  }

  async driftCheck({ effectId, acceptedByPath, placeholderList, limits } = {}) {
    const entries = acceptedByPath instanceof Map
      ? [...acceptedByPath.entries()]
      : Object.entries(acceptedByPath || {})
    const paths = entries.map(([relativePath]) => relativePath)
    const snapshot = await this.snapshot({
      effectId,
      targets: paths,
      placeholderList,
      limits,
    })
    const drifted = []
    for (const [relativePath, commit] of entries) {
      const quiet = await this.diffQuiet(commit, snapshot.commit, [relativePath])
      if (!quiet) drifted.push(relativePath)
    }
    return { snapshotCommit: snapshot.commit, drifted }
  }

  async acceptCommit({ effectId, candidate, recordPaths = [], parent, message } = {}) {
    if (typeof effectId !== 'string' || !effectId) throw shadowError('SHADOW_EFFECT_ID_REQUIRED')
    if (typeof candidate !== 'string' || !candidate) throw shadowError('SHADOW_CANDIDATE_REQUIRED')
    const ref = `refs/meldwork/effects/${encodeId(effectId)}`
    try {
      const existing = await this.git(['rev-parse', '--verify', '--quiet', ref])
      const commit = String(existing.stdout || '').trim()
      if (commit) return commit
    } catch { /* the reference does not exist yet */ }
    return this.withLock(async () => {
      const indexFile = path.join(this.gitDir, `accept-${encodeId(effectId)}.index`)
      try {
        await this.git(['read-tree', candidate], { indexFile })
        for (const relative of recordPaths) {
          const filename = path.join(this.workTree, relative)
          let stat
          try { stat = fs.lstatSync(filename) } catch { continue }
          let mode
          let object
          if (stat.isSymbolicLink()) {
            mode = '120000'
            const target = fs.readlinkSync(filename)
            object = (await this.git(['hash-object', '-w', '--stdin'], { input: target })).stdout.trim()
          } else if (stat.isFile()) {
            mode = stat.mode & 0o111 ? '100755' : '100644'
            object = (await this.git(['hash-object', '-w', '--', relative])).stdout.trim()
          } else {
            continue
          }
          await this.git([
            'update-index', '--add', '--cacheinfo',
            `${mode},${object},${relative}`,
          ], { indexFile })
        }
        const tree = (await this.git(['write-tree'], { indexFile })).stdout.trim()
        const args = ['commit-tree', tree]
        if (parent) args.push('-p', parent)
        args.push('-m', message || `accept:${effectId}`)
        const commit = (await this.git(args)).stdout.trim()
        await this.git(['update-ref', ref, commit])
        return commit
      } finally {
        try { fs.rmSync(indexFile, { force: true }) } catch { /* already removed */ }
      }
    })
  }

  async driftAcceptCommit({ effectId, base, observed, paths = [], parent, message } = {}) {
    if (typeof effectId !== 'string' || !effectId) throw shadowError('SHADOW_EFFECT_ID_REQUIRED')
    if (typeof base !== 'string' || !base) throw shadowError('SHADOW_BASE_REQUIRED')
    if (typeof observed !== 'string' || !observed) throw shadowError('SHADOW_OBSERVED_REQUIRED')
    const ref = `refs/meldwork/effects/${encodeId(effectId)}`
    try {
      const existing = await this.git(['rev-parse', '--verify', '--quiet', ref])
      const commit = String(existing.stdout || '').trim()
      if (commit) return commit
    } catch { /* the reference does not exist yet */ }
    return this.withLock(async () => {
      const indexFile = path.join(this.gitDir, `accept-${encodeId(effectId)}.index`)
      try {
        await this.git(['read-tree', base], { indexFile })
        for (const relative of paths) {
          const { stdout } = await this.git(['ls-tree', '-z', observed, '--', relative])
          const entry = parseLsTreeEntry(stdout)
          if (!entry) {
            try {
              await this.git(['update-index', '--force-remove', '--', relative], { indexFile })
            } catch { /* already absent from the base tree */ }
            continue
          }
          await this.git([
            'update-index', '--add', '--cacheinfo',
            `${entry.mode},${entry.object},${relative}`,
          ], { indexFile })
        }
        const tree = (await this.git(['write-tree'], { indexFile })).stdout.trim()
        const args = ['commit-tree', tree]
        if (parent) args.push('-p', parent)
        args.push('-m', message || `drift-accept:${effectId}`)
        const commit = (await this.git(args)).stdout.trim()
        await this.git(['update-ref', ref, commit])
        return commit
      } finally {
        try { fs.rmSync(indexFile, { force: true }) } catch { /* already removed */ }
      }
    })
  }

  async restoreFiles({ commit, paths = [], isCancelled } = {}) {
    if (typeof commit !== 'string' || !commit) throw shadowError('SHADOW_COMMIT_REQUIRED')
    const restored = []
    let stoppedAt = null
    for (const relative of paths) {
      if (typeof isCancelled === 'function' && await isCancelled()) {
        stoppedAt = relative
        break
      }
      const { stdout } = await this.git(['ls-tree', '-z', commit, '--', relative])
      const entry = parseLsTreeEntry(stdout)
      const filename = path.join(this.workTree, relative)
      const directory = path.dirname(filename)
      if (!entry) {
        try { fs.lstatSync(filename) } catch {
          restored.push(relative)
          continue
        }
        const temporary = path.join(directory,
          `.${path.basename(filename)}.meldwork-restore-${crypto.randomBytes(8).toString('hex')}`)
        fs.renameSync(filename, temporary)
        fs.rmSync(temporary, { recursive: true, force: true })
        restored.push(relative)
        continue
      }
      if (entry.mode === '160000') throw shadowError('SHADOW_RESTORE_UNSUPPORTED')
      fs.mkdirSync(directory, { recursive: true })
      if (entry.mode === '120000') {
        const target = (await this.gitBuffer([
          'cat-file', 'blob', `${commit}:${relative}`,
        ])).stdout.toString('utf8')
        const temporary = path.join(directory,
          `.${path.basename(filename)}.meldwork-restore-${crypto.randomBytes(8).toString('hex')}`)
        fs.symlinkSync(target, temporary)
        if (typeof isCancelled === 'function' && await isCancelled()) {
          fs.rmSync(temporary, { force: true })
          stoppedAt = relative
          break
        }
        fs.renameSync(temporary, filename)
        restored.push(relative)
        continue
      }
      const content = (await this.gitBuffer([
        'cat-file', 'blob', `${commit}:${relative}`,
      ])).stdout
      if (content.toString('utf8').startsWith('meldwork-placeholder 1\n')) {
        throw shadowError('SHADOW_PLACEHOLDER_NOT_RESTORABLE')
      }
      const temporary = path.join(directory,
        `.${path.basename(filename)}.meldwork-restore-${crypto.randomBytes(8).toString('hex')}`)
      let descriptor
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600)
        fs.writeSync(descriptor, content)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        if (typeof isCancelled === 'function' && await isCancelled()) {
          fs.rmSync(temporary, { force: true })
          stoppedAt = relative
          break
        }
        fs.renameSync(temporary, filename)
        fs.chmodSync(filename, entry.mode === '100755' ? 0o755 : 0o644)
        restored.push(relative)
      } catch (error) {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor) } catch { /* already closed */ }
        }
        try { fs.rmSync(temporary, { force: true }) } catch { /* already renamed */ }
        throw error
      }
    }
    return { restored, stoppedAt }
  }

  async numstat(a, b, paths = []) {
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', '--numstat', '-z', a, b]
    if (paths.length) args.push('--', ...paths)
    const { stdout } = await this.git(args)
    const tokens = String(stdout || '').split('\0')
    const entries = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (!token) continue
      const first = token.indexOf('\t')
      const second = token.indexOf('\t', first + 1)
      if (first < 0 || second < 0) continue
      const added = token.slice(0, first)
      const removed = token.slice(first + 1, second)
      let relative = token.slice(second + 1)
      let oldPath = null
      if (!relative) {
        oldPath = tokens[index + 1] || ''
        relative = tokens[index + 2] || ''
        index += 2
      }
      entries.push({
        path: relative,
        ...(oldPath == null ? {} : { oldPath }),
        added: added === '-' ? null : Number(added),
        removed: removed === '-' ? null : Number(removed),
        binary: added === '-' && removed === '-',
      })
    }
    return entries
  }

  async fileAtCommit(commit, relative, { maxBytes = 1024 * 1024 } = {}) {
    const text = String(relative || '')
    if (!text || text.startsWith('/') || text.includes('\0')
        || text.split('/').some(segment => segment === '..')) {
      throw shadowError('SHADOW_PATH_INVALID')
    }
    try {
      const { stdout } = await this.git(['show', `${commit}:${text}`])
      const source = String(stdout || '')
      return {
        text: source.slice(0, maxBytes),
        truncated: Buffer.byteLength(source, 'utf8') > maxBytes,
      }
    } catch (error) {
      if (error?.code === 128) return null
      throw error
    }
  }

  async entriesAtCommit(commit, paths = []) {
    const requested = [...new Set((Array.isArray(paths) ? paths : []).map(String))]
    const args = ['ls-tree', '-r', '-z', commit]
    if (requested.length) args.push('--', ...requested)
    const { stdout } = await this.git(args)
    const found = new Map()
    for (const token of String(stdout || '').split('\0')) {
      if (!token) continue
      const tab = token.indexOf('\t')
      if (tab < 0) continue
      const [mode, type, oid] = token.slice(0, tab).split(' ')
      found.set(token.slice(tab + 1), { mode, type, oid })
    }
    const entries = {}
    for (const relative of requested) {
      const entry = found.get(relative)
      if (!entry) {
        entries[relative] = { exists: false }
        continue
      }
      if (entry.type !== 'blob') {
        entries[relative] = { kind: 'other' }
        continue
      }
      const { stdout: content } = await this.gitBuffer(['cat-file', 'blob', entry.oid])
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || '')
      entries[relative] = entry.mode === '120000'
        ? { kind: 'link', target: bytes.toString('utf8') }
        : {
          kind: 'file',
          mode: entry.mode,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        }
    }
    return entries
  }

  async fileDiff(a, b, relative, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', a]
    if (b) args.push(b)
    args.push('--', relative)
    const { stdout } = await this.git(args)
    const text = String(stdout || '')
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length <= maxBytes) return { text, truncated: false }
    return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
  }

  async dropRefs(refNames = []) {
    for (const ref of refNames) {
      try {
        await this.git(['update-ref', '-d', ref])
      } catch { /* already absent */ }
    }
    return refNames.length
  }

  async collectIfNeeded({ looseObjectThreshold = 5000 } = {}) {
    return this.withLock(async () => {
      let count = 0
      try {
        const { stdout } = await this.git(['count-objects', '-v'])
        const match = /^count:\s*(\d+)/m.exec(String(stdout || ''))
        count = match ? Number(match[1]) : 0
      } catch {
        return { collected: false, count: 0 }
      }
      if (count <= looseObjectThreshold) return { collected: false, count }
      await this.git(['gc', '--prune=now'])
      return { collected: true, count }
    })
  }

  async repairIndexIfCorrupt() {
    try {
      await this.git(['status', '--porcelain=v2'])
      return { repaired: false }
    } catch (error) {
      const detail = String(error.stderr || error.message || '')
      if (!/index file (?:corrupt|smaller than expected|checksum)|bad index file|index.*corrupt/i.test(detail)) {
        throw error
      }
      fs.rmSync(path.join(this.gitDir, 'index'), { force: true })
      return { repaired: true }
    }
  }
}

async function checkGitVersion(gitExecutable = 'git', { execFileFn } = {}) {
  const run = typeof execFileFn === 'function' ? execFileFn : defaultExecFile
  try {
    const { stdout } = await run(gitExecutable, ['--version'], { encoding: 'utf8' })
    const match = /git version (\d+)\.(\d+)/.exec(String(stdout || ''))
    if (!match) return { ok: false, version: '' }
    const major = Number(match[1])
    const minor = Number(match[2])
    return {
      ok: major > 2 || (major === 2 && minor >= 32),
      version: `${major}.${minor}`,
    }
  } catch {
    return { ok: false, version: '' }
  }
}

module.exports = {
  ATTRIBUTES_LINE,
  DEFAULT_SNAPSHOT_LIMITS,
  FIXED_EXCLUDES,
  MANAGED_EXCLUDE_MARKER,
  ShadowRepo,
  checkGitVersion,
  encodeId,
  gitEnvironment,
  parseLfsPaths,
  parseStatusPaths,
  placeholderText,
  writeExclude,
}
