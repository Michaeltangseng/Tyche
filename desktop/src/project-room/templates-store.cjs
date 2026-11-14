const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { z } = require('zod')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { checkpointDefSchema } = require('./project-state-schema.cjs')

const TEMPLATES_SCHEMA_VERSION = 1
const BUILTIN_TEMPLATE_ID = 'builtin-default'
const CAPABILITIES = ['read', 'read-exec', 'write-drafts', 'write-workdir']

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const id = z.string().min(1).max(120).regex(ID)
const agentKind = z.string().min(1).max(40).regex(AGENT_KIND)
const timestamp = z.union([z.string().max(80).regex(TIMESTAMP), z.number().int().nonnegative()])
const text = limit => z.string().max(limit)

const seatTemplate = z.strictObject({
  key: id,
  roleName: text(40),
  duty: text(200),
  agentKind: agentKind.nullable(),
  capabilities: z.array(z.enum(CAPABILITIES)).max(8),
  profileText: text(16384),
})

const templateRecord = z.strictObject({
  id,
  version: z.number().int().positive(),
  name: text(80),
  checkpointDefs: z.array(checkpointDefSchema).max(256),
  seatTemplates: z.array(seatTemplate).max(64),
  createdAt: timestamp,
  source: z.enum(['builtin', 'user-saved', 'retro-adopted', 'rollback']),
})

const templatesFile = z.strictObject({
  schemaVersion: z.literal(TEMPLATES_SCHEMA_VERSION),
  templates: z.array(templateRecord).max(1000),
})

const saveInput = z.strictObject({
  name: text(80),
  checkpointDefs: z.array(checkpointDefSchema).min(1).max(256),
  seatTemplates: z.array(seatTemplate).min(1).max(64),
})

const updateInput = z.strictObject({
  id,
  name: text(80).optional(),
  checkpointDefs: z.array(checkpointDefSchema).min(1).max(256).optional(),
  seatTemplates: z.array(seatTemplate).min(1).max(64).optional(),
})

const rollbackInput = z.strictObject({
  id,
  version: z.number().int().positive(),
})

function inputError(details = {}) {
  return Object.assign(new Error('PROJECT_INPUT_INVALID'), {
    code: 'PROJECT_INPUT_INVALID',
    details,
  })
}

function parseInput(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw inputError({
      issues: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
        ...(issue.keys ? { keys: issue.keys } : {}),
      })),
    })
  }
  return result.data
}

