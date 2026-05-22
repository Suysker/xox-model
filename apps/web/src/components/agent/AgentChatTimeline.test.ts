import type { AgentTimelineItem } from '../../lib/api'
import { formatTimelineStatus, summarizeAgentChatTimeline, technicalTimelineItems, userTimelineItems } from './AgentChatTimeline'

function item(overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return {
    id: overrides.id ?? 'item-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sequence: overrides.sequence ?? 1,
    kind: overrides.kind ?? 'tool_call',
    title: overrides.title ?? '调用工具：ledger_create_entry',
    summary: overrides.summary ?? '准备工具调用。',
    status: overrides.status ?? 'running',
    visibility: overrides.visibility ?? 'user',
    createdAt: '2026-05-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('AgentChatTimeline helpers', () => {
  it('keeps user timeline and technical log separated', () => {
    const items = [
      item({ id: 'user-message', kind: 'user_message', title: '你', summary: '记一笔收入', status: 'completed' }),
      item({ id: 'tool', kind: 'tool_call', title: '调用工具：ledger_create_entry' }),
      item({ id: 'confirmation', kind: 'confirmation', title: '新增收入入账', status: 'waiting' }),
      item({ id: 'technical', kind: 'technical', title: 'Worker 已认领', summary: 'run lease', visibility: 'technical' }),
    ]

    expect(userTimelineItems(items).map((row) => row.id)).toEqual(['user-message', 'tool', 'confirmation'])
    expect(technicalTimelineItems(items).map((row) => row.title)).toEqual(['Worker 已认领'])
    expect(summarizeAgentChatTimeline(items)).toMatchObject({
      visibleCount: 3,
      technicalCount: 1,
      toolCount: 1,
      waitingCount: 1,
      failedCount: 0,
    })
  })

  it('uses business-facing status labels', () => {
    expect(formatTimelineStatus('waiting')).toBe('待确认')
    expect(formatTimelineStatus('running')).toBe('进行中')
    expect(formatTimelineStatus('completed')).toBe('完成')
  })
})
