/**
 * Narrow IPC surface for the Skill library.
 *
 * Every request is validated here. The renderer never sends a path, a command,
 * or an executable reference; only stable IDs and bounded text cross the bridge.
 * Paths stay in the main process, and `reveal` opens a path resolved by the
 * library itself.
 */
const { SOURCE_ID, TOKEN } = require('../skills/skill-market.cjs')
const { SKILL_ID, validSkillName } = require('../skills/skill-library-util.cjs')

const CHANNELS = Object.freeze({
  summary: 'skill-library:summary',
  list: 'skill-library:list',
  detail: 'skill-library:detail',
  create: 'skill-library:create',
  update: 'skill-library:update',
  promote: 'skill-library:promote',
  remove: 'skill-library:remove',
  reveal: 'skill-library:reveal',
  marketCatalog: 'skill-library:market-catalog',
  marketInstallCatalog: 'skill-library:market-install-catalog',
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

  registerTrustedHandle(CHANNELS.create, (input) => {
    const parsed = assertInput(input, ['name', 'description', 'body'])
    const name = text(parsed.name, 64)
    if (!validSkillName(name)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    if (typeof parsed.description !== 'string' || parsed.description.length > 2000) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    const body = optionalBody(parsed.body)
    if (body === undefined) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().create({ name, description: parsed.description, body })
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

  registerTrustedHandle(CHANNELS.promote, (input) => {
    const parsed = assertInput(input, ['id'])
    return library().promote(skillId(parsed.id))
  })

  registerTrustedHandle(CHANNELS.remove, (input) => {
    const parsed = assertInput(input, ['id', 'confirmName'])
    return library().remove({
      id: skillId(parsed.id),
      confirmName: text(parsed.confirmName, 120),
    })
  })

  registerTrustedHandle(CHANNELS.reveal, async (input) => {
    const parsed = assertInput(input, ['id'])
    const target = library().revealPath(skillId(parsed.id))
    if (typeof shell?.openPath !== 'function') throw ipcError('SKILL_LIBRARY_UNAVAILABLE')
    const error = await shell.openPath(target)
    return { opened: !error }
  })

  registerTrustedHandle(CHANNELS.marketCatalog, () => library().market.catalog())

  registerTrustedHandle(CHANNELS.marketInstallCatalog, async (input) => {
    const parsed = assertInput(input, ['id'])
    const id = text(parsed.id, 160)
    if (!/^[a-z0-9][a-z0-9-]{0,40}\/[a-z0-9][a-z0-9-]{0,80}$/.test(id)) {
      throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    }
    return library().market.installCatalogEntry({ id })
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
    const parsed = assertInput(input, ['token', 'repo'])
    const token = text(parsed.token, 80)
    if (!TOKEN.test(token)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.installEntry({
      token,
      repo: optBoolean(parsed.repo) === true,
    })
  })

  registerTrustedHandle(CHANNELS.marketCheckUpdates, () => library().market.checkUpdates())

  registerTrustedHandle(CHANNELS.marketPreviewUpdate, async (input) => {
    const parsed = assertInput(input, ['skillId'])
    return library().market.previewUpdate({ skillId: skillId(parsed.skillId) })
  })

  registerTrustedHandle(CHANNELS.marketApplyUpdate, (input) => {
    const parsed = assertInput(input, ['skillId', 'token'])
    const token = text(parsed.token, 80)
    if (!TOKEN.test(token)) throw ipcError('SKILL_LIBRARY_INPUT_INVALID')
    return library().market.applyUpdate({
      skillId: skillId(parsed.skillId),
      token,
    })
  })
}

module.exports = { CHANNELS, registerSkillLibraryIpc }
