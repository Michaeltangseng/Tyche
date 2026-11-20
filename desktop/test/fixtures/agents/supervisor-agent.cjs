'use strict'

// Test Agent for the native managed-process supervisor.
//
// Environment:
//   OUT    output directory (required)
//   MODE   "normal" (default) or "escape"
//   LOOPS  main loop duration in 100 ms ticks (default 3)
//
// The Agent records its exact environment and open descriptors, starts a
// background writer that ignores SIGTERM, and exits after the loop. In escape
// mode it also starts a detached (setsid) writer that survives a process-group
// kill.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const OUT = process.env.OUT
if (!OUT) process.exit(1)
fs.mkdirSync(OUT, { recursive: true })
const loops = Number(process.env.LOOPS || '3')
const mode = process.env.MODE || 'normal'
if (mode === 'ignore-term') process.on('SIGTERM', () => {})

fs.writeFileSync(path.join(OUT, 'env.json'), JSON.stringify(process.env, null, 2))

const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
const descriptors = []
try {
  for (const name of fs.readdirSync(fdRoot)) {
    const descriptor = Number(name)
    if (!Number.isInteger(descriptor)) continue
    try {
      const stat = fs.fstatSync(descriptor)
      descriptors.push({
        fd: descriptor,
        ino: Number(stat.ino),
        file: stat.isFile(),
        fifo: stat.isFIFO(),
        socket: stat.isSocket(),
      })
    } catch {
      // The descriptor closed between readdir and fstat.
    }
  }
} catch {
  // /dev/fd or /proc/self/fd may be unavailable.
}
fs.writeFileSync(path.join(OUT, 'fds.json'), JSON.stringify(descriptors, null, 2))

function startWriter(filename, detached) {
  const script = `
    const fs = require('node:fs')
    const path = require('node:path')
    const file = path.join(process.env.OUT, ${JSON.stringify(filename)})
    process.on('SIGTERM', () => {})
    setInterval(() => {
      try { fs.appendFileSync(file, 'tick\\n') } catch {}
    }, 100)
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, OUT },
    stdio: 'ignore',
    detached: detached === true,
  })
  if (detached === true) {
    child.unref()
    fs.writeFileSync(path.join(OUT, 'escaped.pid'), String(child.pid))
  }
  return child
}

startWriter('bg.txt', false)
if (mode === 'escape') startWriter('escaped.txt', true)
if (process.env.OUTPUT_BYTES) {
  process.stdout.write('x'.repeat(Math.max(0, Number(process.env.OUTPUT_BYTES) || 0)))
}

console.log('STARTED')
setTimeout(() => {
  console.log('FINAL-ANSWER')
  process.exit(0)
}, Math.max(1, loops) * 100)
