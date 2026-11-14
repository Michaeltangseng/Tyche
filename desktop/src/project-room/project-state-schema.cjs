const path = require('node:path')
const { z } = require('zod')

const PROJECT_STATE_SCHEMA_VERSION = 1

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const id = z.string().min(1).max(120).regex(ID)
const agentKind = z.string().min(1).max(40).regex(AGENT_KIND)
const commit = z.string().regex(COMMIT)
const timestamp = z.union([z.string().max(80).regex(TIMESTAMP), z.number().int().nonnegative()])
const text = limit => z.string().max(limit)
const relativePath = z.string().max(4096).refine(value => (
  !value.includes('\0')
    && !value.startsWith('/')
    && !value.split('/').some(segment => segment === '..' || segment === '.')
), { message: 'path must be normalized, relative, and free of NUL' })
const absolutePath = z.string().min(1).max(4096).refine(value => (
  !value.includes('\0') && path.isAbsolute(value)
), { message: 'path must be absolute' })

const CAPABILITIES = ['read', 'read-exec', 'write-drafts', 'write-workdir']
const CHECKPOINT_TYPES = [
  'interview', 'research', 'document', 'readiness', 'milestone', 'final-review', 'retro',
]
const CHECKPOINT_STATES = [
  'pending', 'checking', 'drafting', 'leading', 'submitted', 'reviewing',
  'gate', 'accepting', 'accepted', 'stale',
]
const SEAT_ROLES = ['lead', 'reviewer', 'draft']
const GATE_REASONS = [
  'hard-gate-passed', 'needs-human', 'question', 'draft-question', 'artifact-unchanged',
  'round-limit', 'continuation-limit', 'marker-missing', 'manifest-invalid', 'failure',
  'recovery', 'drift', 'doc-new-version', 'review-failed', 'rebuttal-rejected',
]
const GATE_OUTCOMES = ['continue', 'accept', 'reject-upstream']
const EFFECT_TYPES = [
  'drift-check', 'snapshot', 'evaluate-submission', 'verify-candidate',
  'invoke-lead', 'invoke-draft', 'invoke-reviewer', 'cancel-invocation',
  'write-review-file', 'detect-accepted-changes', 'append-decision', 'stamp-changes',
  'acquire-scope', 'release-scope', 'withdraw-lease', 'verify-observed',
  'accept-commit', 'restore-files', 'user-git-commit', 'reconcile-scheduler',
  'append-message', 'append-timeline', 'drop-snapshot-refs', 'notify', 'drain-check',
]
const EFFECT_CATEGORIES = ['required', 'invocation', 'external', 'cleanup', 'best-effort']
const EFFECT_STATUSES = ['pending', 'started', 'consumed', 'voided', 'failed']
const LEASE_STATUSES = ['waiting', 'granted', 'releasing', 'withdrawn', 'released']
const LEASE_HOLDER_KINDS = ['checkpoint-scope', 'project-maintenance']
const CLAIM_MODES = ['exclusive', 'shared-legacy']
const INVOCATION_ROLES = ['lead', 'draft', 'reviewer']
const REVIEW_VERDICTS = ['pass', 'revise', 'needs-human', 'missing', 'failed', 'cancelled']
const DRAFT_STATUSES = ['pending', 'ready', 'question', 'failed', 'cancelled']
const INTERJECTION_STATUSES = ['queued', 'delivered']
const DRIFT_SOURCES = ['accept-candidate', 'drift-check']
const DRIFT_STATUSES = ['unresolved', 'resolving', 'resolved', 'voided']
const OUT_OF_SCOPE_ATTRIBUTION = ['attributed', 'unattributed', 'uncertain']
const OUT_OF_SCOPE_STATUSES = ['unresolved', 'resolved']
const ARTIFACT_SOURCES = ['gate', 'soft-gate', 'accepted-doc-change', 'drift-confirmation']
const PROFILE_SOURCES = ['default', 'user-edit', 'retro-adopted', 'rollback']
const CHAT_WRITE_CHECK_STATUSES = ['running', 'pending-detection']
const DELETION_PHASES = ['draining', 'drained']
const LANGUAGES = ['zh', 'en']

const claim = z.strictObject({
  root: absolutePath,
  path: relativePath,
  mode: z.enum(CLAIM_MODES),
})

const claimList = z.array(claim).min(1).max(256)

const leaseHolder = z.strictObject({
  kind: z.enum(LEASE_HOLDER_KINDS),
  projectId: id,
  ownerId: id,
})

const leaseRequest = z.strictObject({
  id,
  holder: leaseHolder,
  chainEffectId: id,
  claims: claimList,
  epoch: z.number().int().nonnegative(),
  requestedAt: timestamp,
  status: z.enum(LEASE_STATUSES),
  grantedAt: timestamp.nullable(),
  releasedAt: timestamp.nullable(),
})

