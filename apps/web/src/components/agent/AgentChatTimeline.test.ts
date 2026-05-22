// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentTimelineItem } from '../../lib/api'
import { AgentChatTimeline, formatTimelineStatus, shouldShowTimelineThinking, summarizeAgentChatTimeline, technicalTimelineItems, userTimelineItems } from './AgentChatTimeline'

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

  it('shows Thinking after a submitted user message until visible work appears', () => {
    const userMessage = item({
      id: 'user-message',
      kind: 'user_message',
      title: '用户',
      summary: '你好',
      status: 'completed',
    })

    expect(shouldShowTimelineThinking([userMessage], true)).toBe(true)
    expect(shouldShowTimelineThinking([], true)).toBe(true)
    expect(shouldShowTimelineThinking([userMessage], false)).toBe(false)
    expect(shouldShowTimelineThinking([
      userMessage,
      item({ id: 'stream', kind: 'assistant_stream', title: '实时回复', summary: '你好', status: 'running' }),
    ], true)).toBe(false)
    expect(shouldShowTimelineThinking([
      userMessage,
      item({ id: 'tool', kind: 'tool_call', title: '调用工具：workspace_rename', summary: '准备修改工作区。', status: 'running' }),
    ], true)).toBe(false)
  })

  it('renders assistant markdown but keeps user bubbles and tool rows structured', () => {
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      items: [
        item({
          id: 'user-message',
          kind: 'user_message',
          title: '用户',
          summary: '**不要渲染用户输入**',
          status: 'completed',
        }),
        item({
          id: 'assistant',
          kind: 'assistant_message',
          title: '回复',
          content: '我是 **Agent**\n\n- 可以查数据',
          summary: '我是 **Agent**',
          status: 'completed',
        }),
        item({
          id: 'tool',
          kind: 'tool_call',
          title: '调用工具：workspace_rename',
          summary: '**workspace_rename** 准备执行。',
          status: 'running',
          toolName: 'workspace_rename',
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html).toContain('<strong>Agent</strong>')
    expect(html).toContain('<li>可以查数据</li>')
    expect(html).toContain('**不要渲染用户输入**')
    expect(html).not.toContain('<strong>不要渲染用户输入</strong>')
    expect(html).toContain('**workspace_rename** 准备执行。')
    expect(html).not.toContain('<strong>workspace_rename</strong>')
  })
})
