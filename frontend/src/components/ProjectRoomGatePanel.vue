<template>
  <section v-if="activeGate" class="project-room-gate-panel" :class="{ collapsed: !expanded }">
    <header class="gate-panel-top">
      <button
        class="gate-panel-heading"
        type="button"
        :aria-expanded="String(expanded)"
        @click="expanded = !expanded"
      >
        <strong>{{ gateCheckpointName }}</strong>
        <span>
          {{ reasonLabel }}
          <template v-if="screen.round"> · {{ t('projectRoom.gate.round', { count: screen.round }) }}</template>
          <template v-if="elapsedLabel"> · {{ elapsedLabel }}</template>
        </span>
      </button>
      <button class="gate-panel-toggle" type="button" @click="expanded = !expanded">
        {{ expanded ? t('projectRoom.gate.collapse') : t('projectRoom.gate.expand') }}
      </button>
    </header>

    <template v-if="expanded">
      <div class="gate-panel-signals">
        <span
          v-for="review in screen.reviewSummaries || []"
          :key="`verdict-${review.seatId}`"
          class="gate-verdict"
          :data-verdict="review.verdict"
        >
          {{ verdictLabel(review.verdict) }}
        </span>
        <span
          v-for="signal in visibleSignals"
          :key="`signal-${signal.kind}-${signal.checkpointId || ''}`"
          class="gate-signal"
          :data-kind="signal.kind"
        >
          {{ signalLabel(signal) }}
        </span>
        <span v-if="extraSignalCount" class="gate-signal-more">
          {{ t('projectRoom.gate.moreSignals', { count: extraSignalCount }) }}
        </span>
        <span v-if="!visibleSignals.length" class="gate-no-signal">
          {{ t('projectRoom.gate.noSignals') }}
        </span>
        <span v-if="gateLoading" class="gate-loading">{{ t('projectRoom.gate.loading') }}</span>
      </div>

      <div class="gate-panel-body">
        <section class="gate-section">
          <h3>{{ t('projectRoom.gate.reviewSection') }}</h3>
          <p v-if="!reviewSummaries.length" class="gate-empty">{{ t('projectRoom.gate.noReviews') }}</p>
          <article v-for="review in visibleReviewSummaries" :key="review.seatId" class="gate-review">
            <header>
              <strong>{{ review.seatId }}</strong>
              <span class="gate-verdict" :data-verdict="review.verdict">{{ verdictLabel(review.verdict) }}</span>
            </header>
            <p v-for="(line, index) in visibleSummaryLines(review)" :key="index">{{ line }}</p>
            <button
              v-if="summaryHasMore(review)"
              class="gate-link"
              type="button"
              @click="toggleSummary(review.seatId)"
            >
              {{ expandedSummaries.has(review.seatId)
                ? t('projectRoom.gate.collapseSummary')
                : t('projectRoom.gate.expandSummary') }}
            </button>
          </article>
          <button
            v-if="reviewExampleCount > visibleReviewSummaries.length"
            class="gate-link"
            type="button"
            @click="showAllSummaries = !showAllSummaries"
          >
            {{ showAllSummaries
              ? t('projectRoom.gate.showFewerReviews')
              : t('projectRoom.gate.moreReviews', { count: reviewExampleCount - visibleReviewSummaries.length }) }}
          </button>
        </section>

        <section class="gate-section">
          <h3>{{ t('projectRoom.gate.changedFiles') }}</h3>
          <p v-if="!changedFiles.length" class="gate-empty">{{ t('projectRoom.gate.noChangedFiles') }}</p>
          <div v-for="file in visibleChangedFiles" :key="file.path" class="gate-file">
            <span class="gate-file-path">{{ file.path }}</span>
            <span class="gate-file-stat">
              {{ file.binary ? t('projectRoom.gate.binary') : `+${file.added} / -${file.removed}` }}
            </span>
          </div>
          <button
            v-if="changedFiles.length > visibleChangedFiles.length"
            class="gate-link"
            type="button"
            @click="showAllFiles = !showAllFiles"
          >
            {{ showAllFiles
              ? t('projectRoom.gate.showFewerFiles')
              : t('projectRoom.gate.moreFiles', { count: changedFiles.length - visibleChangedFiles.length }) }}
          </button>
        </section>

        <section v-if="softGates.length || softWithoutSignals" class="gate-section">
          <h3>{{ t('projectRoom.gate.softGates') }}</h3>
          <div v-for="entry in visibleSoftGates" :key="entry.checkpointId" class="gate-soft-row">
            <strong>{{ entry.name }}</strong>
            <span>{{ t('projectRoom.gate.softRounds', { count: entry.rounds }) }}</span>
          </div>
          <button
            v-if="softGates.length > visibleSoftGates.length || softWithoutSignals"
            class="gate-link"
            type="button"
            @click="showAllSoftGates = !showAllSoftGates"
          >
            {{ showAllSoftGates
              ? t('projectRoom.gate.showFewerSoftGates')
              : t('projectRoom.gate.moreSoftGates', {
                count: Math.max(0, softGates.length - visibleSoftGates.length) + softWithoutSignals,
              }) }}
          </button>
        </section>
      </div>

      <div class="gate-panel-bottom">
        <p v-if="gateStale" class="gate-stale" role="alert">
          {{ t('projectRoom.gate.stale') }}
          <button class="gate-link" type="button" @click="reloadGate">
            {{ t('projectRoom.gate.reload') }}
          </button>
        </p>
        <p v-if="gateErrorLabel" class="gate-error" role="alert">{{ gateErrorLabel }}</p>
        <label v-if="questionGate" class="gate-input-label" for="gate-comment">
          {{ t('projectRoom.gate.answerLabel') }}
        </label>
        <label v-else class="gate-input-label" for="gate-comment">
          {{ t('projectRoom.gate.commentLabel') }}
        </label>
        <textarea
          id="gate-comment"
          v-model="draft"
          class="gate-comment"
          :placeholder="questionGate ? t('projectRoom.gate.answerHint') : t('projectRoom.gate.commentHint')"
          rows="3"
          @keydown.meta.enter.prevent="continueGate"
          @keydown.ctrl.enter.prevent="continueGate"
        />

        <p v-if="candidateDiverged" class="gate-candidate-diverged">
          {{ t('projectRoom.gate.candidateDiverged') }}
          <button class="gate-link" type="button" @click="acceptCandidateVersion">
            {{ t('projectRoom.gate.acceptCandidate') }}
          </button>
          <span class="gate-muted">{{ t('projectRoom.gate.resubmitUnavailable') }}</span>
        </p>

        <p v-if="acceptBlockerItems.length" class="gate-blockers">
          <span v-for="blocker in acceptBlockerItems" :key="`${blocker.type}:${blocker.checkpointId || ''}`">
            {{ blockerLabel(blocker) }}
          </span>
        </p>

        <div class="gate-actions">
          <button
            v-if="!questionGate && !driftGate"
            class="gate-primary"
            type="button"
            :disabled="!acceptAvailable"
            :title="acceptAvailable ? '' : acceptUnavailableReason"
            @click="requestAccept"
          >
            {{ allReviewersPass ? t('projectRoom.gate.accept') : t('projectRoom.gate.acceptAsIs') }}
          </button>
          <button
            v-if="questionGate"
            class="gate-primary"
            type="button"
            :disabled="!continueAvailable || !draft.trim()"
            :title="continueAvailable ? '' : continueUnavailableReason"
            @click="continueGate"
          >
            {{ t('projectRoom.gate.sendAnswer') }}
          </button>
          <button
            v-if="driftGate"
            class="gate-primary"
            type="button"
            @click="resolveDrift('workdir')"
          >
            {{ t('projectRoom.gate.driftWorkdir') }}
          </button>
          <button
            v-if="driftGate"
            class="gate-secondary"
            type="button"
            @click="resolveDrift('accepted')"
          >
            {{ t('projectRoom.gate.driftAccepted') }}
          </button>
          <button
            v-if="!questionGate && !driftGate"
            class="gate-secondary"
            type="button"
            :disabled="!continueAvailable || !draft.trim()"
            :title="continueAvailable ? '' : continueUnavailableReason"
            @click="continueGate"
          >
            {{ t('projectRoom.gate.continue') }}
          </button>
          <button
            class="gate-text-button"
            type="button"
            :disabled="!rejectAvailable"
            :title="rejectAvailable ? '' : t('projectRoom.gate.rejectUnavailable')"
            @click="requestReject"
          >
            {{ t('projectRoom.gate.reject') }}
          </button>
        </div>

        <label
          v-if="!questionGate && !driftGate && acceptAvailable && commitApplicable"
          class="gate-commit"
        >
          <input v-model="commitToGit" type="checkbox" :disabled="!gateCommitToGit.available" />
          <span>{{ t('projectRoom.gate.commitToGit') }}</span>
          <small v-if="!gateCommitToGit.available">{{ commitUnavailableReason }}</small>
        </label>

        <div v-if="confirmAcceptAsIs" class="gate-confirm" role="alert">
          <p>{{ t('projectRoom.gate.acceptAsIsConfirm') }}</p>
          <button class="gate-primary" type="button" @click="confirmAcceptNow">
            {{ t('projectRoom.gate.confirmAccept') }}
          </button>
          <button class="gate-secondary" type="button" @click="cancelAcceptConfirm">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  acceptCandidateVersion,
  activeGate,
  allReviewersPass,
  cancelAcceptConfirm,
  candidateDiverged,
  commitToGit,
  confirmAcceptAsIs,
  confirmAcceptNow,
  draft,
  driftGate,
  gateAcceptBlockers,
  gateAllowedOutcomes,
  gateCheckpointName,
  gateCommitToGit,
  gateErrorLabel,
  gateLoading,
  gateScreen,
  gateStale,
  progressItems,
  questionGate,
  reloadGate,
  requestAccept,
  requestReject,
  resolveGateDrift,
  submitGateContinue,
  t,
} = props.controller

