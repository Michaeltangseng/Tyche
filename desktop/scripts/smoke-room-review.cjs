// Scenario assertions only: production routing remains driven by the user's message.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

async function runReviewSmoke({ service, repository, roomId, chatId, workdir, read, checkError }) {
  const deadline = Date.now() + 360_000
  const waitFor = async predicate => {
    while (Date.now() < deadline) {
      checkError()
      const snapshot = service.snapshot({ roomId })
      if (snapshot.tasks.length > 3 || snapshot.assignments.length > 3) throw new Error('SMOKE_DUPLICATE_WORK')
      if (snapshot.reports.some(report => ['failed', 'blocked', 'waiting', 'handoff'].includes(report.kind))) throw new Error('SMOKE_WORK_NOT_READY')
      const result = predicate(snapshot)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('SMOKE_REVIEW_TIMEOUT')
  }
  service.submitMessage({ chatId, author: { type: 'user', id: 'user' }, content:
    '这是一个很小的真实协作验收。请自动创建三个不同角色：文档作者、只读评审者、实施者，均使用当前可用 Provider，各自独立执行。目标是实现纯函数 add(a,b)。先由文档作者写 docs/add.md：仅支持两个有限 number 参数，返回两数之和，输入不是有限 number 时抛 TypeError；列出验收示例。文档完成后由不同的只读评审者实际读取文档，以结构化 Report 给出结论和证据，不写文件；评审完成后才创建一条 approval Attention，明确询问是否接受文档并开始实施，提供 id=implement 和 id=revise 两个选项。用户回答前绝不能创建或派发实施任务。用户选择 implement 且文档 Artifact 已被接受后，再由实施者在 src/add.cjs 导出 add 函数，并在 test/add.test.cjs 写 node:test 测试，不要修改文档；本次会话不要运行测试命令，平台验收阶段会在同一项目目录执行 node --test test/add.test.cjs 和额外契约检查。最多三个任务：文档、评审、实施，每个任务一次 Assignment，不重复派发；三个角色均必须参与。完成后停止，不创建额外讨论或审批。后续任务请引用前序任务/产物并保留本消息的源消息引用。' })
  const approved = await waitFor(snapshot => {
    if (fs.existsSync(path.join(workdir, 'src/add.cjs')) || snapshot.tasks.some(task => task.kind === 'implement')) {
      throw new Error('SMOKE_IMPLEMENTED_BEFORE_USER_DECISION')
    }
    const artifact = snapshot.artifacts.find(item => item.path === 'docs/add.md')
    const documentReport = snapshot.reports.find(item => item.kind === 'ready' && item.artifact_ids_json.includes(artifact?.id))
    const review = snapshot.reports.find(item => item.kind === 'ready' && item.id !== documentReport?.id)
    const attention = snapshot.attentions.find(item => item.status === 'open' && item.type === 'approval'
      && item.options_json.some(option => option.id === 'implement') && item.options_json.some(option => option.id === 'revise'))
    if (!artifact || !documentReport || !review || !attention) return null
    const writer = snapshot.assignments.find(item => item.id === documentReport.assignment_id)
    const reviewer = snapshot.assignments.find(item => item.id === review.assignment_id)
    if (!writer || !reviewer || reviewer.role_id === writer.role_id || reviewer.native_session_id === writer.native_session_id) throw new Error('SMOKE_REVIEW_NOT_INDEPENDENT')
    if (reviewer.write_scopes_json.length) throw new Error('SMOKE_REVIEW_NOT_READ_ONLY')
    if (!review.evidence_json.length) throw new Error('SMOKE_REVIEW_EVIDENCE_MISSING')
    if (snapshot.tasks.length !== 2 || snapshot.tasks.some(task => task.status !== 'done')) return null
    return { artifact, review, attention, writer, reviewer }
  })
  const documentDiff = await read({ roomId, artifactId: approved.artifact.id })
  if (!documentDiff.text.includes('@@')) throw new Error('SMOKE_REVIEW_DOCUMENT_DIFF_MISSING')
  console.log(JSON.stringify({ stage: 'review_complete_awaiting_user', tasks: 2 }))
  // Explicit test-user actions through the same commands exposed by the desktop UI.
  service.applyUserCommand({ type: 'accept_artifact', chatId, artifactId: approved.artifact.id })
  service.applyUserCommand({ type: 'answer_attention', chatId, attentionId: approved.attention.id,
    optionId: 'implement', comment: '接受此文档和评审结论，请按原需求开始实施。' })
  const finished = await waitFor(snapshot => {
    const artifact = snapshot.artifacts.find(item => item.path === 'src/add.cjs')
    const testArtifact = snapshot.artifacts.find(item => item.path === 'test/add.test.cjs')
    const report = snapshot.reports.find(item => item.kind === 'ready' && item.artifact_ids_json.includes(artifact?.id))
    if (!artifact || !testArtifact || !report) return null
    if (snapshot.tasks.length !== 3 || snapshot.tasks.some(task => task.status !== 'done') || snapshot.assignments.length !== 3) return null
    const implementer = snapshot.assignments.find(item => item.id === report.assignment_id)
    if ([approved.writer.role_id, approved.reviewer.role_id].includes(implementer.role_id)) throw new Error('SMOKE_IMPLEMENTER_NOT_DISTINCT')
    return { snapshot, artifact, testArtifact }
  })
  await service.flushController(chatId)
  checkError()
  const current = service.snapshot({ roomId })
  if (current.tasks.length !== 3 || current.assignments.length !== 3) throw new Error('SMOKE_DUPLICATE_WORK')
  const diff = await read({ roomId, artifactId: finished.artifact.id })
  if (!diff.text.includes('@@')) throw new Error('SMOKE_IMPLEMENTATION_DIFF_MISSING')
  // Execute only this temporary project's focused tests in Electron's bundled Node.
  const result = spawnSync(process.execPath, ['--test', 'test/add.test.cjs'], {
    cwd: workdir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
  })
  if (result.status !== 0 || result.error) throw new Error('SMOKE_IMPLEMENTATION_TESTS_FAILED')
  const contract = spawnSync(process.execPath, ['-e', `const a=require('node:assert/strict');const {add}=require('./src/add.cjs');a.equal(add(2,3),5);a.equal(add(-2,2),0);a.equal(add(0.5,0.25),0.75);for(const x of [NaN,Infinity,-Infinity,'1',null,undefined,{},true]){a.throws(()=>add(x,1),TypeError);a.throws(()=>add(1,x),TypeError)}`], {
    cwd: workdir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
  })
  if (contract.status !== 0 || contract.error) throw new Error('SMOKE_IMPLEMENTATION_CONTRACT_FAILED')
  const events = repository.listEvents(roomId, { chatId })
  const decision = events.find(event => event.type === 'user_answer_attention')
  const implementation = events.find(event => event.type === 'action_assign'
    && JSON.parse(event.payload_json).taskId === finished.artifact.source_task_id)
  if (!decision || !implementation || implementation.sequence <= decision.sequence) throw new Error('SMOKE_IMPLEMENTATION_ORDER_INVALID')
  return { ok: true, scenario: 'review', roles: current.roles.length, tasks: current.tasks.length, reports: current.reports.length,
    artifactId: approved.artifact.id, attentionId: approved.attention.id, reviewReportId: approved.review.id,
    implementationArtifactId: finished.artifact.id, contextRevision: repository.getChatContext(chatId).revision,
    reviewVerified: true, userDecisionVerified: true, implementationTestsVerified: true }
}

module.exports = { runReviewSmoke }
