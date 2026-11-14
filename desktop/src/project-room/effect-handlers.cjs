function missing(name) {
  return Object.assign(new Error('EFFECT_HANDLER_UNAVAILABLE'), {
    code: 'EFFECT_HANDLER_UNAVAILABLE',
    details: { handler: name },
  })
}

function createEffectHandlers({
  shadowRepo,
  userGit,
  writeReviewFile,
  appendDecision,
  stampChanges,
  appendMessage,
  appendTimeline,
  notify,
  detectAcceptedChanges,
  validateManifest = () => ({ valid: true, issues: [] }),
} = {}) {
  const repo = () => {
    if (!shadowRepo) throw missing('shadowRepo')
    return shadowRepo
  }
  return {
    'drift-check': async ({ effect }) => repo().driftCheck({
      effectId: effect.id,
      acceptedByPath: effect.params?.acceptedByPath || {},
      placeholderList: effect.params?.placeholderList || [],
      limits: effect.params?.limits || {},
    }),
    snapshot: async ({ effect }) => repo().snapshot({
      effectId: effect.id,
      targets: effect.params?.targets || [],
      placeholderList: effect.params?.placeholderList || [],
      limits: effect.params?.limits || {},
      isOptional: effect.params?.isOptional === true,
    }),
    'evaluate-submission': async ({ effect }) => {
      const params = effect.params || {}
      const targetFiles = params.targetFiles || []
      const responseFile = params.responseFile || ''
      const previous = params.previousCandidate || ''
      const candidate = params.candidate || ''
      const bodyChanged = previous
        ? !(await repo().diffQuiet(previous, candidate, targetFiles))
        : true
      let newResponse = false
      if (responseFile && previous) {
        newResponse = !(await repo().diffQuiet(previous, candidate, [responseFile]))
      }
      const manifest = validateManifest(params.manifest, { instance: params.instance })
      return {
        bodyChanged,
        newResponse,
        manifestValid: manifest.valid !== false,
        manifestIssues: manifest.issues || [],
      }
    },
    'verify-candidate': async ({ effect }) => repo().verifyAgainst({
      effectId: effect.id,
      commit: effect.params?.candidate,
      paths: effect.params?.paths || [],
      placeholderList: effect.params?.placeholderList || [],
      limits: effect.params?.limits || {},
    }),
    'verify-observed': async ({ effect }) => repo().verifyAgainst({
      effectId: effect.id,
      commit: effect.params?.observedCommit,
      paths: effect.params?.paths || [],
      placeholderList: effect.params?.placeholderList || [],
      limits: effect.params?.limits || {},
    }),
    'accept-commit': async ({ effect }) => ({
      commit: await repo().acceptCommit({
        effectId: effect.id,
        candidate: effect.params?.candidate,
        recordPaths: effect.params?.recordPaths || [],
        parent: effect.params?.parent || null,
        message: effect.params?.message || '',
      }),
    }),
    'restore-files': async ({ effect }) => repo().restoreFiles({
      commit: effect.params?.commit,
      paths: effect.params?.paths || [],
      isCancelled: effect.params?.isCancelled,
    }),
    'drop-snapshot-refs': async ({ effect }) => {
      await repo().dropRefs(effect.params?.refs || [])
      return null
    },
    'user-git-commit': async ({ effect }) => {
      if (!userGit?.userRepoCommit) throw missing('userRepoCommit')
      return userGit.userRepoCommit({
        workTree: effect.params?.workTree,
        paths: effect.params?.paths || [],
        acceptedEntries: effect.params?.acceptedEntries || {},
        message: effect.params?.message || '',
        decisionId: effect.params?.decisionId || '',
        onStaged: effect.params?.onStaged,
      })
    },
    'write-review-file': async ({ effect }) => {
      if (typeof writeReviewFile !== 'function') throw missing('writeReviewFile')
      await writeReviewFile(effect.params)
      return null
    },
    'append-decision': async ({ effect }) => {
      if (typeof appendDecision !== 'function') throw missing('appendDecision')
      await appendDecision(effect.params)
      return null
    },
    'stamp-changes': async ({ effect }) => {
      if (typeof stampChanges !== 'function') throw missing('stampChanges')
      await stampChanges(effect.params)
      return null
    },
    'append-message': async ({ effect }) => {
      if (typeof appendMessage !== 'function') throw missing('appendMessage')
      await appendMessage(effect.params)
      return null
    },
    'append-timeline': async ({ effect }) => {
      if (typeof appendTimeline !== 'function') throw missing('appendTimeline')
      await appendTimeline(effect.params)
      return null
    },
    'detect-accepted-changes': async ({ effect }) => {
      if (typeof detectAcceptedChanges !== 'function') throw missing('detectAcceptedChanges')
      return detectAcceptedChanges(effect.params)
    },
    notify: async ({ effect }) => {
      if (typeof notify === 'function') await notify(effect.params)
      return null
    },
  }
}

module.exports = { createEffectHandlers }