const expanded = ref(true)
const showAllSummaries = ref(false)
const showAllFiles = ref(false)
const showAllSoftGates = ref(false)
const expandedSummaries = ref(new Set())

const screen = computed(() => gateScreen.value || {})
const signals = computed(() => screen.value.signals || [])
const visibleSignals = computed(() => signals.value.slice(0, 4))
const extraSignalCount = computed(() => Math.max(0, signals.value.length - 4))
const reviewSummaries = computed(() => {
  const order = ['needs-human', 'revise', 'missing', 'failed', 'pass', 'cancelled']
  return [...(screen.value.reviewSummaries || [])].sort((left, right) => (
    order.indexOf(left.verdict) - order.indexOf(right.verdict)
  ))
})
const reviewExampleCount = computed(() => screen.value.reviewSummaryCount || reviewSummaries.value.length)
const visibleReviewSummaries = computed(() => (
  showAllSummaries.value ? reviewSummaries.value : reviewSummaries.value.slice(0, 2)
))
const changedFiles = computed(() => (
  [...(screen.value.changedFiles || [])].sort((left, right) => (
    (right.added + right.removed) - (left.added + left.removed)
  ))
))
const visibleChangedFiles = computed(() => (
  showAllFiles.value ? changedFiles.value : changedFiles.value.slice(0, 6)
))
const softGates = computed(() => (
  (screen.value.softGateSummary || []).filter(entry => (entry.signals || []).length > 0)
))
const softWithoutSignals = computed(() => (
  (screen.value.softGateSummary || []).length - softGates.value.length
))
const visibleSoftGates = computed(() => (
  showAllSoftGates.value ? softGates.value : softGates.value.slice(0, 5)
))
const progressById = computed(() => new Map(
  (progressItems.value || []).map(item => [item.checkpointId, item]),
))
const acceptBlockerItems = computed(() => (gateAcceptBlockers.value || []).map((blocker) => {
  const checkpoint = blocker.checkpointId
    ? progressById.value.get(blocker.checkpointId)
    : null
  return {
    ...blocker,
    checkpointName: checkpoint?.name || blocker.checkpointId || '',
  }
}))
const acceptBlocked = computed(() => acceptBlockerItems.value.length > 0)
const acceptAvailable = computed(() => (
  gateAllowedOutcomes.value.includes('accept') && !acceptBlocked.value
))
const continueAvailable = computed(() => gateAllowedOutcomes.value.includes('continue'))
const rejectAvailable = computed(() => gateAllowedOutcomes.value.includes('reject-upstream'))
const reasonLabel = computed(() => (
  t(`projectRoom.gate.reason.${activeGate.value?.reason || 'unknown'}`)
))
const elapsedLabel = computed(() => {
  const elapsed = Number(screen.value.elapsedMs)
  if (!Number.isFinite(elapsed) || elapsed < 0) return ''
  const minutes = Math.floor(elapsed / 60000)
  return minutes < 1
    ? t('projectRoom.gate.elapsedJustNow')
    : t('projectRoom.gate.elapsed', { count: minutes })
})
const acceptUnavailableReason = computed(() => {
  if (questionGate.value) return t('projectRoom.gate.acceptQuestionUnavailable')
  if (acceptBlockerItems.value.some(item => item.type === 'detection')) {
    return t('projectRoom.gate.blocker.detection')
  }
  if (acceptBlocked.value) return t('projectRoom.gate.acceptBlocked')
  return t('projectRoom.gate.outcomeUnavailable')
})