const effect = z.strictObject({
  id,
  type: z.enum(EFFECT_TYPES),
  category: z.enum(EFFECT_CATEGORIES),
  status: z.enum(EFFECT_STATUSES),
  epoch: z.number().int().nonnegative(),
  params: z.record(z.string().max(80), z.unknown()),
  result: z.unknown().nullable(),
  error: text(2000).nullable(),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
})

const projectEffect = effect.omit({ epoch: true })

const activeInvocation = z.strictObject({
  effectId: id,
  role: z.enum(INVOCATION_ROLES),
  seatId: id,
  agentKind,
  round: z.number().int().nonnegative(),
  sessionGeneration: z.number().int().nonnegative(),
  claims: z.array(claim).max(256),
  cancellationRequested: z.boolean(),
  processRegistryId: id.nullable(),
})

const pendingStart = z.union([
  z.strictObject({
    kind: z.literal('invocation'),
    effectId: id,
    role: z.enum(INVOCATION_ROLES),
    seatId: id,
    round: z.number().int().nonnegative(),
    sessionGeneration: z.number().int().nonnegative(),
    claims: z.array(claim).max(256),
  }),
  z.strictObject({
    kind: z.literal('deliver-interjection'),
    interjectionId: id,
    sessionGeneration: z.number().int().nonnegative(),
  }),
])

const roundReview = z.strictObject({
  seatId: id,
  verdict: z.enum(REVIEW_VERDICTS),
  reviewFile: relativePath,
  finishedAt: timestamp,
})

const round = z.strictObject({
  round: z.number().int().positive(),
  candidate: commit,
  rebuttal: z.boolean(),
  bodyChanged: z.boolean(),
  startedAt: timestamp,
  reviews: z.array(roundReview).max(64),
})

