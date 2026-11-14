import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useWorkdirTree } from '../../composables/useWorkdirTree.js'

function fixture() {
  const api = {
    list: vi.fn(async ({ relPath, cursor }) => {
      if (relPath === '') {
        return {
          entries: [
            { name: 'docs', kind: 'directory', size: 0, mtime: '' },
            { name: 'README.md', kind: 'file', size: 10, mtime: '' },
          ],
          cursor: null,
          hasMore: false,
        }
      }
      return {
        entries: [{ name: 'a.md', kind: 'file', size: 5, mtime: '' }],
        cursor: cursor ? null : null,
        hasMore: false,
      }
    }),
    read: vi.fn(async ({ relPath, offset = 0, length = 512 * 1024 }) => {
      const text = relPath === 'docs/a.md' ? 'hello world' : 'file text'
      return {
        kind: 'text',
        text: text.slice(offset, offset + length),
        totalBytes: text.length,
        eof: offset > 0,
        encoding: 'utf-8',
      }
    }),
    diff: vi.fn(async () => ({
      path: 'docs/a.md',
      change: { change: 'content-changed', diffAvailable: true },
      diff: { text: '@@ -1 +1 @@\n-old\n+new', truncated: false },
      numstat: { added: 1, removed: 1, binary: false },
    })),
  }
  const scope = effectScope()
  let tree
  scope.run(() => {
    tree = useWorkdirTree({ projectId: ref('project-1'), api })
  })
  return { api, scope, tree }
}

describe('useWorkdirTree', () => {
  it('loads the root, expands directories, and refreshes only expanded paths', async () => {
    const { tree, api, scope } = fixture()
    await tree.loadDirectory('')
    expect(tree.visibleRows.value.map(row => row.name)).toEqual(['docs', 'README.md'])
    await tree.toggle('docs')
    expect(api.list).toHaveBeenCalledWith({ projectId: 'project-1', relPath: 'docs' })
    expect(tree.visibleRows.value.map(row => row.path)).toEqual([
      'docs', 'docs/a.md', 'README.md',
    ])
    await tree.refresh()
    expect(api.list).toHaveBeenCalledWith({ projectId: 'project-1', relPath: 'docs' })
    scope.stop()
  })

  it('reads a file and appends the next preview page', async () => {
    const { tree, api, scope } = fixture()
    await tree.readFile('docs/a.md')
    expect(tree.preview.value.text).toBe('hello world')
    await tree.loadMorePreview()
    expect(api.read).toHaveBeenLastCalledWith({
      projectId: 'project-1', relPath: 'docs/a.md', offset: 11, length: 512 * 1024,
    })
    scope.stop()
  })

  it('loads a diff against the accepted version', async () => {
    const { tree, api, scope } = fixture()
    await tree.readFile('docs/a.md')
    const result = await tree.loadDiff({ checkpointId: 'cp-1', version: 'version-1' })
    expect(api.diff).toHaveBeenCalledWith({
      projectId: 'project-1',
      relPath: 'docs/a.md',
      against: { kind: 'accepted', checkpointId: 'cp-1', version: 'version-1' },
    })
    expect(result.change.change).toBe('content-changed')
    scope.stop()
  })
})
