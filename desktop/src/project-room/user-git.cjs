const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function userGitError(code, cause) {
  const error = Object.assign(new Error(code), { code })
  if (cause) error.cause = cause
  return error
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

function userGit(workTree, args, { input, execFileFn } = {}) {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  env.GIT_TERMINAL_PROMPT = '0'
  const run = typeof execFileFn === 'function' ? execFileFn : defaultExecFile
  return run('git', ['-C', workTree, ...args], {
    cwd: workTree,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function topLevel(workTree, options = {}) {
  const { stdout } = await userGit(workTree, ['rev-parse', '--show-toplevel'], options)
  return fs.realpathSync.native(path.resolve(stdout.trim()))
}

function repoRelative(toplevel, workTree, relative) {
  const realWorkTree = fs.realpathSync.native(path.resolve(workTree))
  const absolute = path.resolve(realWorkTree, relative)
  const result = path.relative(toplevel, absolute)
  if (!result || result.startsWith('..') || path.isAbsolute(result)) {
    throw userGitError('USER_REPO_PATH_OUTSIDE')
  }
  return result.split(path.sep).join('/')
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function worktreeState(filename) {
  let stat
  try { stat = fs.lstatSync(filename) } catch { return { kind: 'absent' } }
  if (stat.isSymbolicLink()) {
    return { kind: 'link', target: fs.readlinkSync(filename) }
  }
  if (stat.isFile()) {
    return {
      kind: 'file',
      mode: stat.mode & 0o111 ? '100755' : '100644',
      sha256: sha256File(filename),
    }
  }
  return { kind: 'other' }
}

function acceptedState(entry) {
  if (!entry || entry.exists === false || entry.kind === 'absent') return { kind: 'absent' }
  if (entry.type === 'link' || entry.kind === 'link') {
    return { kind: 'link', target: entry.target == null ? null : String(entry.target) }
  }
  return {
    kind: 'file',
    mode: entry.mode || null,
    sha256: entry.sha256 || null,
  }
}

function parseLsFiles(output) {
  return String(output || '').split('\0').filter(Boolean).map(token => {
    const tab = token.indexOf('\t')
    const fields = token.slice(0, tab).split(' ')
    return {
      mode: fields[0],
      object: fields[1],
      stage: fields[2],
      path: token.slice(tab + 1),
    }
  }).filter(entry => entry.path)
}

async function userRepoPreflight({ workTree, paths = [], acceptedEntries = {}, execFileFn } = {}) {
  const reasons = []
  let toplevel
  try {
    toplevel = await topLevel(workTree, { execFileFn })
  } catch {
    return {
      ok: false,
      reasons: paths.map(relative => ({ path: relative, reason: 'not-a-repository' })),
    }
  }
  for (const relative of paths) {
    let repoPath
    try {
      repoPath = repoRelative(toplevel, workTree, relative)
    } catch {
      reasons.push({ path: relative, reason: 'outside-repository' })
      continue
    }
    try {
      await userGit(toplevel, ['diff', '--cached', '--quiet', '--', repoPath], { execFileFn })
    } catch (error) {
      reasons.push({
        path: relative,
        reason: error.code === 1 ? 'staged' : 'index-check-failed',
      })
      continue
    }
    const accepted = acceptedState(acceptedEntries[relative])
    const current = worktreeState(path.resolve(workTree, relative))
    if (accepted.kind === 'absent') {
      if (current.kind !== 'absent') reasons.push({ path: relative, reason: 'unexpected' })
      continue
    }
    if (current.kind === 'absent') {
      reasons.push({ path: relative, reason: 'missing' })
      continue
    }
    if (accepted.kind !== current.kind) {
      reasons.push({ path: relative, reason: 'type' })
      continue
    }
    if (accepted.kind === 'link') {
      if (accepted.target !== current.target) reasons.push({ path: relative, reason: 'content' })
      continue
    }
    if (accepted.mode !== current.mode) {
      reasons.push({ path: relative, reason: 'mode' })
      continue
    }
    if (accepted.sha256 !== current.sha256) {
      reasons.push({ path: relative, reason: 'content' })
    }
  }
  return { ok: reasons.length === 0, reasons }
}

async function userRepoCommit({
  workTree,
  paths = [],
  acceptedEntries = {},
  message,
  decisionId,
  onStaged,
  execFileFn,
} = {}) {
  if (typeof decisionId !== 'string' || !decisionId) {
    throw userGitError('USER_COMMIT_DECISION_REQUIRED')
  }
  const preflight = await userRepoPreflight({ workTree, paths, acceptedEntries, execFileFn })
  if (!preflight.ok) return { committed: false, reasons: preflight.reasons }
  const toplevel = await topLevel(workTree, { execFileFn })
  const repoPaths = paths.map(relative => repoRelative(toplevel, workTree, relative))
  let stagedEntries = []
  try {
    await userGit(toplevel, ['add', '-f', '-A', '--', ...repoPaths], { execFileFn })
    const { stdout } = await userGit(toplevel, ['ls-files', '-s', '-z', '--', ...repoPaths], {
      execFileFn,
    })
    stagedEntries = parseLsFiles(stdout)
    if (typeof onStaged === 'function') await onStaged(stagedEntries)
    await userGit(toplevel, [
      'commit', '--only',
      '-m', message || 'Meldwork accepted version',
      '-m', `Meldwork-Decision: ${decisionId}`,
      '--', ...repoPaths,
    ], { execFileFn })
    const { stdout: head } = await userGit(toplevel, ['rev-parse', 'HEAD'], { execFileFn })
    return { committed: true, commit: head.trim() }
  } catch (error) {
    const restored = []
    for (const entry of stagedEntries) {
      let current = null
      try {
        const { stdout } = await userGit(toplevel, ['ls-files', '-s', '-z', '--', entry.path], {
          execFileFn,
        })
        current = parseLsFiles(stdout)[0] || null
      } catch { /* keep the entry untouched */ }
      if (current && current.mode === entry.mode && current.object === entry.object
          && current.stage === entry.stage) {
        try {
          await userGit(toplevel, ['reset', '-q', '--', entry.path], { execFileFn })
          restored.push(entry.path)
        } catch { /* best effort */ }
      }
    }
    error.restoredPaths = restored
    throw error
  }
}

async function userRepoCheckTrailer({ workTree, decisionId, execFileFn } = {}) {
  try {
    const { stdout } = await userGit(workTree, [
      'log', '-1', '--format=%(trailers:key=Meldwork-Decision,valueonly)', 'HEAD',
    ], { execFileFn })
    return stdout.trim() === decisionId
  } catch {
    return false
  }
}

module.exports = {
  acceptedState,
  userRepoCheckTrailer,
  userRepoCommit,
  userRepoPreflight,
  worktreeState,
}
