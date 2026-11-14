const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ATTRIBUTES_LINE = '* -text -eol -filter -ident -working-tree-encoding\n'
const FIXED_EXCLUDES = Object.freeze(['.git', 'node_modules/', '.DS_Store'])
const MANAGED_EXCLUDE_MARKER = '# meldwork: managed placeholders'

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
      encoding: 'utf8',
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

class ShadowRepo {
  constructor({ gitDir, workTree, gitExecutable = 'git', execFileFn } = {}) {
    if (typeof gitDir !== 'string' || !gitDir) throw shadowError('SHADOW_GIT_DIRECTORY_REQUIRED')
    if (typeof workTree !== 'string' || !workTree) throw shadowError('SHADOW_WORKTREE_REQUIRED')
    this.gitDir = path.resolve(gitDir)
    this.workTree = path.resolve(workTree)
    this.gitExecutable = gitExecutable
    this.execFileFn = typeof execFileFn === 'function' ? execFileFn : defaultExecFile
    this.lock = Promise.resolve()
  }

  static async create({ gitDir, workTree, gitExecutable, execFileFn } = {}) {
    if (typeof workTree !== 'string' || !fs.existsSync(workTree)
        || !fs.statSync(workTree).isDirectory()) {
      throw shadowError('SHADOW_WORKTREE_INVALID')
    }
    fs.mkdirSync(path.resolve(gitDir), { recursive: true })
    const repo = new ShadowRepo({ gitDir, workTree, gitExecutable, execFileFn })
    await repo.git(['init', '--quiet'])
    await repo.git(['config', 'core.bare', 'false'])
    fs.mkdirSync(path.join(repo.gitDir, 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo.gitDir, 'info', 'attributes'), ATTRIBUTES_LINE)
    writeExclude(repo.gitDir, [])
    return repo
  }

  async git(args, { env = {}, input, indexFile } = {}) {
    const fullArgs = [
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
    const extra = { ...env }
    if (indexFile) extra.GIT_INDEX_FILE = indexFile
    return this.execFileFn(this.gitExecutable, fullArgs, {
      cwd: this.workTree,
      env: gitEnvironment(extra),
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  withLock(operation) {
    if (typeof operation !== 'function') throw shadowError('SHADOW_GIT_LOCK_OPERATION_REQUIRED')
    const run = this.lock.then(() => operation(), () => operation())
    this.lock = run.then(() => undefined, () => undefined)
    return run
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
  FIXED_EXCLUDES,
  MANAGED_EXCLUDE_MARKER,
  ShadowRepo,
  checkGitVersion,
  encodeId,
  gitEnvironment,
  writeExclude,
}
