import { describe, expect, it } from 'vitest'
import {
  extractFileChanges,
  summarizeTraceActivity,
  toWorkdirRelative,
} from '../../traceActivity.js'

describe('traceActivity', () => {
  it('joins streamed tool input and turns a created file into a card', () => {
    const steps = [
      { seq: 1, kind: 'thinking', output: 'Inspect the docs.' },
      { seq: 2, kind: 'thinking', output: 'Then write.' },
      {
        seq: 3, kind: 'tool', toolCallId: 'tool-1', title: 'Write', status: 'running', input: {},
      },
      {
        seq: 4,
        kind: 'tool',
        toolCallId: 'tool-1',
        title: 'tool',
        status: 'running',
        input: '{"file_path":"docs/requirements.md","content":"one\\ntwo',
      },
      {
        seq: 5, kind: 'tool', toolCallId: 'tool-1', title: 'tool', status: 'running', input: '\\n"}',
      },
      {
        seq: 6,
        kind: 'tool',
        toolCallId: 'tool-1',
        title: 'tool',
        status: 'completed',
        output: 'File created successfully at: /tmp/project/docs/requirements.md',
      },
    ]

    const summary = summarizeTraceActivity(steps, { workdir: '/tmp/project' })

    expect(summary.thinkingCount).toBe(1)
    expect(summary.toolCount).toBe(1)
    expect(summary.files).toEqual([expect.objectContaining({
      path: 'docs/requirements.md',
      relativePath: 'docs/requirements.md',
      name: 'requirements.md',
      created: true,
      additions: 2,
      deletions: 0,
      status: 'completed',
    })])
  })

  it('counts edit additions and deletions from the tool input', () => {
    const files = extractFileChanges([
      {
        seq: 1,
        kind: 'tool',
        toolCallId: 'tool-2',
        title: 'Edit',
        status: 'completed',
        input: {
          file_path: 'src/app.js',
          old_string: 'a\nb',
          new_string: 'a\nb\nc',
        },
        output: 'The file /tmp/project/src/app.js has been updated successfully.',
      },
    ], { workdir: '/tmp/project' })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: 'src/app.js',
      created: false,
      additions: 3,
      deletions: 2,
    })
  })

  it('reads Codex file_change entries and merges repeated writes to one path', () => {
    const files = extractFileChanges([
      {
        seq: 1,
        kind: 'tool',
        toolCallId: 'change-1',
        title: 'file_change',
        status: 'completed',
        input: {
          changes: [{ path: 'src/a.js', kind: 'update', add: 5, remove: 2 }],
        },
      },
      {
        seq: 2,
        kind: 'tool',
        toolCallId: 'change-2',
        title: 'file_change',
        status: 'completed',
        input: {
          changes: [{ path: 'src/a.js', kind: 'update', add: 1, remove: 0 }],
        },
      },
    ], { workdir: '/tmp/project' })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/a.js', additions: 6, deletions: 2 })
  })

  it('only treats paths inside the workdir as previewable', () => {
    expect(toWorkdirRelative('/tmp/project/docs/a.md', '/tmp/project')).toBe('docs/a.md')
    expect(toWorkdirRelative('docs/a.md', '/tmp/project')).toBe('docs/a.md')
    expect(toWorkdirRelative('/tmp/elsewhere/a.md', '/tmp/project')).toBe('')
    expect(toWorkdirRelative('../a.md', '/tmp/project')).toBe('')
    expect(toWorkdirRelative('C:\\project\\docs\\a.md', 'C:\\project')).toBe('docs/a.md')
  })
})
