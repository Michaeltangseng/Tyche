import { describe, expect, it } from 'vitest'
import {
  agentUsageRows,
  formatTokenCount,
  formatUsageLine,
  indexUsageByRun,
  previewText,
  toolActivity,
} from '../../room-usage.js'

describe('room usage', () => {
  it('compacts token counts the way a member strip is read', () => {
    expect(formatTokenCount(340)).toBe('340')
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(8_100_000)).toBe('8.1M')
  })

  it('formats one turn as in, out, and cache', () => {
    expect(formatUsageLine({
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 8100,
    })).toBe('in 1.2k · out 340 · cache 8.1k')
    expect(formatUsageLine({ totalTokens: 10 })).toBe('')
  })

  it('keeps the latest usage snapshot for each run', () => {
    const indexed = indexUsageByRun([
      { runId: 'run-1', payload: { kind: 'usage', usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 } } },
      { runId: 'run-1', payload: { kind: 'usage', usage: { inputTokens: 40, outputTokens: 8, cachedInputTokens: 12 } } },
      { runId: 'run-2', payload: { kind: 'text_delta', text: 'skip' } },
    ])
    expect(indexed['run-1'].inputTokens).toBe(40)
    expect(indexed['run-2']).toBeUndefined()
  })

  it('keeps a run\'s token totals when a later event only reports context', () => {
    const indexed = indexUsageByRun([
      {
        runId: 'run-1',
        payload: {
          kind: 'usage',
          usage: { inputTokens: 14920, outputTokens: 790, cachedInputTokens: 29824 },
        },
      },
      {
        runId: 'run-1',
        payload: { kind: 'usage', usage: { context: { percent: 2 } } },
      },
    ])
    expect(indexed['run-1']).toEqual({
      inputTokens: 14920,
      outputTokens: 790,
      cachedInputTokens: 29824,
      context: { percent: 2 },
    })
  })

  it('sums each agent across turns and keeps the latest context fill', () => {
    const rows = agentUsageRows({
      roles: [
        { id: 'captain', display_name: 'Claude Code', provider: 'claude', model: 'claude-haiku' },
        { id: 'worker', display_name: 'Codex', provider: 'codex', model: '' },
      ],
      messages: [
        { id: 'm1', author_type: 'agent', author_id: 'captain', status: 'done' },
        { id: 'm2', author_type: 'agent', author_id: 'captain', status: 'working' },
        { id: 'm3', author_type: 'user', author_id: 'user', status: 'done' },
      ],
      usageByRun: {
        m1: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100, context: { percent: 3 } },
      },
      liveRuns: {
        m2: { usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: 0, context: { percent: 8 } }, status: 'running' },
      },
    })
    expect(rows[0]).toMatchObject({
      id: 'captain',
      name: 'Claude Code',
      model: 'claude-haiku',
      status: 'working',
      contextPercent: 8,
    })
    expect(rows[0].usage).toEqual({ inputTokens: 1200, outputTokens: 240, cachedInputTokens: 100 })
    expect(rows[1]).toMatchObject({ name: 'Codex', model: 'codex', status: 'idle', contextPercent: null })
    expect(rows[1].usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })
  })

  it('sums token totals stored on finished replies when the live index is empty', () => {
    const rows = agentUsageRows({
      roles: [{ id: 'captain', display_name: 'Claude Code', provider: 'claude' }],
      messages: [{
        id: 'm1',
        author_type: 'agent',
        author_id: 'captain',
        status: 'done',
        data: { usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 50, context: { percent: 6 } } },
      }],
      usageByRun: {},
      liveRuns: {},
    })
    expect(rows[0].usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 50 })
    expect(rows[0].contextPercent).toBe(6)
  })

  it('names a tool step by its verb and file', () => {
    expect(toolActivity({ name: 'Read', input: '/repo/README.zh-CN.md' })).toEqual({
      verb: 'read',
      target: 'README.zh-CN.md',
      name: 'Read',
    })
    expect(previewText('a\nb\nc', 2)).toEqual({ text: 'a\nb', truncated: true, hidden: 1 })
  })
})
