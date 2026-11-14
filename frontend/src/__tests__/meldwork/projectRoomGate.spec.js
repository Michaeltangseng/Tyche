import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomGatePanel from '../../components/ProjectRoomGatePanel.vue'

function signal(kind, count = null, checkpointId = null) {
  return { kind, checkpointId, count }
}

function review(seatId, verdict, summary) {
  return {
    seatId,
    verdict,
    summary,
    reviewFile: `meldwork/reviews/requirements/r1-${seatId}.md`,
  }
}

function gateScreen(overrides = {}) {
  return {
    round: 2,
    elapsedMs: 12 * 60000,
    signals: [
      signal('upstream-pending-version', 1),
      signal('upstream-drift', 2),
      signal('candidate-diverged'),
      signal('out-of-scope', 3),
      signal('same-agent-kind'),
    ],
    reviewSummaries: [
      review('seat-1', 'revise', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'),
      review('seat-2', 'needs-human', 'Needs a decision.'),
      review('seat-3', 'pass', 'Looks good.'),
    ],
    reviewSummaryCount: 3,
    changedFiles: Array.from({ length: 7 }, (_, index) => ({
      path: `docs/file-${index + 1}.md`,
      added: index + 1,
      removed: 0,
      binary: false,
    })),
    changedFileCount: 7,
    softGateSummary: [
      ...Array.from({ length: 6 }, (_, index) => ({
        checkpointId: `cp-soft-${index}`,
        name: `Soft ${index}`,
        rounds: index + 1,
        signals: [signal('out-of-scope', 1)],
      })),
      { checkpointId: 'cp-zero-1', name: 'Zero one', rounds: 1, signals: [] },
      { checkpointId: 'cp-zero-2', name: 'Zero two', rounds: 1, signals: [] },
    ],
    softGateCount: 8,
    driftItemIds: [],
    outOfScopeItemIds: [],
    blockerCheckpointIds: [],
    changesHeaderMissing: false,
    detectionSkipped: false,
    candidateDiverged: false,
    ...overrides,
  }
}

function controller(overrides = {}) {
  return {
    acceptCandidateVersion: vi.fn(),
    activeGate: ref({
      gateId: 'gate-1',
      revision: 1,
      reason: 'needs-human',
      candidateCommit: 'a'.repeat(40),
      allowedOutcomes: ['continue', 'accept', 'reject-upstream'],
    }),
    allReviewersPass: false,
    cancelAcceptConfirm: vi.fn(),
    candidateDiverged: ref(null),
    commitToGit: ref(false),
    confirmAcceptAsIs: ref(false),
    confirmAcceptNow: vi.fn(),
    draft: ref(''),
    driftGate: false,
    gateAcceptBlockers: ref([]),
    gateAllowedOutcomes: ref(['continue', 'accept', 'reject-upstream']),
    gateCheckpointName: 'Requirements',
    gateCommitToGit: ref({ available: false, reasons: [] }),
    gateErrorLabel: '',
    gateLoading: false,
    gateScreen: ref(gateScreen()),
    gateStale: false,
    progressItems: ref([]),
    questionGate: false,
    reloadGate: vi.fn(),
    requestAccept: vi.fn(),
    requestReject: vi.fn(),
    resolveGateDrift: vi.fn(),
    submitGateContinue: vi.fn(),
    t: (key, params = {}) => (
      params.count == null ? key : `${key}:${params.count}`
    ),
    ...overrides,
  }
}

describe('project room gate panel', () => {
  it('applies the first-screen budgets and reveals the rest on demand', async () => {
    const wrapper = mount(ProjectRoomGatePanel, { props: { controller: controller() } })
    const sections = wrapper.findAll('.gate-section')
    const reviews = sections[0]
    const files = sections[1]
    const soft = sections[2]

    expect(wrapper.get('.gate-panel-heading').text()).toContain('Requirements')
    expect(wrapper.get('.gate-panel-heading').text()).toContain('projectRoom.gate.round:2')
    expect(wrapper.findAll('.gate-signal')).toHaveLength(4)
    expect(wrapper.get('.gate-signal-more').text()).toBe('projectRoom.gate.moreSignals:1')
    expect(reviews.findAll('.gate-review')).toHaveLength(2)
    expect(reviews.findAll('.gate-review')[1].findAll('p')).toHaveLength(4)
    expect(reviews.text()).toContain('projectRoom.gate.moreReviews:1')
    expect(files.findAll('.gate-file')).toHaveLength(6)
    expect(files.text()).toContain('projectRoom.gate.moreFiles:1')
    expect(soft.findAll('.gate-soft-row')).toHaveLength(5)
    expect(soft.text()).toContain('projectRoom.gate.moreSoftGates:3')

    await reviews.get('.gate-link').trigger('click')
    expect(reviews.findAll('.gate-review')[1].findAll('p')).toHaveLength(5)
    await files.get('.gate-link').trigger('click')
    expect(files.findAll('.gate-file')).toHaveLength(7)
    await soft.get('.gate-link').trigger('click')
    expect(soft.findAll('.gate-soft-row')).toHaveLength(6)
  })

  it('disables outcomes that the gate does not allow and explains why', async () => {
    const wrapper = mount(ProjectRoomGatePanel, {
      props: {
        controller: controller({
          gateAllowedOutcomes: ref(['continue']),
        }),
      },
    })
    expect(wrapper.get('.gate-primary').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.gate-primary').attributes('title'))
      .toBe('projectRoom.gate.outcomeUnavailable')
    expect(wrapper.get('.gate-secondary').attributes('disabled')).toBeDefined()
    await wrapper.get('.gate-comment').setValue('An opinion')
    expect(wrapper.get('.gate-secondary').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('.gate-text-button').attributes('disabled')).toBeDefined()
  })

  it('disables accepting while upstream or detection blockers remain', () => {
    const upstream = mount(ProjectRoomGatePanel, {
      props: {
        controller: controller({
          gateAcceptBlockers: ref([{
            type: 'doc-new-version', checkpointId: 'cp-upstream',
          }]),
          progressItems: ref([{
            checkpointId: 'cp-upstream', name: 'Upstream', label: 'Gate',
          }]),
        }),
      },
    })
    expect(upstream.get('.gate-primary').attributes('disabled')).toBeDefined()
    expect(upstream.get('.gate-primary').attributes('title'))
      .toBe('projectRoom.gate.acceptBlocked')
    expect(upstream.get('.gate-blockers').text()).toContain('projectRoom.gate.blocker.docNewVersion')

    const detection = mount(ProjectRoomGatePanel, {
      props: {
        controller: controller({
          gateAcceptBlockers: ref([{ type: 'detection', checkCount: 1 }]),
        }),
      },
    })
    expect(detection.get('.gate-primary').attributes('disabled')).toBeDefined()
    expect(detection.get('.gate-primary').attributes('title'))
      .toBe('projectRoom.gate.blocker.detection')
  })

  it('asks for an answer on question gates and confirms accept-as-is', async () => {
    const question = mount(ProjectRoomGatePanel, {
      props: {
        controller: controller({
          questionGate: true,
          gateAllowedOutcomes: ref(['continue', 'reject-upstream']),
        }),
      },
    })
    expect(question.get('.gate-primary').text()).toBe('projectRoom.gate.sendAnswer')
    expect(question.get('.gate-primary').attributes('disabled')).toBeDefined()
    expect(question.text()).toContain('projectRoom.gate.answerLabel')
    await question.get('.gate-comment').setValue('An answer')
    expect(question.get('.gate-primary').attributes('disabled')).toBeUndefined()

    const confirm = controller({
      confirmAcceptAsIs: ref(true),
    })
    const wrapper = mount(ProjectRoomGatePanel, { props: { controller: confirm } })
    expect(wrapper.get('.gate-primary').text()).toBe('projectRoom.gate.acceptAsIs')
    await wrapper.get('.gate-primary').trigger('click')
    expect(confirm.requestAccept).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.gate-confirm').text()).toContain('projectRoom.gate.acceptAsIsConfirm')
    await wrapper.get('.gate-confirm .gate-primary').trigger('click')
    expect(confirm.confirmAcceptNow).toHaveBeenCalledTimes(1)
    await wrapper.get('.gate-confirm .gate-secondary').trigger('click')
    expect(confirm.cancelAcceptConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows stale content, reload, commit availability, and drift choices', async () => {
    const stale = controller({
      gateStale: true,
      gateCommitToGit: ref({
        available: false,
        reasons: [{ path: 'docs/a.md', reason: 'staged' }],
      }),
    })
    const wrapper = mount(ProjectRoomGatePanel, { props: { controller: stale } })
    expect(wrapper.get('.gate-stale').text()).toContain('projectRoom.gate.stale')
    await wrapper.get('.gate-stale .gate-link').trigger('click')
    expect(stale.reloadGate).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.gate-commit input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.gate-commit small').text()).toContain('docs/a.md')
    expect(wrapper.get('.gate-commit small').text()).toContain('projectRoom.gate.commitReason.staged')

    const drift = controller({ driftGate: true })
    const driftWrapper = mount(ProjectRoomGatePanel, { props: { controller: drift } })
    expect(driftWrapper.findAll('.gate-primary')).toHaveLength(1)
    expect(driftWrapper.findAll('.gate-secondary')).toHaveLength(1)
    await driftWrapper.get('.gate-primary').trigger('click')
    expect(drift.resolveGateDrift).toHaveBeenCalledWith('workdir')
    await driftWrapper.get('.gate-secondary').trigger('click')
    expect(drift.resolveGateDrift).toHaveBeenCalledWith('accepted')
  })
})
