'use strict'

// Scripted Agent used by project-room end-to-end tests. The script path comes
// from FAKE_AGENT_SCRIPT; the prompt arrives on stdin.
// Steps:
//   { op: 'output', text }
//   { op: 'echoPrompt' }
//   { op: 'write', path, content }
//   { op: 'run', command, args, print }
//   { op: 'wait', ms }
//   { op: 'hang' }
//   { op: 'exit', code }
//   { op: 'crash', code }
// The script may set finalText and marker (the marker is printed as the last
// non-empty line, like a real Agent).

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const scriptPath = process.env.FAKE_AGENT_SCRIPT || process.argv[2]
if (!scriptPath) {
  process.stderr.write('FAKE_AGENT_SCRIPT is required\n')
  process.exit(2)
}
let script
try {
  script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'))
} catch (error) {
  process.stderr.write(`Cannot read script: ${error.message}\n`)
  process.exit(2)
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.resume()
  })
}

async function executeSteps(steps, prompt) {
  for (const step of steps || []) {
    if (step.op === 'whenPromptIncludes') {
      const branch = prompt.includes(String(step.text || '')) ? step.then : step.otherwise
      await executeSteps(branch, prompt)
      continue
    }
    if (step.op === 'marker') {
      process.stdout.write(`\n${step.value}\n`)
    } else if (step.op === 'output') {
      process.stdout.write(String(step.text || ''))
    } else if (step.op === 'echoPrompt') {
      process.stdout.write(prompt)
    } else if (step.op === 'write') {
      const target = path.resolve(step.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, String(step.content || ''))
    } else if (step.op === 'run') {
      const args = Array.isArray(step.args) ? step.args.map(String) : []
      const result = spawnSync(String(step.command), args, {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
      if (step.print) {
        if (result.stdout) process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
      }
      if (result.status !== 0 && step.allowFailure !== true) {
        process.exit(result.status || 2)
      }
    } else if (step.op === 'wait') {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(step.ms) || 0)))
    } else if (step.op === 'hang') {
      setInterval(() => {}, 1000)
      await new Promise(() => {})
    } else if (step.op === 'exit') {
      process.exit(Number(step.code) || 0)
    } else if (step.op === 'crash') {
      process.exit(Number(step.code) || 2)
    }
  }
}

async function run() {
  const prompt = await readStdin()
  await executeSteps(script.steps, prompt)
  if (script.finalText) process.stdout.write(String(script.finalText))
  if (script.marker) {
    process.stdout.write(`\n${script.marker}\n`)
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`)
  process.exit(2)
})