const roundSummary = z.strictObject({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  verdicts: z.strictObject({
    pass: z.number().int().nonnegative(),
    revise: z.number().int().nonnegative(),
    'needs-human': z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
})

const draft = z.strictObject({
  seatId: id,
  status: z.enum(DRAFT_STATUSES),
  effectId: id.nullable(),
  sessionGeneration: z.number().int().nonnegative(),
})

const interjection = z.strictObject({
  id,
  content: text(32768),
  status: z.enum(INTERJECTION_STATUSES),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
})

const blockerSignal = z.strictObject({
  kind: z.enum([
    'upstream-pending-version', 'upstream-drift', 'candidate-diverged',
    'out-of-scope', 'changes-header-missing', 'detection-skipped', 'same-agent-kind',
    'round-limit', 'artifact-unchanged', 'rebuttal',
  ]),
  checkpointId: id.nullable(),
  count: z.number().int().nonnegative().nullable(),
})

const reviewSummary = z.strictObject({
  seatId: id,
  verdict: z.enum(REVIEW_VERDICTS),
  summary: text(4000),
  reviewFile: relativePath,
})

const changedFile = z.strictObject({
  path: relativePath,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  binary: z.boolean(),
})

const softGateEntry = z.strictObject({
  checkpointId: id,
  name: text(120),
  rounds: z.number().int().nonnegative(),
  signals: z.array(blockerSignal).max(16),
})

const gateFirstScreen = z.strictObject({
  round: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  signals: z.array(blockerSignal).max(16),
  reviewSummaries: z.array(reviewSummary).max(16),
  changedFiles: z.array(changedFile).max(200),
  softGateSummary: z.array(softGateEntry).max(100),
  driftItemIds: z.array(id).max(200),
  outOfScopeItemIds: z.array(id).max(200),
  blockerCheckpointIds: z.array(id).max(200),
  changesHeaderMissing: z.boolean(),
  detectionSkipped: z.boolean(),
  candidateDiverged: z.boolean(),
})

const gateDecision = z.strictObject({
  gateId: id,
  gateRevision: z.number().int().positive(),
  reason: z.enum(GATE_REASONS),
  outcome: z.enum(GATE_OUTCOMES),
  comment: text(32768),
  candidateCommit: commit.nullable(),
  upstreamCheckpointId: id.nullable(),
  impactHash: text(128).nullable(),
  driftChoice: z.enum(['workdir', 'accepted']).nullable(),
  commitToGit: z.boolean(),
  decidedAt: timestamp,
})

const gate = z.strictObject({
  id,
  revision: z.number().int().positive(),
  reason: z.enum(GATE_REASONS),
  candidateCommit: commit.nullable(),
  createdAt: timestamp,
  firstScreen: gateFirstScreen,
})

const artifactVersion = z.strictObject({
  id,
  commit,
  candidateCommit: commit.nullable(),
  files: z.array(relativePath).max(2000),
  acceptedAt: timestamp,
  source: z.enum(ARTIFACT_SOURCES),
  decisionId: id.nullable(),
})

const instance = z.strictObject({
  id,
  checkpointKey: id,
  state: z.enum(CHECKPOINT_STATES),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  roundsSinceHuman: z.number().int().nonnegative(),
  continuations: z.number().int().nonnegative(),
  sessionGeneration: z.number().int().nonnegative(),
  candidate: commit.nullable(),
  rounds: z.array(round).max(1000),
  roundsSummary: z.array(roundSummary).max(1000),
  leaseRequests: z.array(leaseRequest).max(1000),
  activeInvocations: z.array(activeInvocation).max(64),
  pendingStart: pendingStart.nullable(),
  drafts: z.array(draft).max(64),
  interjections: z.array(interjection).max(500),
  gate: gate.nullable(),
  blockedOn: z.strictObject({
    effectId: id,
    error: text(2000),
    time: timestamp,
  }).nullable(),
  effects: z.array(effect).max(1000),
  artifactVersions: z.array(artifactVersion).max(2000),
  readVersions: z.record(id, id),
  decisions: z.array(gateDecision).max(200),
})

const seat = z.strictObject({
  id,
  roleName: text(40),
  duty: text(200),
  agentKind,
  capabilities: z.array(z.enum(CAPABILITIES)).max(8),
  checkpointRoles: z.array(z.strictObject({
    checkpointKey: id,
    role: z.enum(SEAT_ROLES),
  })).max(256),
  profileVersionId: id,
})

const profile = z.strictObject({
  id,
  seatId: id,
  version: z.number().int().positive(),
  text: text(16384),
  createdAt: timestamp,
  source: z.enum(PROFILE_SOURCES),
})

const checkpointDef = z.strictObject({
  key: id,
  name: text(120),
  type: z.enum(CHECKPOINT_TYPES),
  targetFiles: z.array(relativePath).max(256),
  leadSeatId: id,
  reviewerSeatIds: z.array(id).max(64),
  draftSeatIds: z.array(id).max(64),
  gate: z.enum(['soft', 'hard']),
  roundLimit: z.number().int().positive().max(100).nullable(),
  continuationLimit: z.number().int().nonnegative().max(1000).nullable(),
  producesChecklist: z.boolean(),
  dependsOn: z.array(id).max(64),
})

const playbook = z.strictObject({
  templateId: id,
  templateVersion: z.number().int().nonnegative(),
  checkpointDefs: z.array(checkpointDef).max(256),
  roundLimit: z.number().int().positive().max(100),
  continuationLimit: z.number().int().nonnegative().max(1000),
})

const settings = z.strictObject({
  docsRoot: relativePath,
  language: z.enum(LANGUAGES),
  snapshotLimits: z.strictObject({
    maxFileBytes: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    maxNewFiles: z.number().int().positive(),
  }),
  excludedRepos: z.array(relativePath).max(256),
})

const config = z.strictObject({
  seats: z.array(seat).max(64),
  profiles: z.array(profile).max(1024),
  playbook,
  settings,
  configRevision: z.number().int().nonnegative(),
})

const driftItem = z.strictObject({
  id,
  revision: z.number().int().positive(),
  path: relativePath,
  checkpointId: id,
  baseVersionId: id.nullable(),
  acceptedCommit: commit,
  observedCommit: commit,
  foundAt: timestamp,
  source: z.enum(DRIFT_SOURCES),
  status: z.enum(DRIFT_STATUSES),
  resolvedAt: timestamp.nullable(),
})

const outOfScopeItem = z.strictObject({
  id,
  path: relativePath,
  attribution: z.enum(OUT_OF_SCOPE_ATTRIBUTION),
  effectId: id.nullable(),
  overlappingEffectIds: z.array(id).max(64),
  detectedAt: timestamp,
  status: z.enum(OUT_OF_SCOPE_STATUSES),
  resolvedAt: timestamp.nullable(),
})

const callWindow = z.strictObject({
  id,
  effectId: id,
  groupId: id.nullable(),
  claims: z.array(claim).max(256),
  startedAt: timestamp,
  endedAt: timestamp,
  skipped: z.boolean(),
})

const placeholder = z.strictObject({
  path: relativePath,
  reason: z.enum(['oversize', 'lfs']),
  mode: z.enum(['100644', '100755']),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  device: z.number().int(),
  inode: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  recordedAt: z.number().int().nonnegative(),
})

const gateMetric = z.strictObject({
  gateId: id,
  checkpointId: id,
  reason: z.enum(GATE_REASONS),
  outcome: z.enum(GATE_OUTCOMES),
  gateCreatedAt: timestamp,
  decidedAt: timestamp,
  durationMs: z.number().int().nonnegative(),
  requestedChangesAfterPass: z.boolean(),
  acceptedAsIs: z.boolean(),
})

const gateDecisionMonth = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  count: z.number().int().nonnegative(),
  outcomes: z.strictObject({
    continue: z.number().int().nonnegative(),
    accept: z.number().int().nonnegative(),
    'reject-upstream': z.number().int().nonnegative(),
  }),
  durationMs: z.number().int().nonnegative(),
  requestedChangesAfterPass: z.number().int().nonnegative(),
  acceptedAsIs: z.number().int().nonnegative(),
})

