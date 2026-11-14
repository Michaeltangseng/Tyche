const { coalesceNotifications } = require('./notification-coalescer.cjs')

const REASON_TEXT = {
  zh: {
    'needs-human': '需要你决定',
    'gate.needs-human': '需要你决定',
    'hard-gate-passed': '关卡待决定',
    'gate.hard-gate-passed': '关卡待决定',
    'gate.round-limit': '达到轮数上限，需要你决定',
    'gate.artifact-unchanged': '产物未变，需要你决定',
    drift: '文档与已接受版本不一致',
    residual: '有残留进程等待处理',
    suspended: '项目已暂停，需要你重试',
  },
  en: {
    'needs-human': 'needs your decision',
    'gate.needs-human': 'needs your decision',
    'hard-gate-passed': 'a gate is waiting',
    'gate.hard-gate-passed': 'a gate is waiting',
    'gate.round-limit': 'round limit reached',
    'gate.artifact-unchanged': 'artifact unchanged',
    drift: 'documents diverged from the accepted version',
    residual: 'a residual process needs review',
    suspended: 'the project is paused',
  },
}

function reasonText(reasonKeys, locale) {
  const table = REASON_TEXT[locale === 'en' ? 'en' : 'zh']
  return reasonKeys
    .map(key => table[String(key).replace(/^projectRoom\.notification\./, '')])
    .find(Boolean) || (locale === 'en' ? 'project room update' : '项目室有更新')
}

function notificationBody(notification, locale) {
  const checkpoint = notification.checkpointNames?.filter(Boolean).join('、') || (locale === 'en' ? 'checkpoint' : '检查点')
  const reason = reasonText(notification.reasonKeys || [], locale)
  const count = notification.count > 1
    ? (locale === 'en' ? ` (${notification.count} items)` : `（${notification.count} 项）`)
    : ''
  return locale === 'en'
    ? `${notification.projectName || 'Project room'} · ${checkpoint}: ${reason}${count}`
    : `${notification.projectName || '项目室'} · ${checkpoint}：${reason}${count}`
}

function createProjectNotificationCoordinator({
  send,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  locale = () => 'zh',
} = {}) {
  let previousItems = []
  let pending = []
  let timer = null

  function clearPendingTimer() {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function deliver(notifications) {
    for (const notification of notifications) {
      send({
        projectId: notification.projectId,
        title: locale() === 'en' ? 'Meldwork · Project room' : 'Meldwork · 项目室',
        body: notificationBody(notification, locale()),
      })
    }
  }

  function scheduleNext(nextAt) {
    clearPendingTimer()
    if (nextAt === null) return
    const delay = Math.max(0, nextAt - now())
    timer = setTimer(() => {
      timer = null
      update(previousItems, {})
    }, delay)
    if (timer?.unref) timer.unref()
  }

  function update(items, { viewingProjectId = '' } = {}) {
    const result = coalesceNotifications({
      previousItems,
      nextItems: Array.isArray(items) ? items : [],
      now: now(),
      viewingProjectId,
      pending,
    })
    pending = result.pending
    previousItems = Array.isArray(items) ? items : []
    deliver(result.notifications)
    scheduleNext(result.nextAt)
    return { notifications: result.notifications, pending }
  }

  return {
    update,
    stop() { clearPendingTimer() },
    currentPending() { return pending },
  }
}

module.exports = {
  createProjectNotificationCoordinator,
  notificationBody,
  reasonText,
}
