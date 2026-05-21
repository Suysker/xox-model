import type { AgentTranscriptItem } from '../../lib/api'
import { formatTranscriptStatus, summarizeExecutionTranscript, technicalTranscriptItems, userTranscriptItems } from './AgentExecutionTranscript'

function item(overrides: Partial<AgentTranscriptItem> = {}): AgentTranscriptItem {
  return {
    id: overrides.id ?? 'item-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sequence: overrides.sequence ?? 1,
    kind: overrides.kind ?? 'planning',
    title: overrides.title ?? '正在规划下一步',
    summary: overrides.summary ?? '正在准备工具调用。',
    status: overrides.status ?? 'running',
    visibility: overrides.visibility ?? 'user',
    sourceType: overrides.sourceType ?? 'model_planning',
    agUiEventType: overrides.agUiEventType ?? 'STEP_STARTED',
    createdAt: '2026-05-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('AgentExecutionTranscript helpers', () => {
  it('separates user transcript rows from technical harness rows', () => {
    const items = [
      item({ id: 'user-1', title: '调用工具：ledger_create_entry', kind: 'tool_call', status: 'running' }),
      item({ id: 'tech-1', title: 'Worker 已认领', summary: '后台 worker 已取得 run lease。', kind: 'technical', visibility: 'technical' }),
      item({ id: 'user-2', title: '需要确认：新增收入', kind: 'confirmation', status: 'waiting' }),
    ]

    expect(userTranscriptItems(items).map((row) => row.title)).toEqual(['调用工具：ledger_create_entry', '需要确认：新增收入'])
    expect(technicalTranscriptItems(items).map((row) => row.title)).toEqual(['Worker 已认领'])
    expect(summarizeExecutionTranscript(items)).toMatchObject({
      visibleCount: 2,
      technicalCount: 1,
      runningCount: 1,
      waitingCount: 1,
      failedCount: 0,
    })
  })

  it('uses business-facing status labels', () => {
    expect(formatTranscriptStatus('waiting')).toBe('待确认')
    expect(formatTranscriptStatus('running')).toBe('进行中')
    expect(formatTranscriptStatus('completed')).toBe('完成')
  })
})
