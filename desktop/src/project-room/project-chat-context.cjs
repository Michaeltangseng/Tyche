const MAX_DOCUMENTS = 100
const MAX_CHANGES = 20

function versionEntries(state) {
  const docs = []
  for (const instance of state.instances || []) {
    const def = state.config.playbook.checkpointDefs
      .find(item => item.key === instance.checkpointKey)
    const version = instance.artifactVersions.at(-1)
    if (!version) continue
    const pendingVersion = Boolean(instance.gate?.reason === 'doc-new-version')
    const drift = (state.driftItems || []).some(item => (
      item.checkpointId === instance.id
        && (item.status === 'unresolved' || item.status === 'resolving')
    ))
    for (const path of def?.targetFiles || []) {
      docs.push({
        path,
        checkpointId: instance.id,
        checkpointKey: instance.checkpointKey,
        versionId: version.id,
        versionNumber: instance.artifactVersions.length,
        acceptedAt: version.acceptedAt,
        commit: version.commit,
        pendingVersion,
        drift,
      })
    }
  }
  return docs
}

function buildProjectChatContext({ project, state, groupId, language = 'zh' } = {}) {
  const docs = versionEntries(state)
  const shown = docs.slice(0, MAX_DOCUMENTS)
  const previous = state.chatReads?.[groupId] || {}
  const changes = docs.filter(doc => previous[doc.checkpointId] !== doc.versionId)
  const shownChanges = changes.slice(0, MAX_CHANGES)
  const versions = Object.fromEntries(docs.map(doc => [doc.checkpointId, doc.versionId]))
  const docsRoot = state.config.settings.docsRoot || 'meldwork/'
  const english = language === 'en'

  const lines = english
    ? [
      'Project room context (from project state; not other chats):',
      `Project: ${project?.name || project?.id || ''}; docs root: ${docsRoot}`,
      `Accepted documents (${Math.min(docs.length, MAX_DOCUMENTS)} of ${docs.length}):`,
      ...shown.map(doc => (
        `- ${doc.path} (checkpoint ${doc.checkpointKey}, version ${doc.versionNumber}, accepted ${doc.acceptedAt})`
          + `${doc.pendingVersion ? ' [new version pending]' : ''}`
          + `${doc.drift ? ' [unresolved drift]' : ''}`
      )),
    ]
    : [
      '项目室上下文（来自项目状态，不是其他群聊的讨论）：',
      `项目室：${project?.name || project?.id || ''}；文档根目录：${docsRoot}`,
      `已接受文档（显示 ${Math.min(docs.length, MAX_DOCUMENTS)} 份，共 ${docs.length} 份）：`,
      ...shown.map(doc => (
        `- ${doc.path}（检查点 ${doc.checkpointKey}，版本 ${doc.versionNumber}，接受于 ${doc.acceptedAt}）`
          + `${doc.pendingVersion ? ' [待确认的新版本]' : ''}`
          + `${doc.drift ? ' [有未解决漂移]' : ''}`
      )),
    ]

  if (shownChanges.length) {
    lines.push(english
      ? `Changes since this chat last read them (${shownChanges.length}${changes.length > shownChanges.length ? ` of ${changes.length}` : ''}):`
      : `自这个群聊上次读取以来的变化（${shownChanges.length}${changes.length > shownChanges.length ? ` / ${changes.length}` : ''} 条）：`)
    for (const change of shownChanges) {
      lines.push(english
        ? `- ${change.path}: version ${change.versionNumber} accepted at ${change.acceptedAt}`
        : `- ${change.path}：版本 ${change.versionNumber}，接受于 ${change.acceptedAt}`)
    }
    if (changes.length > shownChanges.length) {
      lines.push(english
        ? `- There are ${changes.length - shownChanges.length} more changes; see ${docsRoot}changes.md.`
        : `- 还有 ${changes.length - shownChanges.length} 项变化，见 ${docsRoot}changes.md。`)
    }
  }

  lines.push(english
    ? 'When you modify an accepted document, append a record to ' + `${docsRoot}changes.md`
      + ': `- [path=<path> from=<accepted commit>]` followed by the explanation. Do not modify existing reviews or decisions.'
    : `修改已接受文档时，在 ${docsRoot}changes.md 追加一条记录：\`- [path=<路径> from=<已接受提交>]\`，说明写在下面。不要修改已有的评审或决策记录。`)
  lines.push(english
    ? 'Documents are the source of truth; conclusions from other chats must be written into them.'
    : '文档才是真源；其他群聊的讨论不在上下文中，需要的结论应当写进文档。')

  return {
    text: lines.join('\n'),
    versions,
    changeCount: changes.length,
    documentCount: docs.length,
  }
}

module.exports = { MAX_CHANGES, MAX_DOCUMENTS, buildProjectChatContext }
