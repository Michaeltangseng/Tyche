const CHANNELS = Object.freeze({
  bootstrap: 'room:bootstrap',
  snapshot: 'room:snapshot',
  startAssignment: 'room:assignment-start',
  submitMessage: 'room:message-submit',
  controllerAction: 'room:controller-action',
  userCommand: 'room:user-command',
  importReport: 'room:report-import',
  sessionLiveness: 'room:session-liveness',
  listStale: 'room:assignments-stale',
  enqueueEffect: 'room:effect-enqueue',
})

function assertInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ROOM_IPC_INPUT_INVALID')
  return input
}

function registerRoomIpc({ ipcMain, service, requireRenderer = () => {}, isShuttingDown = () => false }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || !service) throw new TypeError('ROOM_IPC_DEPENDENCIES_REQUIRED')
  const handlers = new Map([
    [CHANNELS.bootstrap, (input) => service.bootstrap(assertInput(input))],
    [CHANNELS.snapshot, (input) => service.snapshot(assertInput(input))],
    [CHANNELS.startAssignment, (input) => service.startAssignment(assertInput(input))],
    [CHANNELS.submitMessage, (input) => service.submitMessage(assertInput(input))],
    [CHANNELS.controllerAction, (input) => service.applyControllerAction(assertInput(input))],
    [CHANNELS.userCommand, (input) => service.applyUserCommand(assertInput(input))],
    [CHANNELS.importReport, (input) => service.importReport(assertInput(input))],
    [CHANNELS.sessionLiveness, (input) => service.sessionLiveness(assertInput(input))],
    [CHANNELS.listStale, (input) => service.listStaleAssignments(assertInput(input))],
    [CHANNELS.enqueueEffect, (input) => service.enqueueEffect(assertInput(input))],
  ])
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, input) => {
      requireRenderer(event)
      if (isShuttingDown()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
      return handler(input)
    })
  }
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler?.(channel)
  }
}

module.exports = { CHANNELS, registerRoomIpc }
