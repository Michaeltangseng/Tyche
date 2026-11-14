import { computed, ref } from 'vue'
import { desktopApi } from '../desktop.js'

function joinPath(parent, name) {
  return parent ? `${parent}/${name}` : name
}

export function useWorkdirTree({
  projectId,
  api = null,
} = {}) {
  const workdirApi = api || desktopApi()?.workdir || null
  const expanded = ref(new Set())
  const directories = ref(new Map())
  const selected = ref('')
  const preview = ref(null)
  const diff = ref(null)
  const loading = ref(false)
  const error = ref('')

  function directory(path) {
    return directories.value.get(path) || null
  }

  function setDirectory(path, value) {
    const next = new Map(directories.value)
    next.set(path, { ...(next.get(path) || {}), ...value })
    directories.value = next
  }

  async function loadDirectory(path = '') {
    if (!workdirApi || !projectId?.value) return null
    loading.value = true
    error.value = ''
    try {
      const page = await workdirApi.list({ projectId: projectId.value, relPath: path })
      setDirectory(path, {
        entries: page.entries || [],
        cursor: page.cursor || null,
        hasMore: page.hasMore === true,
        loading: false,
      })
      return page
    } catch (cause) {
      error.value = String(cause?.message || cause || 'WORKDIR_LIST_FAILED')
      return null
    } finally {
      loading.value = false
    }
  }

  async function loadMore(path) {
    const current = directory(path)
    if (!workdirApi || !current?.cursor) return
    try {
      const page = await workdirApi.list({
        projectId: projectId.value,
        relPath: path,
        cursor: current.cursor,
      })
      setDirectory(path, {
        entries: [...(current.entries || []), ...(page.entries || [])],
        cursor: page.cursor || null,
        hasMore: page.hasMore === true,
      })
    } catch (cause) {
      error.value = String(cause?.message || cause || 'WORKDIR_LIST_FAILED')
    }
  }

  async function toggle(path) {
    const next = new Set(expanded.value)
    if (next.has(path)) {
      next.delete(path)
      expanded.value = next
      return
    }
    next.add(path)
    expanded.value = next
    if (!directory(path)) await loadDirectory(path)
  }

  async function refresh() {
    for (const path of expanded.value) await loadDirectory(path)
  }

  async function readFile(path) {
    selected.value = path
    preview.value = null
    if (!workdirApi || !projectId?.value || !path) return null
    loading.value = true
    error.value = ''
    try {
      const result = await workdirApi.read({ projectId: projectId.value, relPath: path })
      preview.value = { ...result, path }
      return result
    } catch (cause) {
      error.value = String(cause?.message || cause || 'WORKDIR_READ_FAILED')
      return null
    } finally {
      loading.value = false
    }
  }

  async function loadMorePreview() {
    const current = preview.value
    if (!workdirApi || current?.kind !== 'text' || current.eof) return
    const offset = new TextEncoder().encode(current.text || '').length
    const result = await workdirApi.read({
      projectId: projectId.value,
      relPath: current.path,
      offset,
      length: 512 * 1024,
    })
    if (result?.kind !== 'text') return
    preview.value = {
      ...current,
      text: `${current.text}${result.text}`,
      eof: result.eof,
      totalBytes: result.totalBytes,
    }
  }

  async function loadDiff({ checkpointId, version, kind = 'accepted' }) {
    if (!workdirApi || !projectId?.value || !selected.value) return null
    loading.value = true
    error.value = ''
    try {
      diff.value = await workdirApi.diff({
        projectId: projectId.value,
        relPath: selected.value,
        against: {
          kind,
          checkpointId,
          ...(version ? { version } : {}),
        },
      })
      return diff.value
    } catch (cause) {
      error.value = String(cause?.message || cause || 'WORKDIR_DIFF_FAILED')
      return null
    } finally {
      loading.value = false
    }
  }

  const visibleRows = computed(() => {
    const rows = []
    const walk = (path, depth) => {
      const directoryEntries = directory(path)?.entries || []
      for (const entry of directoryEntries) {
        const full = joinPath(path, entry.name)
        rows.push({ ...entry, path: full, depth })
        if (entry.kind === 'directory' && expanded.value.has(full)) walk(full, depth + 1)
      }
    }
    walk('', 0)
    return rows
  })

  return {
    diff,
    directories,
    error,
    expanded,
    loadDiff,
    loadDirectory,
    loadMore,
    loadMorePreview,
    loading,
    preview,
    readFile,
    refresh,
    selected,
    toggle,
    visibleRows,
  }
}