function blockerLabel(blocker) {
  const type = blocker.type === 'doc-new-version' ? 'docNewVersion'
    : blocker.type === 'drift' ? 'drift' : 'detection'
  const key = `projectRoom.gate.blocker.${type}`
  return blocker.checkpointName
    ? t(key, { checkpoint: blocker.checkpointName })
    : t(key)
}
const continueUnavailableReason = computed(() => t('projectRoom.gate.outcomeUnavailable'))
const COMMIT_REASONS = new Set([
  'not-a-repository', 'staged', 'content', 'outside-repository',
  'index-check-failed', 'git-unavailable', 'git-preflight-failed',
])
const commitReasons = computed(() => (
  (gateCommitToGit.value.reasons || []).map(item => ({
    ...item,
    reason: COMMIT_REASONS.has(item.reason) ? item.reason : 'unknown',
  }))
))
const commitApplicable = computed(() => (
  gateCommitToGit.value.available
    || commitReasons.value.some(item => !['not-a-repository', 'git-unavailable'].includes(item.reason))
))
const commitUnavailableReason = computed(() => {
  const reasons = commitReasons.value
  if (!reasons.length) return t('projectRoom.gate.commitUnavailable')
  return reasons.map((item) => {
    const key = `projectRoom.gate.commitReason.${item.reason || 'unknown'}`
    return item.path ? `${item.path}: ${t(key)}` : t(key)
  }).join('; ')
})

function verdictLabel(verdict) {
  return t(`projectRoom.gate.verdict.${verdict || 'missing'}`)
}

function signalLabel(signal) {
  const params = signal.count == null ? {} : { count: signal.count }
  return t(`projectRoom.gate.signal.${signal.kind}`, params)
}

function summaryLines(review) {
  return String(review.summary || '').split(/\r?\n/).filter(line => line.trim())
}

function visibleSummaryLines(review) {
  const lines = summaryLines(review)
  return expandedSummaries.value.has(review.seatId) ? lines : lines.slice(0, 4)
}

function summaryHasMore(review) {
  return summaryLines(review).length > 4
}

function toggleSummary(seatId) {
  const next = new Set(expandedSummaries.value)
  if (next.has(seatId)) next.delete(seatId)
  else next.add(seatId)
  expandedSummaries.value = next
}

function continueGate() {
  if (!continueAvailable.value || !draft.value.trim()) return
  void submitGateContinue()
}

function resolveDrift(choice) {
  void resolveGateDrift(choice)
}
</script>
