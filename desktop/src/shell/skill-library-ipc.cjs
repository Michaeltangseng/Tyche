/**
 * Narrow IPC surface for the Skill library.
 *
 * Every request is validated here. The renderer never sends a path, a command,
 * or an executable reference; only stable IDs and bounded text cross the bridge.
 * Paths stay in the main process, and `reveal` opens a path resolved by the
 * library itself.
 */
const { AGENT_KINDS } = require('../skills/skill-adapters.cjs')
const { SOURCE_ID, TOKEN } = require('../skills/skill-market.cjs')
const { PROJECTION_ID, SKILL_ID, validSkillName } = require('../skills/skill-library-util.cjs')

const CHANNELS = Object.freeze({
  summary: 'skill-library:summary',
  list: 'skill-library:list',
  detail: 'skill-library:detail',
  policy: 'skill-library:policy',
  updatePolicy: 'skill-library:policy-update',
  trust: 'skill-library:trust',
  revokeTrust: 'skill-library:revoke-trust',
  setEligible: 'skill-library:set-eligible',
  importFromAgent: 'skill-library:import',
  create: 'skill-library:create',
  update: 'skill-library:update',
  remove: 'skill-library:remove',
  project: 'skill-library:project',
  unproject: 'skill-library:unproject',
  resolveProjection: 'skill-library:resolve-projection',
  reveal: 'skill-library:reveal',
  marketSources: 'skill-library:market-sources',
  marketAddSource: 'skill-library:market-add-source',
  marketRemoveSource: 'skill-library:market-remove-source',
  marketPreview: 'skill-library:market-preview',
  marketInstall: 'skill-library:market-install',
  marketCheckUpdates: 'skill-library:market-check-updates',
  marketPreviewUpdate: 'skill-library:market-preview-update',
  marketApplyUpdate: 'skill-library:market-apply-update',
})

const MAX_BODY = 100_000
const MAX_TARGETS = 11
const MAX_IMPORT_IDS = 64
const PROJECTION_ACTIONS = new Set(['restore', 'adopt', 'unmanage'])

function ipcError(code) {
  return Object.assign(new Error(code), { code })
}

function assertInput(input, fields = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  }
  const keys = Object.keys(input)
  if (keys.some(key => !fields.includes(key))) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  return input
}

function optionalInput(input, fields = []) {
  if (input === undefined || input === null) return {}
  return assertInput(input, fields)
}

function text(value, max = 120) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  }
  return value
}

function skillId(value) {
  const id = text(value, 240)
  if (!SKILL_ID.test(id)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  return id
}

function agent(value) {
  const kind = text(value, 40)
  if (!AGENT_KINDS.includes(kind)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  return kind
}

function optBoolean(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  return value
}

function optionalBody(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_BODY) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  return value
}

function stringList(value, max, validate) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
  }
  return value.map((item) => {
    if (typeof item !== 'string') throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return validate(item)
  })
}

