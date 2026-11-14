const fs = require('node:fs')
const { z } = require('zod')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')

const APP_PREFERENCES_VERSION = 1
const DEFAULTS = Object.freeze({
  version: APP_PREFERENCES_VERSION,
  projectRoomPreview: false,
})

const schema = z.strictObject({
  version: z.literal(APP_PREFERENCES_VERSION),
  projectRoomPreview: z.boolean(),
})

class AppPreferencesStore {
  constructor({
    storagePath,
    writeFile = atomicWritePrivateFile,
  } = {}) {
    if (!storagePath) throw new Error('PROJECT_INPUT_INVALID')
    this.storagePath = storagePath
    this.writeFile = writeFile
    this.value = structuredClone(DEFAULTS)
  }

  async load() {
    let source
    try {
      source = fs.readFileSync(this.storagePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.value = structuredClone(DEFAULTS)
        return this.get()
      }
      this.value = structuredClone(DEFAULTS)
      return this.get()
    }
    let value
    try {
      value = JSON.parse(source)
    } catch {
      value = null
    }
    const parsed = schema.safeParse(value)
    this.value = parsed.success ? parsed.data : structuredClone(DEFAULTS)
    return this.get()
  }

  get() {
    return structuredClone(this.value)
  }

  isProjectRoomEnabled() {
    return this.value.projectRoomPreview === true
  }

  async set(input) {
    const result = schema.safeParse({ ...this.value, ...input, version: APP_PREFERENCES_VERSION })
    if (!result.success) {
      throw Object.assign(new Error('PROJECT_INPUT_INVALID'), {
        code: 'PROJECT_INPUT_INVALID',
        details: {
          issues: result.error.issues.map(issue => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
      })
    }
    try {
      await this.writeFile(this.storagePath, `${JSON.stringify(result.data)}\n`)
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
    }
    this.value = result.data
    return this.get()
  }
}

module.exports = {
  APP_PREFERENCES_VERSION,
  AppPreferencesStore,
  appPreferencesSchema: schema,
}
