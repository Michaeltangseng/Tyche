import { describe, expect, it } from 'vitest'
import { buildTraceActivities, summarizeTraceActivities } from '../../tracePresentation.js'

describe('tracePresentation', () => {
  it('groups consecutive command calls and reads streamed tool input', () => {
    const { blocks, summary } = buildTraceActivities([
      { seq: 1, kind: 'thinking', output: 'Inspect the repo.' },
      {
        seq: 2, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'running', command: 'git status',
      },
      {
        seq: 3, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'completed', output: 'clean',
      },
      {
        seq: 4, kind: 'tool', toolCallId: 'tool-2', title: 'tool',
        status: 'running', input: '{"command":"git ',
      },
      {
        seq: 5, kind: 'tool', toolCallId: 'tool-2', title: 'tool',
        status: 'completed', input: 'diff"}',
      },
    ])

    expect(blocks.map(block => block.kind)).toEqual(['thinking', 'command'])
    expect(blocks[1].items).toHaveLength(2)
    expect(blocks[1].items[0].command).toBe('git status')
    expect(blocks[1].items[1].command).toBe('git diff')
    expect(summary).toMatchObject({ commands: 2, files: 0, thinking: 1, tools: 0 })
  })

  it('aggregates file writes into one file activity and leaves reads as tools', () => {
    const { blocks, summary } = buildTraceActivities([
      {
        seq: 1, kind: 'tool', toolCallId: 'write-1', title: 'Write', status: 'running',
        input: { file_path: 'docs/requirements.md', content: 'one\ntwo\n' },
      },
      {
        seq: 2, kind: 'tool', toolCallId: 'write-1', title: 'tool', status: 'completed',
        output: 'File created successfully at: /tmp/project/docs/requirements.md',
      },
      {
        seq: 3, kind: 'tool', toolCallId: 'write-2', title: 'Edit', status: 'completed',
        input: { file_path: 'docs/requirements.md', old_string: 'two', new_string: 'two\nthree' },
        output: 'The file /tmp/project/docs/requirements.md has been updated successfully.',
      },
      { seq: 4, kind: 'thinking', output: 'Check the file.' },
      {
        seq: 5, kind: 'tool', toolCallId: 'read-1', title: 'Read', status: 'completed',
        input: { file_path: 'src/app.js' }, output: 'file body',
      },
    ], { workdir: '/tmp/project' })

    expect(blocks.map(block => block.kind)).toEqual(['file', 'thinking', 'tool'])
    expect(blocks[0].files).toHaveLength(1)
    expect(blocks[0].files[0]).toMatchObject({
      path: 'docs/requirements.md',
      created: true,
      additions: 4,
      deletions: 1,
    })
    expect(blocks[2].items[0]).toMatchObject({
      title: 'Read',
      summary: 'src/app.js',
    })
    expect(summary).toMatchObject({ commands: 0, files: 1, thinking: 1, tools: 1 })
    expect(summary.fileList).toHaveLength(1)
  })

  it('keeps tool groups separated by a message or thinking step', () => {
    const { blocks } = buildTraceActivities([
      {
        seq: 1, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'completed', command: 'ls',
      },
      { seq: 2, kind: 'message', output: 'An intermediate note.' },
      {
        seq: 3, kind: 'tool', toolCallId: 'tool-2', title: 'Bash',
        status: 'completed', command: 'pwd',
      },
    ])

    expect(blocks.map(block => block.kind)).toEqual(['command', 'command'])
    expect(blocks[0].items[0].command).toBe('ls')
    expect(blocks[1].items[0].command).toBe('pwd')
  })

  it('merges all thinking fragments into one logical block', () => {
    const { blocks, summary } = buildTraceActivities([
      { seq: 1, kind: 'thinking', output: 'first' },
      {
        seq: 2, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'completed', command: 'ls',
      },
      { seq: 3, kind: 'thinking', output: 'second' },
      { seq: 4, kind: 'thinking', output: 'third' },
    ])

    expect(blocks.map(block => block.kind)).toEqual(['thinking', 'command'])
    expect(blocks[0].count).toBe(3)
    expect(blocks[0].text).toContain('first')
    expect(blocks[0].text).toContain('second')
    expect(blocks[0].text).toContain('third')
    expect(summary.thinking).toBe(3)
  })

  it('uses the final status of each tool call and drops empty steps', () => {
    const { blocks, summary } = buildTraceActivities([
      {
        seq: 1, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'running', command: 'ls',
      },
      {
        seq: 2, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'completed', output: 'ok',
      },
      { seq: 3, kind: 'tool', toolCallId: 'tool-2', status: 'running' },
      { seq: 4, kind: 'tool', toolCallId: 'tool-2', status: 'completed' },
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0].status).toBe('completed')
    expect(summary).toMatchObject({ commands: 1, tools: 0 })
  })

  it('merges repeated file entries when summarizing the whole turn', () => {
    const summary = summarizeTraceActivities([
      {
        kind: 'file',
        files: [{
          path: 'docs/a.md', additions: 2, deletions: 0, created: true, deleted: false, status: 'completed',
        }],
      },
      {
        kind: 'file',
        files: [{
          path: 'docs/a.md', additions: 3, deletions: 1, created: false, deleted: false, status: 'completed',
        }],
      },
    ])

    expect(summary.files).toBe(1)
    expect(summary.fileList[0]).toMatchObject({ additions: 5, deletions: 1, created: true })
  })
})
