// Explicit real-provider smoke test. Run in Electron main, never in Renderer.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')
const { LocalWorkspace } = require('../src/workspace/local-workspace.cjs')
const { detectAgents, resolveExecutable, runAgent } = require('../src/agents/cli/cli-adapters.cjs')
const { resolveNativeShellEnvironment, resolveNativeCredentialState, codexDeclaredCredentialKeys } = require('../src/agents/local-agent-readiness.cjs')
const { nativeCredentialEnvironment } = require('../src/agents/agent-native-environment.cjs')
const { networkEnvironment } = require('../src/agents/cli/cli-network-environment.cjs')
const { configDirectoryEnvironment } = require('../src/agents/cli/cli-config-directories.cjs')
const { openRoomDatabase } = require('../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../src/room-engine/room-service.cjs')
const { createRoomNativeRuntime } = require('../src/room-engine/native-runtime.cjs')
const { createControllerAgent } = require('../src/room-engine/controller-agent.cjs')
const { createArtifactSnapshots } = require('../src/room-engine/artifact-snapshots.cjs')
const { createArtifactReader } = require('../src/room-engine/artifact-reader.cjs')

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || '' }
const provider = argument('--provider')
if (!app) throw new Error('SMOKE_REQUIRES_ELECTRON_MAIN')
if (!process.argv.includes('--run') || !['claude', 'codex', 'gemini'].includes(provider)) {
  console.error('Use: npm run smoke:room -- --run --provider claude|codex|gemini')
  app.exit(2)
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-smoke-'))
fs.chmodSync(root, 0o700)
const privateRoot = path.join(root, 'userData')
app.setPath('userData', privateRoot)

async function smoke() {
  const workdir = path.join(root, 'project')
  fs.mkdirSync(workdir)
  console.log(JSON.stringify({ stage: 'start', provider, directory: root }))
  const shell = await resolveNativeShellEnvironment()
  const env = { ...process.env, ...shell.env }
  for (const key of shell.unsetKeys || []) delete env[key]
  const nativeKeys = provider === 'codex' ? ['CODEX_API_KEY', ...codexDeclaredCredentialKeys({ env })] : []
  const executable = await resolveExecutable(provider, { env })
  if (!executable) throw new Error('SMOKE_PROVIDER_NOT_INSTALLED')
  const agents = await detectAgents({ env, resolveExecutableFn: kind => kind === provider ? executable : null })
  if (!agents.some(agent => agent.kind === provider && agent.available !== false && agent.invocable !== false)) throw new Error('SMOKE_PROVIDER_NOT_INVOCABLE')
  const calls = []
  let fatal = null
  const workspace = new LocalWorkspace({
    storagePath: path.join(privateRoot, 'workspace.json'),
    tracesRoot: path.join(privateRoot, 'traces'),
    detectAgents: async () => agents,
    credentialState: (kind, agent) => resolveNativeCredentialState(kind, { env, executable: agent.executable }),
    naturalAgentResponses: true,
    runAgentTimeoutMs: 90_000,
    runAgent: async (agent, prompt, directory, options) => {
      if (calls.length >= 8) throw new Error('SMOKE_CALL_LIMIT')
      const role = prompt.startsWith('You are the Meldwork collaboration controller') ? 'controller' : 'worker'
      calls.push({ role })
      const call = calls.length
      console.log(JSON.stringify({ stage: 'invoke', call, role, sandbox: options.sandbox }))
      const result = await runAgent(agent, prompt, directory, { ...options, nativeCredentialKeys: nativeKeys,
        env: { ...networkEnvironment(env), ...configDirectoryEnvironment(env), ...nativeCredentialEnvironment(agent.kind, env, nativeKeys), PATH: env.PATH } })
      console.log(JSON.stringify({ stage: 'returned', call, role }))
      return result
    },
  })
  await workspace.refreshAgents()
  const roomDb = openRoomDatabase({ directory: path.join(privateRoot, 'room-engine') })
  const repository = createRoomRepository(roomDb)
  const directory = path.join(privateRoot, 'artifacts')
  const native = createRoomNativeRuntime({ repository, workspace,
    artifactSnapshots: createArtifactSnapshots({ roomDb, repository, directory, privateRoot }) })
  const service = createRoomService({ roomDb, repository, invokeAgent: native.invokeAgent, resolveGroup: native.resolveTarget,
    decideController: createControllerAgent({ repository, invokeAgent: native.invokeAgent, resolveGroup: native.resolveTarget }),
    autoRunEffects: true,
    onControllerError: error => { fatal ||= error; console.error(JSON.stringify({ stage: 'controller_error', code: error.code || error.message })) },
    onEffectError: error => { fatal ||= error; console.error(JSON.stringify({ stage: 'worker_error', code: error.code || error.message })) },
  })
  const read = createArtifactReader({ roomDb, directory })
  const { roomId, chatId } = service.bootstrap({ name: 'Real CLI smoke', workspace: workdir, providers: [provider], allowedCapabilities: ['text'] })
  const startedAt = Date.now()
  let summary
  let failure = null
  try {
    service.applyUserCommand({ type: 'set_workspace_write', chatId, commandId: 'smoke-write-grant', allowWrite: true })
    service.submitMessage({ chatId, author: { type: 'user', id: 'user' }, content:
      '请为中文贪吃蛇 MVP 写一份简短需求文档 docs/requirements.md，包含目标、操作、计分、失败条件与验收标准。请自行创建一位文档作者并派发写任务，不需要讨论或代码实现。文档完成后用一条 Attention 请我确认，之后不要再派发。最多一个写文档任务，角色只能使用当前可用 Provider。' })
    while (Date.now() - startedAt < 180_000) {
      if (fatal) throw fatal
      const snapshot = service.snapshot({ roomId })
      const artifact = snapshot.artifacts.find(item => item.path === 'docs/requirements.md')
      const report = snapshot.reports.find(item => item.kind === 'ready' && item.artifact_ids_json.includes(artifact?.id))
      const attention = snapshot.attentions.find(item => item.status === 'open' && item.task_id === artifact?.source_task_id
        && item.requested_by === 'controller' && ['approval', 'decision'].includes(item.type))
      if (artifact && report && attention && snapshot.tasks.some(task => task.id === artifact.source_task_id && task.status === 'done')) {
        const diff = await read({ roomId, artifactId: artifact.id })
        const contents = fs.readFileSync(path.join(workdir, artifact.path), 'utf8')
        if (!contents.trim() || !diff.text.includes('@@')) throw new Error('SMOKE_OUTPUT_INVALID')
        // Finish before accepting so this smoke does not schedule new model work.
        summary = { ok: true, provider, calls: calls.length, roles: snapshot.roles.length,
          tasks: snapshot.tasks.length, reports: snapshot.reports.length, artifactId: artifact.id,
          version: artifact.version, attentionId: attention.id, elapsedMs: Date.now() - startedAt }
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!summary) throw new Error('SMOKE_TIMEOUT')
  } catch (error) {
    failure = error
    throw error
  } finally {
    await service.close()
    const snapshot = repository.getRoomSnapshot(roomId)
    const result = { ...summary, ok: false, phase: summary ? 'checking_reopen' : 'failed', provider, directory: root,
      tasks: snapshot.tasks.map(task => ({ id: task.id, status: task.status })),
      calls, error: failure ? String(failure.code || failure.message) : null }
    fs.writeFileSync(path.join(privateRoot, 'smoke-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    roomDb.close()
  }
  const reopened = openRoomDatabase({ directory: path.join(privateRoot, 'room-engine') })
  try {
    const persisted = createRoomRepository(reopened).getRoomSnapshot(roomId)
    if (!persisted.artifacts.some(item => item.id === summary.artifactId)
        || !persisted.reports.some(item => item.artifact_ids_json.includes(summary.artifactId))
        || !persisted.attentions.some(item => item.id === summary.attentionId)) throw new Error('SMOKE_REOPEN_STATE_LOST')
    const diff = await createArtifactReader({ roomDb: reopened, directory })({ roomId, artifactId: summary.artifactId })
    if (!diff.text.includes('@@')) throw new Error('SMOKE_REOPEN_DIFF_LOST')
    summary.reopenVerified = true
  } finally { reopened.close() }
  const resultPath = path.join(privateRoot, 'smoke-result.json')
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  fs.writeFileSync(resultPath, JSON.stringify({ ...result, ok: true, phase: 'complete', reopenVerified: true }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ stage: 'complete', ...summary }))
}

app.whenReady().then(smoke).then(() => app.quit(), error => {
  console.error(JSON.stringify({ stage: 'failed', code: String(error.code || error.message), directory: root }))
  app.exit(1)
})