function registerSkillLibraryIpc({ registerTrustedHandle, getLibrary, shell } = {}) {
  if (typeof registerTrustedHandle !== 'function') {
    throw new TypeError('SKILL_LIBRARY_IPC_DEPENDENCIES_REQUIRED')
  }
  const library = () => {
    const value = getLibrary?.()
    if (!value) throw ipcError('SKILL_LIBRARY_UNAVAILABLE')
    return value
  }

  registerTrustedHandle(CHANNELS.summary, () => library().summary())

  registerTrustedHandle(CHANNELS.list, (input) => {
    const parsed = optionalInput(input, ['filter', 'query'])
    if (parsed.filter !== undefined) text(parsed.filter, 40)
    if (parsed.query !== undefined && typeof parsed.query !== 'string') {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    return library().list()
  })

  registerTrustedHandle(CHANNELS.detail, (input) => {
    const parsed = assertInput(input, ['id'])
    return library().detail(skillId(parsed.id))
  })

  registerTrustedHandle(CHANNELS.policy, () => library().policy())

  registerTrustedHandle(CHANNELS.updatePolicy, (input) => {
    const fields = ['untrustedByDefault', 'revokeOnChange', 'denySkillNetwork']
    const parsed = assertInput(input, fields)
    if (!fields.some(key => parsed[key] !== undefined)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    for (const key of fields) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'boolean') {
        throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
      }
    }
    return library().updatePolicy(parsed)
  })

  registerTrustedHandle(CHANNELS.trust, (input) => {
    const parsed = assertInput(input, ['id'])
    return library().trust(skillId(parsed.id))
  })

  registerTrustedHandle(CHANNELS.revokeTrust, (input) => {
    const parsed = assertInput(input, ['id'])
    return library().revokeTrust(skillId(parsed.id))
  })

  registerTrustedHandle(CHANNELS.setEligible, (input) => {
    const parsed = assertInput(input, ['id', 'agent', 'enabled'])
    if (typeof parsed.enabled !== 'boolean') throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().setEligible(skillId(parsed.id), agent(parsed.agent), parsed.enabled)
  })

  registerTrustedHandle(CHANNELS.importFromAgent, (input) => {
    const parsed = assertInput(input, ['ids', 'onConflict', 'trust'])
    const ids = stringList(parsed.ids, MAX_IMPORT_IDS, skillId)
    if (parsed.onConflict !== undefined && !['rename', 'replace', 'error'].includes(parsed.onConflict)) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    return library().importFromAgent({
      ids,
      onConflict: parsed.onConflict || 'rename',
      trust: optBoolean(parsed.trust) === true,
    })
  })

  registerTrustedHandle(CHANNELS.create, (input) => {
    const parsed = assertInput(input, ['name', 'description', 'body', 'targets'])
    const name = text(parsed.name, 64)
    if (!validSkillName(name)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    if (typeof parsed.description !== 'string' || parsed.description.length > 2000) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    const body = optionalBody(parsed.body)
    if (body === undefined) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    const targets = parsed.targets === undefined
      ? []
      : stringList(parsed.targets, MAX_TARGETS, agent)
    return library().create({ name, description: parsed.description, body, targets })
  })

  registerTrustedHandle(CHANNELS.update, (input) => {
    const parsed = assertInput(input, ['id', 'description', 'body'])
    if (parsed.description === undefined && parsed.body === undefined) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    if (parsed.description !== undefined
        && (typeof parsed.description !== 'string' || parsed.description.length > 2000)) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    return library().update({
      id: skillId(parsed.id),
      description: parsed.description,
      body: optionalBody(parsed.body),
    })
  })

  registerTrustedHandle(CHANNELS.remove, (input) => {
    const parsed = assertInput(input, ['id', 'confirmName'])
    return library().remove({
      id: skillId(parsed.id),
      confirmName: text(parsed.confirmName, 120),
    })
  })

  registerTrustedHandle(CHANNELS.project, (input) => {
    const parsed = assertInput(input, ['id', 'agent'])
    return library().project(skillId(parsed.id), agent(parsed.agent))
  })

  registerTrustedHandle(CHANNELS.unproject, (input) => {
    const parsed = assertInput(input, ['id', 'agent'])
    return library().unproject(skillId(parsed.id), agent(parsed.agent))
  })

  registerTrustedHandle(CHANNELS.resolveProjection, (input) => {
    const parsed = assertInput(input, ['projectionId', 'action'])
    const id = text(parsed.projectionId, 80)
    if (!PROJECTION_ID.test(id)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    if (!PROJECTION_ACTIONS.has(parsed.action)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().resolveProjection({ projectionId: id, action: parsed.action })
  })

  registerTrustedHandle(CHANNELS.reveal, async (input) => {
    const parsed = assertInput(input, ['id'])
    const target = library().revealPath(skillId(parsed.id))
    if (typeof shell?.openPath !== 'function') throw ipcError('SKILL_LIBRARY_UNAVAILABLE')
    const error = await shell.openPath(target)
    return { opened: !error }
  })

  registerTrustedHandle(CHANNELS.marketSources, () => library().market.listSources())

  registerTrustedHandle(CHANNELS.marketAddSource, (input) => {
    const parsed = assertInput(input, ['url', 'ref', 'subpath'])
    const url = text(parsed.url, 2000)
    const ref = parsed.ref === undefined ? '' : text(parsed.ref, 200)
    const subpath = parsed.subpath === undefined ? '' : text(parsed.subpath, 300)
    return library().market.addSource({ url, ref, subpath })
  })

  registerTrustedHandle(CHANNELS.marketRemoveSource, (input) => {
    const parsed = assertInput(input, ['sourceId'])
    const sourceId = text(parsed.sourceId, 80)
    if (!SOURCE_ID.test(sourceId)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.removeSource(sourceId)
  })

  registerTrustedHandle(CHANNELS.marketPreview, async (input) => {
    const parsed = assertInput(input, ['sourceId'])
    const sourceId = text(parsed.sourceId, 80)
    if (!SOURCE_ID.test(sourceId)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.previewSource(sourceId)
  })

  registerTrustedHandle(CHANNELS.marketInstall, (input) => {
    const parsed = assertInput(input, ['token', 'trust'])
    const token = text(parsed.token, 80)
    if (!TOKEN.test(token)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.installEntry({ token, trust: optBoolean(parsed.trust) === true })
  })

  registerTrustedHandle(CHANNELS.marketCheckUpdates, () => library().market.checkUpdates())

  registerTrustedHandle(CHANNELS.marketPreviewUpdate, async (input) => {
    const parsed = assertInput(input, ['skillId'])
    return library().market.previewUpdate({ skillId: skillId(parsed.skillId) })
  })

  registerTrustedHandle(CHANNELS.marketApplyUpdate, (input) => {
    const parsed = assertInput(input, ['skillId', 'token', 'trust'])
    const token = text(parsed.token, 80)
    if (!TOKEN.test(token)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.applyUpdate({
      skillId: skillId(parsed.skillId),
      token,
      trust: optBoolean(parsed.trust) === true,
    })
  })
}

module.exports = { CHANNELS, registerSkillLibraryIpc }
