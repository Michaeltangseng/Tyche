const ROOM_SCHEMA_VERSION = 4

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace TEXT NOT NULL,
    write_authorized_root TEXT,
    providers_json TEXT NOT NULL DEFAULT '[]',
    allowed_capabilities_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_seq INTEGER NOT NULL DEFAULT 0,
    activity_seq INTEGER NOT NULL DEFAULT 0,
    captain_reviewed_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_roles (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    responsibilities TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    native_permission TEXT NOT NULL DEFAULT 'read-only',
    portrait TEXT NOT NULL DEFAULT '',
    skills_json TEXT NOT NULL DEFAULT '[]',
    is_captain INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_prompt_revisions (
    id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES chat_roles(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(role_id, revision)
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

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES chat_roles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    native_session_ref TEXT,
    baseline_seq INTEGER NOT NULL DEFAULT 0,
    prompt_revision INTEGER NOT NULL DEFAULT 1,
    permission_mode TEXT NOT NULL,
    workspace_ref TEXT NOT NULL,
    skill_bindings_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    thinking_level TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    rotate_reason TEXT,
    created_at TEXT NOT NULL,
    rotated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES chat_roles(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id),
    last_seq INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY(chat_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    client_id TEXT,
    audience TEXT NOT NULL DEFAULT 'chat',
    author_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL DEFAULT '',
    mentions_json TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    task_id TEXT,
    root_message_id TEXT,
    captain_assignment_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    data_json TEXT,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT,
    UNIQUE(chat_id, seq),
    UNIQUE(chat_id, client_id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'todo',
    created_by_role_id TEXT REFERENCES chat_roles(id),
    assignee_role_id TEXT REFERENCES chat_roles(id),
    captain_assignment_id TEXT,
    parent_task_id TEXT,
    blocked_by_task_ids_json TEXT NOT NULL DEFAULT '[]',
    required_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    optional INTEGER NOT NULL DEFAULT 0,
    source_message_ids_json TEXT NOT NULL DEFAULT '[]',
    context_revision INTEGER NOT NULL DEFAULT 0,
    default_write_scopes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(chat_id, number)
  );

  CREATE TABLE IF NOT EXISTS task_activities (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    message_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, seq)
  );

  CREATE TABLE IF NOT EXISTS task_lanes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES chat_roles(id),
    kind TEXT NOT NULL DEFAULT 'executor',
    session_id TEXT REFERENCES sessions(id),
    last_seq INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, role_id, kind)
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    lane_id TEXT NOT NULL REFERENCES task_lanes(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES chat_roles(id),
    status TEXT NOT NULL DEFAULT 'queued',
    outcome TEXT NOT NULL DEFAULT 'pending',
    snapshot_state TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT REFERENCES sessions(id),
    required INTEGER NOT NULL DEFAULT 1,
    continues_run_id TEXT,
    previous_run_id TEXT,
    captain_assignment_id TEXT,
    machine TEXT,
    workspace_ref TEXT,
    write_scopes_json TEXT NOT NULL DEFAULT '[]',
    queued_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
    lane_id TEXT REFERENCES task_lanes(id),
    kind TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    next_request_json TEXT,
    attention_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attentions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    task_id TEXT,
    type TEXT NOT NULL,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    requested_by TEXT NOT NULL,
    answered_by TEXT,
    resolution_json TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    task_id TEXT,
    run_id TEXT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL,
    "commit" TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captain_assignments (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    root_message_id TEXT,
    target_role_ids_json TEXT NOT NULL DEFAULT '[]',
    target_reply_ids_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captain_reviews (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    assignment_id TEXT,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    checkpoint_seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    body TEXT NOT NULL DEFAULT '',
    data_json TEXT,
    reply_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(chat_id, dedupe_key)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(room_id, seq)
  );

  CREATE TABLE IF NOT EXISTS effects (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS user_commands (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, call_id)
  );

  CREATE TABLE IF NOT EXISTS domain_idempotency (
    key TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    task_id TEXT,
    mode TEXT NOT NULL,
    seq INTEGER,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS chats_room ON chats(room_id);
  CREATE INDEX IF NOT EXISTS chat_roles_chat ON chat_roles(chat_id);
  CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id, seq);
  CREATE INDEX IF NOT EXISTS messages_chat_client ON messages(chat_id, client_id);
  CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(scope_type, scope_id, role_id, state);
  CREATE INDEX IF NOT EXISTS tasks_chat_status ON tasks(chat_id, status);
  CREATE INDEX IF NOT EXISTS task_activities_task_seq ON task_activities(task_id, seq);
  CREATE INDEX IF NOT EXISTS task_lanes_task ON task_lanes(task_id);
  CREATE INDEX IF NOT EXISTS task_runs_task_status ON task_runs(task_id, status);
  CREATE INDEX IF NOT EXISTS task_runs_lane_status ON task_runs(lane_id, status);
  CREATE INDEX IF NOT EXISTS effects_status ON effects(status, created_at);
  CREATE INDEX IF NOT EXISTS effects_kind_status ON effects(kind, status);
  CREATE INDEX IF NOT EXISTS captain_reviews_status ON captain_reviews(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS captain_assignments_chat ON captain_assignments(chat_id, status);
  CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id);
  CREATE INDEX IF NOT EXISTS domain_idempotency_chat_kind ON domain_idempotency(chat_id, kind);
  CREATE INDEX IF NOT EXISTS runtime_events_run_seq ON runtime_events(run_id, seq);
  CREATE INDEX IF NOT EXISTS runtime_events_chat_created ON runtime_events(chat_id, created_at);
`

function ensurePortraitColumn(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_roles'").get()
  if (!table) return
  const columns = database.prepare('PRAGMA table_info(chat_roles)').all()
  if (columns.some(column => column.name === 'portrait')) return
  database.exec("ALTER TABLE chat_roles ADD COLUMN portrait TEXT NOT NULL DEFAULT ''")
}

function ensureRoomSchema(database) {
  const current = database.prepare('PRAGMA user_version').get().user_version
  if (current > ROOM_SCHEMA_VERSION) throw new Error('ROOM_DATABASE_VERSION_NEWER_THAN_RUNTIME')
  if (current !== ROOM_SCHEMA_VERSION) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(SCHEMA_SQL)
      database.exec(`PRAGMA user_version = ${ROOM_SCHEMA_VERSION}`)
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  }
  ensurePortraitColumn(database)
  ensureRoleSkillsColumn(database)
  ensureChatTitleLock(database)
}

function ensureRoleSkillsColumn(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_roles'").get()
  if (!table) return
  const columns = database.prepare('PRAGMA table_info(chat_roles)').all()
  if (columns.some(column => column.name === 'skills_json')) return
  database.exec("ALTER TABLE chat_roles ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'")
}

function ensureChatTitleLock(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chats'").get()
  if (!table) return
  const columns = database.prepare('PRAGMA table_info(chats)').all()
  if (columns.some(column => column.name === 'title_locked')) return
  database.exec('ALTER TABLE chats ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0')
}

module.exports = { ROOM_SCHEMA_VERSION, ensureRoomSchema }
