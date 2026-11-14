const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const EXEC_OPTIONS = Object.freeze({ encoding: 'utf8', maxBuffer: 1024 * 1024 })

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0
}

// Returns the process start time as reported by `ps -o lstart=`, or null when
// the process does not exist / cannot be inspected.
async function processStartTime(pid, options = {}) {
  if (!validPid(pid)) return null
  const run = options.execFileFn || execFileAsync
  try {
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], EXEC_OPTIONS)
    const value = String(stdout || '').trim()
    return value || null
  } catch {
    return null
  }
}

async function processGroupOf(pid, options = {}) {
  if (!validPid(pid)) return null
  const run = options.execFileFn || execFileAsync
  try {
    const { stdout } = await run('ps', ['-o', 'pgid=', '-p', String(pid)], EXEC_OPTIONS)
    const value = Number.parseInt(String(stdout || '').trim(), 10)
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

async function groupMembers(pgid, options = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return []
  const run = options.execFileFn || execFileAsync
  let stdout
  try {
    ({ stdout } = await run('pgrep', ['-g', String(pgid)], EXEC_OPTIONS))
  } catch {
    // pgrep exits 1 when the group is empty.
    return []
  }
  const pids = String(stdout || '')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
  const members = []
  for (const pid of pids) {
    members.push({ pid, startTime: await processStartTime(pid, { execFileFn: run }) })
  }
  return members
}

function groupEmpty(pgid, options = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  const kill = options.killFn || process.kill
  try {
    kill(-pgid, 0)
    return false
  } catch (error) {
    // ESRCH means no process in the group; EPERM means members exist but this
    // user cannot signal them — the group is not empty.
    return error && error.code === 'ESRCH'
  }
}

async function readEnvironmentMarker(pid, marker, options = {}) {
  if (!validPid(pid) || typeof marker !== 'string' || !marker) return 'unreadable'
  const platform = options.platform || process.platform
  const needle = `MELDWORK_CONTAINER=${marker}`
  if (platform === 'darwin') {
    const run = options.execFileFn || execFileAsync
    try {
      const { stdout } = await run('ps', ['-wwE', '-o', 'command=', '-p', String(pid)], EXEC_OPTIONS)
      const text = String(stdout || '')
      if (text.includes(needle)) return 'present'
      // macOS 15 no longer exposes another process's environment: `ps -E` and
      // sysctl KERN_PROCARGS2 both return only argv. If the output contains no
      // environment-looking token at all, report `unreadable` (identity
      // unknown) rather than claiming the marker is absent. Both outcomes are
      // treated as identity unknown by the recovery code (M3 3.7); this only
      // keeps the diagnostic honest.
      return /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(text) ? 'absent' : 'unreadable'
    } catch {
      return 'unreadable'
    }
  }
  if (platform === 'linux') {
    const readFile = options.readFileFn || fs.readFileSync
    try {
      const buffer = readFile(`/proc/${pid}/environ`)
      const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
      return text.split('\0').includes(needle) ? 'present' : 'absent'
    } catch {
      return 'unreadable'
    }
  }
  return 'unreadable'
}

module.exports = {
  groupEmpty,
  groupMembers,
  processGroupOf,
  processStartTime,
  readEnvironmentMarker,
}