// Placeholder for the default playbook: one checkpoint. The full nine-step
// playbook with seat profiles arrives in milestone 8.
function builtinTemplate() {
  return {
    id: BUILTIN_TEMPLATE_ID,
    version: 1,
    name: 'Default playbook',
    checkpointDefs: [{
      key: 'requirements',
      name: 'Requirements',
      type: 'document',
      targetFiles: ['docs/requirements.md'],
      leadSeatId: 'seat-lead',
      reviewerSeatIds: ['seat-reviewer'],
      draftSeatIds: [],
      gate: 'hard',
      roundLimit: 3,
      continuationLimit: 3,
      producesChecklist: false,
      dependsOn: [],
    }],
    seatTemplates: [
      {
        key: 'seat-lead',
        roleName: 'Lead writer',
        duty: 'Write the requirements document.',
        agentKind: 'codex',
        capabilities: ['read', 'write-workdir'],
        profileText: 'Write a coherent, complete draft and keep scope explicit.',
      },
      {
        key: 'seat-reviewer',
        roleName: 'Reviewer',
        duty: 'Review the requirements document.',
        agentKind: 'claude',
        capabilities: ['read'],
        profileText: 'Find missing requirements, contradictions, and unrealistic assumptions.',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'builtin',
  }
}

class TemplatesStore {
  constructor({
    storagePath,
    now = () => new Date().toISOString(),
    writeFile = atomicWritePrivateFile,
    createId = () => `template-${randomUUID()}`,
  } = {}) {
    if (!storagePath) throw inputError({ reason: 'storage-path-required' })
    this.storagePath = storagePath
    this.now = now
    this.writeFile = writeFile
    this.createId = createId
    this.templates = null
    this.readOnly = false
    this.readOnlyCode = ''
  }

  async load() {
    let source
    try {
      source = fs.readFileSync(this.storagePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.templates = []
        return this.list()
      }
      this.readOnly = true
      this.readOnlyCode = 'unreadable'
      this.templates = null
      return this.list()
    }
    let value
    try {
      value = JSON.parse(source)
    } catch {
      this.readOnly = true
      this.readOnlyCode = 'corrupt'
      this.templates = null
      return this.list()
    }
    if (Number(value?.schemaVersion) > TEMPLATES_SCHEMA_VERSION) {
      this.readOnly = true
      this.readOnlyCode = 'schema-version-newer'
      this.templates = null
      return this.list()
    }
    const parsed = templatesFile.safeParse(value)
    if (!parsed.success) {
      this.readOnly = true
      this.readOnlyCode = 'corrupt'
      this.templates = null
      return this.list()
    }
    this.templates = parsed.data.templates
    return this.list()
  }

  isReadOnly() {
    return this.readOnly
  }

  readOnlyReason() {
    return this.readOnlyCode
  }

  builtin() {
    return structuredClone(builtinTemplate())
  }

  list() {
    const latest = new Map()
    for (const template of this.templates || []) {
      const current = latest.get(template.id)
      if (!current || template.version > current.version) latest.set(template.id, template)
    }
    return [...latest.values()].map(template => structuredClone(template))
  }

  versions(templateId) {
    return (this.templates || [])
      .filter(template => template.id === templateId)
      .sort((left, right) => left.version - right.version)
      .map(template => structuredClone(template))
  }

  get(templateId, version) {
    if (templateId === BUILTIN_TEMPLATE_ID && (version === undefined || version === 1)) {
      return this.builtin()
    }
    const versions = this.versions(templateId)
    if (!versions.length) return null
    if (version === undefined) return versions[versions.length - 1]
    return versions.find(template => template.version === version) || null
  }

  #assertWritable() {
    if (this.readOnly) throw Object.assign(new Error('PROJECT_READ_ONLY'), { code: 'PROJECT_READ_ONLY' })
    if (!this.templates) throw inputError({ reason: 'not-loaded' })
  }

  async save(input) {
    const value = parseInput(saveInput, input)
    this.#assertWritable()
    let templateId = ''
    for (let attempt = 0; attempt < 100 && !templateId; attempt += 1) {
      const candidate = this.createId()
      if (!this.get(candidate)) templateId = candidate
    }
    if (!templateId) throw inputError({ reason: 'template-id-unavailable' })
    return this.#append({
      id: templateId,
      version: 1,
      name: value.name,
      checkpointDefs: value.checkpointDefs,
      seatTemplates: value.seatTemplates,
      createdAt: this.now(),
      source: 'user-saved',
    })
  }

  async update(input) {
    const value = parseInput(updateInput, input)
    this.#assertWritable()
    const versions = this.versions(value.id)
    const latest = versions[versions.length - 1]
    if (!latest) throw inputError({ reason: 'template-not-found', templateId: value.id })
    return this.#append({
      id: value.id,
      version: latest.version + 1,
      name: value.name === undefined ? latest.name : value.name,
      checkpointDefs: value.checkpointDefs === undefined ? latest.checkpointDefs : value.checkpointDefs,
      seatTemplates: value.seatTemplates === undefined ? latest.seatTemplates : value.seatTemplates,
      createdAt: this.now(),
      source: 'user-saved',
    })
  }

  async rollback(input) {
    const value = parseInput(rollbackInput, input)
    this.#assertWritable()
    const target = this.get(value.id, value.version)
    if (!target) throw inputError({ reason: 'template-version-not-found', templateId: value.id })
    const versions = this.versions(value.id)
    const latest = versions[versions.length - 1] || target
    return this.#append({
      id: value.id,
      version: latest.version + 1,
      name: target.name,
      checkpointDefs: target.checkpointDefs,
      seatTemplates: target.seatTemplates,
      createdAt: this.now(),
      source: 'rollback',
    })
  }

  async #append(template) {
    const next = [...(this.templates || []), template]
    const parsed = templatesFile.safeParse({
      schemaVersion: TEMPLATES_SCHEMA_VERSION,
      templates: next,
    })
    if (!parsed.success) {
      throw inputError({
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      })
    }
    const contents = `${JSON.stringify(parsed.data)}\n`
    try {
      await this.writeFile(this.storagePath, contents)
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
    }
    this.templates = parsed.data.templates
    return structuredClone(template)
  }
}

module.exports = {
  BUILTIN_TEMPLATE_ID,
  TEMPLATES_SCHEMA_VERSION,
  TemplatesStore,
  builtinTemplate,
}
