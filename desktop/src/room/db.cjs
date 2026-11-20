const fs = require('node:fs')
const path = require('node:path')

const { DatabaseSync } = (() => {
  try {
    return require('node:sqlite')
  } catch (error) {
    const wrapped = new Error('ROOM_SQLITE_UNAVAILABLE')
    wrapped.cause = error
    throw wrapped
  }
})()

const { ensurePrivateDirectory } = require('../security/private-file.cjs')
const { ROOM_SCHEMA_VERSION, ensureRoomSchema } = require('./schema.cjs')

function openRoomDatabase({ directory, filename = 'room.sqlite', onCommit = () => {} }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('ROOM_DATABASE_DIRECTORY_MUST_BE_ABSOLUTE')
  }
  if (typeof filename !== 'string' || filename.length === 0 || path.basename(filename) !== filename) {
    throw new TypeError('ROOM_DATABASE_FILENAME_MUST_BE_BASENAME')
  }
  ensurePrivateDirectory(directory)
  const databasePath = path.join(directory, filename)
  const database = new DatabaseSync(databasePath)
  if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  ensureRoomSchema(database)
  let transactionDepth = 0
  const commitListeners = new Set()
  return {
    database,
    databasePath,
    onCommit(listener) {
      if (typeof listener !== 'function') throw new TypeError('ROOM_COMMIT_LISTENER_INVALID')
      commitListeners.add(listener)
      return () => commitListeners.delete(listener)
    },
    close: () => database.close(),
    withTransaction(callback) {
      const savepoint = `room_tx_${transactionDepth}`
      const nested = transactionDepth > 0
      database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      transactionDepth += 1
      try {
        const result = callback(database)
        if (result && typeof result.then === 'function') throw new TypeError('ROOM_TRANSACTION_MUST_BE_SYNCHRONOUS')
        database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
        if (!nested) {
          try { onCommit() } catch { /* notifications must never change a committed result */ }
          for (const listener of commitListeners) {
            try { listener() } catch { /* notifications must never change a committed result */ }
          }
        }
        return result
      } catch (error) {
        try {
          if (nested) {
            database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            database.exec(`RELEASE SAVEPOINT ${savepoint}`)
          } else database.exec('ROLLBACK')
        } catch { /* preserve original error */ }
        throw error
      } finally {
        transactionDepth -= 1
      }
    },
  }
}

module.exports = { ROOM_SCHEMA_VERSION, openRoomDatabase }
