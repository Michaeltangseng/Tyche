/**
 * Runtime PID records for crash recovery.
 *
 * OAR spawns the native CLI itself, outside Meldwork's managed-spawn /
 * process-registry. An OAR session normally disposes its process; a hard crash
 * leaves the detached process group behind. The runtime wrapper writes
 * <pid>\t<ps lstart> before exec, and sweepRuntimeProcesses() at the next
 * startup kills only a group whose recorded identity still matches.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const inspect = require('../agents/process/process-inspect.cjs')

const execFileAsync = promisify(execFile)
const EXEC_OPTIONS = Object.freeze({ encoding: 'utf8', maxBuffer: 1024 * 1024 })

function psInC(file, args, options = {}) {
  return execFileAsync(file, args, {
    ...options,
    env: { ...process.env, LC_ALL: 'C' },
  })
}

function pidFilePath(directory, runId) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('ROOM_RUNTIME_STATE_DIRECTORY_MUST_BE_ABSOLUTE')
  }
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new TypeError('ROOM_RUNTIME_RUN_ID_INVALID')
  }
  return path.join(directory, `${runId}.pid`)
}

function removeRuntimePid({ directory, runId }) {
  try {
    fs.rmSync(pidFilePath(directory, runId), { force: true })
  } catch { /* cleanup is best effort */ }
}

async function sweepRuntimeProcesses({
  directory,
  kill = process.kill,
  inspectFn = inspect,
  warn = () => {},
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('ROOM_RUNTIME_STATE_DIRECTORY_MUST_BE_ABSOLUTE')
  }
  if (!fs.existsSync(directory)) return { killed: 0, removed: 0, skipped: 0 }
  if (process.platform === 'win32') {
    // The POSIX wrapper/process-group path is not implemented on Windows yet.
    return { killed: 0, removed: 0, skipped: 0, unsupported: true }
  }

  let killed = 0
  let removed = 0
  let skipped = 0
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.pid')) continue
    const file = path.join(directory, name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const tab = text.indexOf('\t')
    const pid = Number.parseInt((tab < 0 ? text : text.slice(0, tab)).trim(), 10)
    const recordedStart = tab < 0 ? '' : text.slice(tab + 1).trim()
    if (!Number.isInteger(pid) || pid <= 0 || recordedStart === '') {
      fs.rmSync(file, { force: true })
      removed += 1
      continue
    }

    const currentStart = await inspectFn.processStartTime(pid, { execFileFn: psInC }).catch(() => null)
    if (currentStart === null) {
      // The launcher may have exec'd/exited while its children stayed in the
      // process group. The group id is the recorded PID; kill it if it still
      // has members, otherwise only forget the stale file.
      let groupAlive = true
      try {
        groupAlive = !inspectFn.groupEmpty(pid, { killFn: kill })
      } catch {
        groupAlive = false
      }
      if (groupAlive) {
        try {
          kill(-pid, 'SIGKILL')
          killed += 1
        } catch {
          skipped += 1
        }
      }
      fs.rmSync(file, { force: true })
      removed += 1
      continue
    }

    if (currentStart !== recordedStart) {
      // The PID now belongs to another process; never signal it.
      fs.rmSync(file, { force: true })
      removed += 1
      skipped += 1
      continue
    }

    let pgid = pid
    try {
      pgid = await inspectFn.processGroupOf(pid) ?? pid
    } catch { /* fall back to the recorded PID as the group */ }
    let ok = false
    try {
      kill(-pgid, 'SIGKILL')
      ok = true
    } catch {
      try {
        kill(pid, 'SIGKILL')
        ok = true
      } catch {
        ok = false
      }
    }
    if (ok) killed += 1
    else {
      skipped += 1
      warn(`could not stop runtime process ${pid} from ${name}`)
    }
    fs.rmSync(file, { force: true })
    removed += 1
  }
  return { killed, removed, skipped }
}

module.exports = { pidFilePath, removeRuntimePid, sweepRuntimeProcesses }
