import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjectRoom } from '../../composables/useProjectRoom.js'

function projectSnapshot(overrides = {}) {
  return {
    projectId: 'project-1',
    name: 'Project One',
    revision: 1,
    progress: [],
    gates: [],
    ...overrides,
  }
}

function makeApi(overrides = {}) {
  let changedCallback = null
  const api = {
    snapshot: vi.fn(async ({ projectId }) => projectSnapshot({ projectId })),
    onChanged: vi.fn((callback) => {
      changedCallback = callback
      return vi.fn(() => {
        if (changedCallback === callback) changedCallback = null
      })
    }),
    decideGate: vi.fn(async input => ({ ok: true, input })),
    emitChanged(payload) {
      changedCallback?.(payload)
    },
    ...overrides,
  }
  return api
}

function mountRoom(options = {}) {
  const scope = effectScope()
  let room = null
  scope.run(() => {
    room = useProjectRoom(options)
  })
  return { room, scope }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useProjectRoom', () => {
  it('fetches only while a project room is open and ignores unchanged revisions', async () => {
    const api = makeApi()
    const { room, scope } = mountRoom({ api })

    api.emitChanged({ projectId: 'project-1', revision: 2 })
    expect(api.snapshot).not.toHaveBeenCalled()

    await room.open('project-1')
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(api.snapshot).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(room.project.value.projectId).toBe('project-1')
    expect(room.revision.value).toBe(1)
    expect(room.isOpen.value).toBe(true)

    api.emitChanged({ projectId: 'project-2', revision: 5 })
    await flushPromises()
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    api.emitChanged({ projectId: 'project-1', revision: 1 })
    await flushPromises()
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    api.snapshot.mockImplementation(async ({ projectId }) => (
      projectSnapshot({ projectId, revision: 2 })
    ))
    api.emitChanged({ projectId: 'project-1', revision: 2 })
    await flushPromises()
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(room.revision.value).toBe(2)

    room.close()
    api.emitChanged({ projectId: 'project-1', revision: 3 })
    await flushPromises()
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(room.project.value).toBe(null)
    scope.stop()
  })

  it('refetches when the returned revision is older than the latest event', async () => {
    const api = makeApi()
    api.snapshot = vi.fn()
      .mockResolvedValueOnce(projectSnapshot({ revision: 1 }))
      .mockResolvedValueOnce(projectSnapshot({ revision: 2 }))
      .mockResolvedValueOnce(projectSnapshot({ revision: 3 }))
    const { room, scope } = mountRoom({ api })

    await room.open('project-1')
    api.emitChanged({ projectId: 'project-1', revision: 3 })
    await vi.waitFor(() => expect(room.revision.value).toBe(3))

    expect(api.snapshot).toHaveBeenCalledTimes(3)
    expect(room.project.value.revision).toBe(3)
    scope.stop()
  })

  it('stops retrying when the returned revision stays behind the latest event', async () => {
    const api = makeApi()
    api.snapshot = vi.fn(async ({ projectId }) => projectSnapshot({ projectId, revision: 1 }))
    const { room, scope } = mountRoom({ api })

    await room.open('project-1')
    api.emitChanged({ projectId: 'project-1', revision: 5 })
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(4))

    expect(room.revision.value).toBe(1)
    expect(room.errorKey.value).toBe('')
    scope.stop()
  })

  it('coalesces changes that arrive during an in-flight refresh', async () => {
    let resolveFirst = null
    let resolveSecond = null
    const first = new Promise((resolve) => { resolveFirst = resolve })
    const second = new Promise((resolve) => { resolveSecond = resolve })
    const api = makeApi()
    api.snapshot = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const { room, scope } = mountRoom({ api })

    const opening = room.open('project-1')
    api.emitChanged({ projectId: 'project-1', revision: 2 })
    resolveFirst(projectSnapshot({ revision: 1 }))
    await flushPromises()
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    resolveSecond(projectSnapshot({ revision: 2 }))
    await opening

    expect(room.revision.value).toBe(2)
    expect(room.project.value.revision).toBe(2)
    scope.stop()
  })

  it('maps snapshot and action failures to localization keys', async () => {
    const api = makeApi({
      snapshot: vi.fn(async () => {
        throw Object.assign(new Error('PROJECT_GATE_STALE'), { code: 'PROJECT_GATE_STALE' })
      }),
      decideGate: vi.fn(async () => {
        throw Object.assign(new Error('PROJECT_ACCEPT_BLOCKED'), { code: 'PROJECT_ACCEPT_BLOCKED' })
      }),
    })
    const onError = vi.fn()
    const { room, scope } = mountRoom({ api, onError })

    await room.open('project-1')
    expect(room.project.value).toBe(null)
    expect(room.errorKey.value).toBe('errors.PROJECT_GATE_STALE')
    expect(onError).toHaveBeenCalledTimes(1)

    await expect(room.decideGate({ projectId: 'project-1', gateId: 'gate-1' }))
      .rejects.toMatchObject({ code: 'PROJECT_ACCEPT_BLOCKED' })
    expect(api.decideGate).toHaveBeenCalledWith({ projectId: 'project-1', gateId: 'gate-1' })
    expect(room.errorKey.value).toBe('errors.PROJECT_ACCEPT_BLOCKED')
    expect(onError).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('unsubscribes from project changes when its scope is disposed', async () => {
    const unsubscribe = vi.fn()
    const api = makeApi({ onChanged: vi.fn(() => unsubscribe) })
    const { room, scope } = mountRoom({ api })

    await room.open('project-1')
    scope.stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