const reopeningMetric = z.strictObject({
  checkpointId: id,
  source: z.enum(['reject', 'reopen']),
  reason: text(32768),
  at: timestamp,
})

const reopeningMonth = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  count: z.number().int().nonnegative(),
})

const finalReviewFinding = z.strictObject({
  id,
  checkpointId: id,
  text: text(32768),
  createdAt: timestamp,
})

const metrics = z.strictObject({
  gateDecisions: z.array(gateMetric).max(10000),
  gateDecisionMonths: z.array(gateDecisionMonth).max(1000),
  reopenings: z.array(reopeningMetric).max(1000),
  reopeningMonths: z.array(reopeningMonth).max(1000),
  finalReviewFindings: z.array(finalReviewFinding).max(1000),
})

const preferences = z.strictObject({
  drawerWidth: z.number().int().positive().max(10000).optional(),
  drawerTab: z.enum(['files', 'trace']).optional(),
  commitToGit: z.boolean().optional(),
})

const baseVersions = z.array(z.strictObject({
  checkpointId: id,
  artifactVersionId: id,
  instanceEpoch: z.number().int().nonnegative(),
})).max(1000)

const chatWriteCheck = z.strictObject({
  groupId: id,
  status: z.enum(CHAT_WRITE_CHECK_STATUSES),
  snapshotCommit: commit.nullable(),
  baseVersions: baseVersions.nullable(),
  failure: text(2000).nullable(),
})

const deletion = z.strictObject({
  phase: z.enum(DELETION_PHASES),
  startedAt: timestamp,
})

const projectState = z.strictObject({
  schemaVersion: z.literal(PROJECT_STATE_SCHEMA_VERSION),
  projectId: id,
  revision: z.number().int().nonnegative(),
  config,
  instances: z.array(instance).max(1000),
  driftItems: z.array(driftItem).max(1000),
  outOfScopeItems: z.array(outOfScopeItem).max(1000),
  callWindows: z.array(callWindow).max(1000),
  placeholders: z.array(placeholder).max(10000),
  metrics,
  preferences,
  chatReads: z.record(id, z.record(id, id)),
  projectEffects: z.array(projectEffect).max(1000),
  projectBlockedOn: z.strictObject({
    effectId: id,
    error: text(2000),
    time: timestamp,
  }).nullable(),
  chatWriteChecks: z.record(id, chatWriteCheck),
  maintenanceLeaseRequests: z.array(leaseRequest).max(1000),
  deletion: deletion.optional(),
})

const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxDurationMs: 60 * 1000,
  maxNewFiles: 200000,
})

function emptyConfig(overrides = {}) {
  return {
    seats: [],
    profiles: [],
    playbook: {
      templateId: 'builtin-default',
      templateVersion: 1,
      checkpointDefs: [],
      roundLimit: 3,
      continuationLimit: 3,
    },
    settings: {
      docsRoot: 'meldwork/',
      language: 'zh',
      snapshotLimits: { ...DEFAULT_SNAPSHOT_LIMITS },
      excludedRepos: [],
    },
    configRevision: 0,
    ...overrides,
  }
}

function emptyProjectState({ projectId, config: configOverrides = {} } = {}) {
  const candidate = {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    projectId,
    revision: 0,
    config: emptyConfig(configOverrides),
    instances: [],
    driftItems: [],
    outOfScopeItems: [],
    callWindows: [],
    placeholders: [],
    metrics: {
      gateDecisions: [],
      gateDecisionMonths: [],
      reopenings: [],
      reopeningMonths: [],
      finalReviewFindings: [],
    },
    preferences: {},
    chatReads: {},
    projectEffects: [],
    projectBlockedOn: null,
    chatWriteChecks: {},
    maintenanceLeaseRequests: [],
  }
  return parseProjectState(candidate)
}

function parseProjectState(value) {
  const result = projectState.safeParse(value)
  if (!result.success) {
    const details = result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
      ...(issue.keys ? { keys: issue.keys } : {}),
    }))
    throw Object.assign(new Error('PROJECT_STATE_INVALID'), {
      code: 'PROJECT_STATE_INVALID',
      details: { issues: details },
    })
  }
  return result.data
}

module.exports = {
  DEFAULT_SNAPSHOT_LIMITS,
  PROJECT_STATE_SCHEMA_VERSION,
  emptyProjectState,
  parseProjectState,
}
