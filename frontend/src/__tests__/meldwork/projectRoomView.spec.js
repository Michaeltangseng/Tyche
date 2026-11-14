import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useProjectRoomView } from '../../composables/useProjectRoomView.js'

const NOW = Date.parse('2026-07-29T10:00:00Z')

function translate(key, params = {}) {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    key,
  )
}

function entry(checkpointId, state, overrides = {}) {
  return {
    checkpointId,
    checkpointKey: checkpointId,
    name: checkpointId,
    state,
    round: 1,
    roundsSinceHuman: 1,
    leadSeatId: 'seat-1',
    leadSeatName: 'Lead',
    reviewerSeatIds: [],
    waitingOn: 'none',
    hasGate: false,
    blocked: false,
    ...overrides,
  }
}

function gate(checkpointId, gateId, createdAt, overrides = {}) {
  return {
    checkpointId,
    gateId,
    revision: 1,
    reason: 'needs-human',
    candidateCommit: 'a'.repeat(40),
    createdAt,
    round: 1,
    elapsedMs: 1000,
    signals: [],
    signalCount: 0,
    reviewSummaries: [],
    reviewSummaryCount: 0,
    changedFiles: [],
    changedFileCount: 0,
    softGateSummary: [],
    softGateCount: 0,
    driftItemIds: [],
    outOfScopeItemIds: [],
    blockerCheckpointIds: [],
    changesHeaderMissing: false,
    detectionSkipped: false,
    candidateDiverged: false,
    ...overrides,
  }
}

function messages() {
  return [
    { id: 'm1', groupId: 'main-1', createdAt: NOW - 30 * 60000, projectRoom: { checkpointId: 'cp-1' } },
    { id: 'm2', groupId: 'main-1', createdAt: NOW - 10 * 60000, projectRoom: { checkpointId: 'cp-2' } },
  ]
}

function emptyScreen() {
  return {
    round: 1,
    elapsedMs: 0,
    signals: [],
    reviewSummaries: [],
    changedFiles: [],
    softGateSummary: [],
    driftItemIds: [],
    outOfScopeItemIds: [],
    blockerCheckpointIds: [],
    changesHeaderMissing: false,
    detectionSkipped: false,
    candidateDiverged: false,
  }
}

function fakeRoom(project) {
  return {
    project: ref(project),
    open: vi.fn(async () => {}),
    close: vi.fn(),
    refresh: vi.fn(async () => {}),
    start: vi.fn(async () => ({})),
    interject: vi.fn(async () => ({})),
    decideGate: vi.fn(async () => ({})),
    resolveDrift: vi.fn(async () => ({})),
    gateDetail: vi.fn(async ({ projectId, gateId, gateRevision }) => ({
      projectId,
      checkpointName: 'Requirements',
      gateId,
      gateRevision,
      allowedOutcomes: ['continue', 'accept', 'reject-upstream'],
      question: false,
      commitToGit: { available: false, reasons: [] },
      firstScreen: emptyScreen(),
    })),
    previewReopen: vi.fn(async () => ({ impact: [] })),
  }
}

function mountView({
  activeGroup = ref({
    id: 'main-1',
    projectId: 'project-1',
    projectRole: 'main',
    agentKinds: ['codex'],
    workdir: '/tmp/project',
  }),
  project = null,
  room = null,
  projectTarget = ref(null),
  workspace = ref({ createGroup: vi.fn(), get: vi.fn() }),
} = {}) {
  const snapshot = ref({
    groups: [
      activeGroup.value,
      { id: 'chat-1', projectId: 'project-1', name: 'Project chat', updatedAt: '2026-07-29T09:00:00Z' },
    ],
    messages: messages(),
  })
  const selectGroup = vi.fn()
  const showError = vi.fn()
  const projectRoom = room || fakeRoom(project)
  const scope = effectScope()
  let view = null
  scope.run(() => {
    view = useProjectRoomView({
      activeGroup,
      formatNavTime: value => new Date(value).toISOString().slice(11, 16),
      normalizeSnapshot: value => value,
      now: () => NOW,
      projectTarget,
      room: projectRoom,
      selectGroup,
      showError,
      snapshot,
      sortByUpdated: (left, right) => (
        (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0)
      ),
      t: translate,
      workspace,
    })
  })
  return {
    activeGroup, projectRoom, projectTarget, scope, selectGroup, showError, snapshot, view, workspace,
  }
}

