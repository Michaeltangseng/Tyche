function lines(value) {
  return (Array.isArray(value) ? value : []).map(item => String(item || '')).filter(Boolean)
}

function projectLanguage(state) {
  return state?.config?.settings?.language === 'en' ? 'en' : 'zh'
}

function platformPrompt({ role, rebuttal, language }) {
  const english = language === 'en'
  if (role === 'review') {
    return english
      ? [
        'You are the reviewer for this checkpoint. Read the target file and the inputs below.',
        'Find missing requirements, contradictions, unrealistic assumptions and gaps. Quote evidence from the file.',
        'Passing is a valid conclusion: do not invent problems to justify changes.',
        'Start your answer with a short summary (what you read, your conclusion, what remains unresolved, what the writer rejected).',
        rebuttal
          ? 'This is a rebuttal round: the body did not change and the writer rejected prior findings. Accept the rebuttal with pass, or insist with needs-human. Do not answer revise.'
          : '',
        'End with a machine marker on the last line: [[MELDWORK_REVIEW:{"verdict":"pass"|"revise"|"needs-human"}]]',
        'Do not edit the target file or any project document.',
      ].join('\n')
      : [
        '你是这个检查点的评审者。阅读目标文件与下面的输入。',
        '找出缺漏、矛盾、不现实的假设和未覆盖的风险，并引用原文或证据。',
        '「通过」是正当结论：不要为了交差编造问题。',
        '回答开头写几行摘要：看了什么、结论、还有什么没解决、主笔驳回了什么。',
        rebuttal
          ? '这是驳回轮：正文未改，主笔驳回了上一轮意见。接受驳回就给 pass，坚持就给 needs-human，不要再给 revise。'
          : '',
        '最后一行输出机器标记：[[MELDWORK_REVIEW:{"verdict":"pass"|"revise"|"needs-human"}]]',
        '不要修改目标文件或任何项目文档。',
      ].join('\n')
  }
  return english
    ? [
      'You are the lead writer for this checkpoint. Complete the task in the working directory.',
      'Write the target file and keep changes inside your assigned scope. Do not edit accepted documents outside the task.',
      'End with exactly one machine marker on the last line:',
      '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]] when the artifact is ready for review,',
      '[[MELDWORK_CHECKPOINT:{"signal":"question"}]] when a person must answer a question, or',
      '[[MELDWORK_CHECKPOINT:{"signal":"continue"}]] when the task is unfinished and the same session should continue.',
    ].join('\n')
    : [
      '你是这个检查点的主笔。在工作目录里完成这项任务。',
      '写出目标文件，改动只限于你的写入范围；不要修改任务之外的已接受文档。',
      '最后一行输出且只输出一个机器标记：',
      '产物可供评审时输出 [[MELDWORK_CHECKPOINT:{"signal":"ready"}]]，',
      '需要人回答问题输出 [[MELDWORK_CHECKPOINT:{"signal":"question"}]]，',
      '这一轮没做完、需要在同一会话继续输出 [[MELDWORK_CHECKPOINT:{"signal":"continue"}]]。',
    ].join('\n')
}

function buildProjectRoomPrompt({
  project, state, instance, def, seat, role, round, mainGroup,
}) {
  const language = projectLanguage(state)
  const english = language === 'en'
  const profile = state.config.profiles
    .find(item => item.id === seat?.profileVersionId && item.seatId === seat?.id)
  const accepted = []
  for (const key of def?.dependsOn || []) {
    const upstream = state.instances.find(item => (
      item.checkpointKey === key && item.state === 'accepted'
    ))
    const version = upstream?.artifactVersions.at(-1)
    const upstreamDef = state.config.playbook.checkpointDefs
      .find(item => item.key === key)
    if (!version) continue
    for (const path of upstreamDef?.targetFiles || []) {
      accepted.push(`${path} (${version.commit})`)
    }
  }
  const currentRound = instance.rounds.at(-1)
  const reviewFiles = instance.rounds
    .flatMap(item => item.reviews || [])
    .map(review => review.reviewFile)
    .filter(Boolean)
  const responseFile = `meldwork/reviews/${instance.checkpointKey}/r${Math.max(1, instance.round)}-response.md`
  const pendingInterjections = instance.interjections
    .filter(item => item.status === 'queued')
    .map(item => item.content)
  const drift = (state.driftItems || []).filter(item => (
    item.status === 'unresolved' || item.status === 'resolving'
  ))
  const outOfScope = (state.outOfScopeItems || []).filter(item => item.status === 'unresolved')

  const input = english
    ? [
      `Project: ${project?.name || ''}; checkpoint: ${def?.name || instance.checkpointKey}`,
      `Target files: ${lines(def?.targetFiles).join(', ') || '(none)'}`,
      accepted.length ? `Accepted upstream versions:\n${accepted.map(item => `- ${item}`).join('\n')}` : '',
      role === 'review' && instance.candidate ? `Candidate commit under review: ${instance.candidate}` : '',
      reviewFiles.length ? `Prior review files:\n${reviewFiles.map(item => `- ${item}`).join('\n')}` : '',
      role === 'lead' && round > 1 ? `Prior response file: ${responseFile}` : '',
      pendingInterjections.length
        ? `User interjections to address:\n${pendingInterjections.map(item => `- ${item}`).join('\n')}`
        : '',
      drift.length ? 'Unresolved drift exists; wait for a person to confirm before relying on those files.' : '',
      outOfScope.length ? `Out-of-scope changes were detected: ${outOfScope.map(item => item.path).join(', ')}` : '',
      'Write in the project language.',
    ]
    : [
      `项目室：${project?.name || ''}；检查点：${def?.name || instance.checkpointKey}`,
      `目标文件：${lines(def?.targetFiles).join('、') || '（无）'}`,
      accepted.length ? `已接受的上游版本：\n${accepted.map(item => `- ${item}`).join('\n')}` : '',
      role === 'review' && instance.candidate ? `正在评审的候选提交：${instance.candidate}` : '',
      reviewFiles.length ? `之前的评审文件：\n${reviewFiles.map(item => `- ${item}`).join('\n')}` : '',
      role === 'lead' && round > 1 ? `上一轮回应文件：${responseFile}` : '',
      pendingInterjections.length
        ? `需要处理的人的插话：\n${pendingInterjections.map(item => `- ${item}`).join('\n')}`
        : '',
      drift.length ? '存在未解决漂移，依赖这些文件前需要人确认。' : '',
      outOfScope.length ? `检测到越界改动：${outOfScope.map(item => item.path).join('、')}` : '',
      '用项目语言写作。',
    ]

  return [
    platformPrompt({
      role,
      rebuttal: currentRound?.rebuttal === true,
      language,
    }),
    profile?.text ? (english ? `Seat profile:\n${profile.text}` : `席位侧写：\n${profile.text}`) : '',
    english ? 'Checkpoint input:' : '检查点输入：',
    ...input.filter(Boolean),
  ].filter(Boolean).join('\n\n')
}

module.exports = { buildProjectRoomPrompt, platformPrompt }
