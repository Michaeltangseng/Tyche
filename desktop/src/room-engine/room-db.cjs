const fs = require('node:fs')
const path = require('node:path')

const { DatabaseSync } = (() => {
  try {
    return require('node:sqlite')
  } catch (error) {
    const wrapped = new Error('ROOM_ENGINE_SQLITE_UNAVAILABLE')
    wrapped.cause = error
    throw wrapped
  }
})()

const { ensurePrivateDirectory } = require('../security/private-file.cjs')

const ROOM_SCHEMA_VERSION = 2

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function openRoomDatabase({ directory, filename = 'db.sqlite' }) {
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
  migrate(database)
  let transactionDepth = 0
  return {
    database,
    databasePath,
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

function migrate(database) {
  const current = database.prepare('PRAGMA user_version').get().user_version
  if (current > ROOM_SCHEMA_VERSION) throw new Error('ROOM_DATABASE_VERSION_NEWER_THAN_RUNTIME')
  if (current === 0) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace TEXT NOT NULL,
        primary_chat_id TEXT,
        providers_json TEXT NOT NULL DEFAULT '[]',
        allowed_capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        engine_version TEXT NOT NULL,
        controller_session_id TEXT,
        context_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        author_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        reply_to TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        UNIQUE(chat_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS agent_roles (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        responsibilities TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        prompt_revision INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        creation_reason TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_task_id TEXT,
        blocked_by_task_ids_json TEXT NOT NULL DEFAULT '[]',
        required_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        optional INTEGER NOT NULL DEFAULT 0,
        waiting_for_json TEXT,
        context_revision INTEGER NOT NULL,
        inputs_json TEXT NOT NULL DEFAULT '[]',
        latest_report_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES agent_roles(id),
        native_session_id TEXT,
        run_id TEXT,
        workspace_ref TEXT,
        write_scopes_json TEXT NOT NULL DEFAULT '[]',
        required INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 1,
        previous_assignment_id TEXT,
        status TEXT NOT NULL,
        ended_reason TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        next_request_json TEXT,
        attention_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        source_task_id TEXT,
        source_assignment_id TEXT,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        supersedes_artifact_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attentions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        task_id TEXT,
        type TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        resolution_json TEXT,
        requested_by TEXT NOT NULL,
        answered_by TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS controller_decisions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL,
        context_revision INTEGER NOT NULL,
        input_ids_json TEXT NOT NULL DEFAULT '[]',
        action_ids_json TEXT NOT NULL DEFAULT '[]',
        results_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        latency_ms INTEGER,
        cost REAL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_context_revisions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        changes_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chat_id, revision)
      );
      CREATE TABLE IF NOT EXISTS role_prompt_revisions (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(role_id, revision)
      );
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        action_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        type TEXT NOT NULL,
        report_id TEXT,
        action_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(room_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS messages_chat_sequence ON messages(chat_id, sequence);
      CREATE INDEX IF NOT EXISTS events_chat_sequence ON events(chat_id, sequence);
      CREATE INDEX IF NOT EXISTS tasks_chat_status ON tasks(chat_id, status);
      CREATE INDEX IF NOT EXISTS effects_status ON effects(status, created_at);
    `)
    database.exec(`PRAGMA user_version = ${ROOM_SCHEMA_VERSION}`)
  } else if (current === 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS chat_context_revisions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        changes_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chat_id, revision)
      );
      CREATE TABLE IF NOT EXISTS role_prompt_revisions (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(role_id, revision)
      );
    `)
    database.exec(`PRAGMA user_version = ${ROOM_SCHEMA_VERSION}`)
  }
}

function encode(value) {
  return json(value) ?? 'null'
}

module.exports = { ROOM_SCHEMA_VERSION, encode, openRoomDatabase }