describe('project room view', () => {
  it('opens the project and selects the oldest pending gate by default', async () => {
    const project = {
      progress: [entry('cp-1', 'leading'), entry('cp-2', 'reviewing')],
      gates: [
        gate('cp-2', 'gate-2', '2026-07-29T09:30:00Z'),
        gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z'),
      ],
    }
    const fixture = mountView({ project })
    await nextTick()

    expect(fixture.projectRoom.open).toHaveBeenCalledWith('project-1')
    expect(fixture.view.activeTargetId.value).toBe('cp-1')
    expect(fixture.view.currentItem.value.checkpointId).toBe('cp-1')
    expect(fixture.view.targetPurposeLabel.value)
      .toBe('projectRoom.composer.purpose.gate-comment')
    expect(fixture.view.sendLabel.value).toBe('projectRoom.composer.send.gate-comment')
    expect(fixture.view.targetHint.value).toBe('projectRoom.composer.hint.gate')
    expect(fixture.view.lastActivityLabel.value).toBe('09:50')
    fixture.scope.stop()
  })

  it('keeps the target when the project snapshot changes in the background', async () => {
    const project = {
      progress: [entry('cp-1', 'leading'), entry('cp-2', 'reviewing')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    const fixture = mountView({ project })
    await nextTick()
    expect(fixture.view.activeTargetId.value).toBe('cp-1')

    fixture.projectRoom.project.value = {
      ...project,
      gates: [
        ...project.gates,
        gate('cp-2', 'gate-2', '2026-07-29T09:45:00Z'),
      ],
    }
    await nextTick()
    expect(fixture.view.activeTargetId.value).toBe('cp-1')

    fixture.projectRoom.project.value = {
      ...project,
      progress: [
        entry('cp-1', 'leading', { name: 'Requirements' }),
        entry('cp-2', 'reviewing'),
      ],
      gates: [
        gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z'),
        gate('cp-2', 'gate-2', '2026-07-29T09:45:00Z'),
      ],
    }
    await nextTick()
    expect(fixture.view.activeTargetId.value).toBe('cp-1')
    expect(fixture.view.currentItem.value.name).toBe('Requirements')
    fixture.scope.stop()
  })

  it('keeps a draft per target and updates purpose without losing it', async () => {
    const project = {
      progress: [entry('cp-1', 'leading'), entry('cp-2', 'reviewing')],
      gates: [],
    }
    const fixture = mountView({ project })
    await nextTick()

    fixture.view.selectTarget('cp-1')
    fixture.view.draft.value = 'first target'
    fixture.view.selectTarget('cp-2')
    expect(fixture.view.draft.value).toBe('')
    fixture.view.draft.value = 'second target'
    fixture.view.selectTarget('cp-1')
    expect(fixture.view.draft.value).toBe('first target')
    expect(fixture.view.targetPurposeLabel.value)
      .toBe('projectRoom.composer.purpose.interjection-active')

    fixture.projectRoom.project.value = {
      ...project,
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    await nextTick()
    expect(fixture.view.activeTargetId.value).toBe('cp-1')
    expect(fixture.view.draft.value).toBe('first target')
    expect(fixture.view.targetPurposeLabel.value)
      .toBe('projectRoom.composer.purpose.gate-comment')
    expect(fixture.view.sendLabel.value).toBe('projectRoom.composer.send.gate-comment')
    fixture.scope.stop()
  })

  it('sends gate comments and interjections with the target ids', async () => {
    const project = {
      progress: [entry('cp-1', 'leading'), entry('cp-2', 'reviewing')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    const fixture = mountView({ project })
    await nextTick()

    fixture.view.draft.value = 'please revise'
    await fixture.view.sendTargetText()
    expect(fixture.projectRoom.decideGate).toHaveBeenCalledWith({
      projectId: 'project-1',
      gateId: 'gate-1',
      gateRevision: 1,
      candidateCommit: 'a'.repeat(40),
      outcome: 'continue',
      comment: 'please revise',
    })
    expect(fixture.view.draft.value).toBe('')
    expect(fixture.projectRoom.refresh).toHaveBeenCalled()

    fixture.view.selectTarget('cp-2')
    fixture.view.draft.value = 'a note'
    await fixture.view.sendTargetText()
    expect(fixture.projectRoom.interject).toHaveBeenCalledWith({
      projectId: 'project-1',
      checkpointId: 'cp-2',
      purpose: 'interjection',
      text: 'a note',
    })
    fixture.scope.stop()
  })

  it('keeps the draft and shows a reason when sending is rejected', async () => {
    const project = {
      progress: [entry('cp-1', 'leading')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    const fixture = mountView({ project })
    await nextTick()
    fixture.projectRoom.decideGate.mockRejectedValue(
      Object.assign(new Error('PROJECT_TARGET_CHANGED'), { code: 'PROJECT_TARGET_CHANGED' }),
    )

    fixture.view.draft.value = 'keep me'
    expect(await fixture.view.sendTargetText()).toBe(false)
    expect(fixture.view.draft.value).toBe('keep me')
    expect(fixture.view.sendErrorLabel.value)
      .toBe('projectRoom.composer.errors.targetChanged')
    fixture.scope.stop()
  })

  it('offers the start target before the first checkpoint', async () => {
    const fixture = mountView({ project: { progress: [], gates: [] } })
    await nextTick()

    expect(fixture.view.activeTargetId.value).toBe('start')
    expect(fixture.view.targetPurposeLabel.value).toBe('projectRoom.composer.purpose.start')
    fixture.view.draft.value = 'build a small tool'
    await fixture.view.sendTargetText()
    expect(fixture.projectRoom.start).toHaveBeenCalledWith({
      projectId: 'project-1',
      brief: 'build a small tool',
    })
    fixture.scope.stop()
  })

  it('loads the full gate screen and accepts with commitToGit', async () => {
    const project = {
      progress: [entry('cp-1', 'gate')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    const room = fakeRoom(project)
    room.gateDetail.mockResolvedValue({
      projectId: 'project-1',
      checkpointName: 'Requirements',
      gateId: 'gate-1',
      gateRevision: 1,
      allowedOutcomes: ['continue', 'accept', 'reject-upstream'],
      question: false,
      commitToGit: { available: true, reasons: [] },
      firstScreen: {
        ...emptyScreen(),
        reviewSummaries: [{
          seatId: 'seat-reviewer',
          verdict: 'pass',
          summary: 'Looks good.',
          reviewFile: 'meldwork/reviews/requirements/r1-seat-reviewer.md',
        }],
      },
    })
    const fixture = mountView({ project, room })
    await flushPromises()

    expect(fixture.view.gateScreen.value.reviewSummaries).toHaveLength(1)
    expect(fixture.view.allReviewersPass.value).toBe(true)
    expect(fixture.view.gateCommitToGit.value.available).toBe(true)
    fixture.view.draft.value = 'Accepted.'
    fixture.view.commitToGit.value = true
    await fixture.view.confirmAcceptNow()

    expect(fixture.projectRoom.decideGate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      gateId: 'gate-1',
      gateRevision: 1,
      candidateCommit: 'a'.repeat(40),
      outcome: 'accept',
      comment: 'Accepted.',
      commitToGit: true,
    }))
    fixture.scope.stop()
  })

  it('keeps the draft and reloads the gate when the decision is stale', async () => {
    const project = {
      progress: [entry('cp-1', 'gate')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z')],
    }
    const room = fakeRoom(project)
    room.decideGate.mockRejectedValue(
      Object.assign(new Error('PROJECT_GATE_STALE'), { code: 'PROJECT_GATE_STALE' }),
    )
    const fixture = mountView({ project, room })
    await flushPromises()

    fixture.view.draft.value = 'keep this'
    expect(await fixture.view.confirmAcceptNow()).toBe(false)
    expect(fixture.view.gateStale.value).toBe(true)
    expect(fixture.view.draft.value).toBe('keep this')
    expect(fixture.projectRoom.refresh).toHaveBeenCalled()
    fixture.scope.stop()
  })

  it('resolves a drift gate with the listed drift items', async () => {
    const project = {
      progress: [entry('cp-1', 'gate')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z', { reason: 'drift' })],
      driftItems: [{
        id: 'drift-1',
        revision: 2,
        path: 'docs/requirements.md',
      }],
    }
    const room = fakeRoom(project)
    room.gateDetail.mockResolvedValue({
      projectId: 'project-1',
      checkpointName: 'Requirements',
      gateId: 'gate-1',
      gateRevision: 1,
      reason: 'drift',
      allowedOutcomes: ['accept', 'reject-upstream'],
      question: false,
      commitToGit: { available: false, reasons: [] },
      firstScreen: { ...emptyScreen(), driftItemIds: ['drift-1'] },
    })
    const fixture = mountView({ project, room })
    await flushPromises()

    expect(await fixture.view.resolveGateDrift('workdir')).toBe(true)
    expect(room.resolveDrift).toHaveBeenCalledWith({
      projectId: 'project-1',
      items: [{ itemId: 'drift-1', revision: 2 }],
      choice: 'workdir',
    })
    fixture.scope.stop()
  })

  it('uses question-gate availability from the gate detail', async () => {
    const project = {
      progress: [entry('cp-1', 'gate')],
      gates: [gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z', { reason: 'question' })],
    }
    const room = fakeRoom(project)
    room.gateDetail.mockResolvedValue({
      projectId: 'project-1',
      checkpointName: 'Requirements',
      gateId: 'gate-1',
      gateRevision: 1,
      reason: 'question',
      allowedOutcomes: ['continue', 'reject-upstream'],
      question: true,
      commitToGit: { available: false, reasons: [] },
      firstScreen: emptyScreen(),
    })
    const fixture = mountView({ project, room })
    await flushPromises()

    expect(fixture.view.questionGate.value).toBe(true)
    expect(fixture.view.gateAllowedOutcomes.value).toEqual(['continue', 'reject-upstream'])
    fixture.scope.stop()
  })

  it('switches between gate targets and opens the latest project chat', async () => {
    const project = {
      progress: [entry('cp-1', 'leading'), entry('cp-2', 'reviewing')],
      gates: [
        gate('cp-1', 'gate-1', '2026-07-29T09:00:00Z'),
        gate('cp-2', 'gate-2', '2026-07-29T09:30:00Z'),
      ],
    }
    const fixture = mountView({ project })
    await nextTick()
    expect(fixture.view.otherGateCount.value).toBe(1)

    fixture.view.selectNextGateTarget()
    expect(fixture.view.activeTargetId.value).toBe('cp-2')
    expect(fixture.view.otherGateCount.value).toBe(1)

    expect(await fixture.view.openProjectChat()).toBe(true)
    expect(fixture.selectGroup).toHaveBeenCalledWith('chat-1')
    fixture.scope.stop()
  })
})
