const CAPABILITIES = Object.freeze([
  'fullTrace', 'readExec', 'midTurnCancel', 'writeSessionContinuity', 'usage', 'managedProcess',
])

// Values follow docs/spikes/milestone-0-results.md. Anything not verified there
// stays false. fullTrace is only true where the ACP channel was verified.
const VERIFIED = Object.freeze({
  claude: {
    fullTrace: true,
    readExec: true,
    midTurnCancel: true,
    writeSessionContinuity: true,
    usage: true,
  },
  codex: {
    fullTrace: true,
    readExec: true,
    midTurnCancel: true,
    writeSessionContinuity: true,
    usage: true,
  },
})

function capabilitiesFor(kind, { platform = process.platform } = {}) {
  const verified = VERIFIED[kind] || {}
  return {
    fullTrace: verified.fullTrace === true,
    readExec: verified.readExec === true,
    midTurnCancel: verified.midTurnCancel === true,
    writeSessionContinuity: verified.writeSessionContinuity === true,
    usage: verified.usage === true,
    managedProcess: platform !== 'win32',
  }
}

function validateSeatCapabilities(agentKind, capabilities, options = {}) {
  const registered = capabilitiesFor(agentKind, options)
  const unsupported = []
  const values = Array.isArray(capabilities) ? capabilities : []
  for (const capability of values) {
    if (capability === 'read') continue
    if (capability === 'read-exec' && !registered.readExec) {
      unsupported.push({ capability: 'read-exec', reason: 'read-exec-unsupported' })
    }
    if (['write-drafts', 'write-workdir'].includes(capability) && !registered.managedProcess) {
      unsupported.push({ capability, reason: 'managed-process-unsupported' })
    }
  }
  return { ok: unsupported.length === 0, unsupported, capabilities: registered }
}

module.exports = {
  CAPABILITIES,
  capabilitiesFor,
  validateSeatCapabilities,
}
