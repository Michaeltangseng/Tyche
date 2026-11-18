// Explicit real-provider resume proof for the room engine. Run outside the renderer.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { detectAgents, resolveExecutable, runAgent } = require('../src/agents/cli/cli-adapters.cjs')
const { resolveNativeShellEnvironment, codexDeclaredCredentialKeys } = require('../src/agents/local-agent-readiness.cjs')
const { nativeCredentialEnvironment } = require('../src/agents/agent-native-environment.cjs')
const { networkEnvironment } = require('../src/agents/cli/cli-network-environment.cjs')
const { configDirectoryEnvironment } = require('../src/agents/cli/cli-config-directories.cjs')

const argument = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] || ''
}
const provider = argument('--provider')
if (!process.argv.includes('--run') || !['claude', 'codex'].includes(provider)) {
  console.error('Use: room-resume-proof.cjs --run --provider claude|codex')
  process.exit(2)
}

function userDataDirectory() {
  if (process.env.TYCHE_USER_DATA) return process.env.TYCHE_USER_DATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Tyche')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Tyche')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tyche')
}

async function invoke(agent, prompt, workdir, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await runAgent(agent, prompt, workdir, {
      ...options,
      signal: controller.signal,
      onEvent: () => {},
    })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const userData = userDataDirectory()
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-room-resume-${provider}-`))
  const resultPath = path.join(userData, 'room-resume-proof.json')
  const result = { provider, resumed: false, remembered: false, sessionRefChanged: null, error: null }
  try {
    const shell = await resolveNativeShellEnvironment()
    const env = { ...process.env, ...shell.env }
    for (const key of shell.unsetKeys || []) delete env[key]
    const executable = await resolveExecutable(provider, { env })
    if (!executable) throw new Error('PROOF_PROVIDER_NOT_INSTALLED')
    const agents = await detectAgents({ env, resolveExecutableFn: kind => kind === provider ? executable : null })
    const agent = agents.find(item => item.kind === provider && item.available !== false && item.invocable !== false)
    if (!agent) throw new Error('PROOF_PROVIDER_NOT_INVOCABLE')
    const nativeKeys = provider === 'codex' ? ['CODEX_API_KEY', ...codexDeclaredCredentialKeys({ env })] : []
    const childEnv = {
      ...networkEnvironment(env),
      ...configDirectoryEnvironment(env),
      ...nativeCredentialEnvironment(provider, env, nativeKeys),
      PATH: env.PATH,
    }
    const options = { env: childEnv, sandbox: 'read-only', nativeCredentialKeys: nativeKeys }

    const first = await invoke(agent, 'Remember the number 47. Do not say the number in this reply.', workdir, options, 120_000)
    result.firstSessionRef = first.sessionRef || ''
    result.firstText = String(first.text || '').slice(0, 500)

    const second = await invoke(agent, 'What number did I ask you to remember? Reply with the number only.', workdir,
      { ...options, sessionRef: first.sessionRef || '' }, 120_000)
    result.secondSessionRef = second.sessionRef || ''
    result.secondText = String(second.text || '').slice(0, 500)
    result.sessionRefChanged = Boolean(second.sessionRef && first.sessionRef && second.sessionRef !== first.sessionRef)
    result.resumed = Boolean(first.sessionRef && second.sessionRef
      && second.sessionRef === first.sessionRef && !result.sessionRefChanged)
    result.remembered = /\b47\b/.test(result.secondText)
    result.compactionProven = false
  } catch (error) {
    result.error = String(error?.code || error?.message || error)
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ stage: 'complete', resultPath, ...result }))
  if (!result.resumed || !result.remembered) process.exitCode = 1
}

main().catch(error => {
  console.error(JSON.stringify({ stage: 'failed', code: String(error?.code || error?.message || error) }))
  process.exitCode = 1
})
