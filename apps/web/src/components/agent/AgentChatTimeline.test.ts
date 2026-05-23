// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentActionRequest, AgentTranscriptNode } from '../../lib/api'
import { AgentChatTimeline, formatAgentElapsed, formatTimelineStatus, shouldRenderTranscriptNode, shouldShowTimelineThinking, summarizeAgentChatTimeline, technicalTimelineItems, userTimelineItems } from './AgentChatTimeline'

function item(overrides: Partial<AgentTranscriptNode> = {}): AgentTranscriptNode {
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

function action(overrides: Partial<AgentActionRequest> = {}): AgentActionRequest {
  return {
    id: 'action-1',
    threadId: 'thread-1',
    runId: 'run-1',
    kind: 'ledger.create_entry',
    status: 'pending',
    title: '新增收入入账',
    summary: '把 3 月成员 A 收入入账。',
    targetLabel: '3 月账本',
    riskLevel: 'medium',
    details: [{ label: '金额', value: '176' }],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: 'period-1' },
      panel: null,
      focusRecordId: null,
      reason: '打开记账工作台',
    },
    payload: { amount: 176 },
    createdAt: '2026-05-22T00:00:00.000Z',
    executedAt: null,
    errorMessage: null,
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
    expect(formatAgentElapsed(5)).toBe('5秒')
    expect(formatAgentElapsed(272)).toBe('4分 32秒')
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

  it('starts a visible timer immediately after user submission', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-22T00:00:05.000Z'))
    try {
      const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
        nodes: [
          item({
            id: 'user-message',
            kind: 'user_message',
            title: '用户',
            summary: '我们几个月可以回本？',
            status: 'completed',
            createdAt: '2026-05-22T00:00:00.000Z',
          }),
        ],
        busy: true,
        actionDiffsById: new Map(),
        onCancel: () => undefined,
        onConfirm: () => undefined,
        onUpdate: () => undefined,
      }))

      expect(html).toContain('正在处理 5秒')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders assistant markdown but keeps user bubbles and tool rows structured', () => {
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
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
          tool: { name: 'workspace_rename' },
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

  it('keeps completed tool details collapsed by default', () => {
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({
          id: 'tool',
          kind: 'tool_call',
          title: '查询数据',
          summary: '读取当前工作区。',
          status: 'completed',
          tool: { name: 'data_query_workspace', argumentsPreview: '{"scope":"workspace_summary"}' },
          sections: [
            {
              id: 'tool:arguments',
              kind: 'arguments',
              title: '参数',
              summary: 'workspace_summary',
              content: '{"scope":"workspace_summary"}',
              defaultOpen: false,
            },
          ],
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html).toContain('查询数据')
    expect(html).toContain('data_query_workspace')
    expect(html).not.toContain('workspace_summary')
  })

  it('renders expanded strict work cycle and tool group hierarchy without inline JSON', () => {
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({ id: 'user-message', kind: 'user_message', title: '用户', summary: '我现在几个月回本', status: 'completed' }),
        item({
          id: 'work',
          kind: 'work_group',
          title: 'Worked for 3s / 1 tools / 0 pending',
          summary: '1 个工具 / 2 个可见步骤',
          status: 'completed',
          defaultOpen: true,
          children: [
            item({
              id: 'tool-group',
              kind: 'tool_group',
              title: '调用 1 个工具',
              summary: '2 个步骤',
              status: 'completed',
              defaultOpen: true,
              children: [
                item({
                  id: 'tool',
                  kind: 'tool_call',
                  title: '调用工具：data_query_workspace',
                  summary: '工具已选择，参数可展开查看。',
                  status: 'completed',
                  defaultOpen: true,
                  tool: { name: 'data_query_workspace', argumentsPreview: '{"question":"当前工作区几个月回本","scope":"workspace_summary"}' },
                  sections: [
                    {
                      id: 'tool:arguments',
                      kind: 'arguments',
                      title: 'Arguments',
                      summary: '参数：question, scope',
                      defaultOpen: true,
                      children: [
                        {
                          id: 'tool:arguments:raw',
                          kind: 'raw',
                          title: 'Raw JSON',
                          summary: '二级折叠',
                          content: '{"question":"当前工作区几个月回本","scope":"workspace_summary"}',
                          defaultOpen: false,
                        },
                      ],
                    },
                    {
                      id: 'tool:result',
                      kind: 'result',
                      title: 'Result Preview',
                      summary: '结果已用于本轮回复',
                      content: '工具调用已完成，结果已用于本轮回复或后续业务步骤。',
                      defaultOpen: false,
                    },
                  ],
                }),
                item({
                  id: 'navigation',
                  kind: 'navigation',
                  title: '已打开：看测算',
                  summary: '工作区数据问答需要打开经营总览页面。',
                  status: 'completed',
                }),
              ],
            }),
            item({
              id: 'check',
              kind: 'evaluation',
              title: '业务检查',
              summary: '本次只读取当前工作区数据，未修改业务数据。',
              status: 'completed',
            }),
          ],
        }),
        item({ id: 'assistant', kind: 'assistant_message', title: '回复', summary: '当前还未回本。', content: '当前还未回本。', status: 'completed' }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html).toContain('我现在几个月回本')
    expect(html).toContain('用时 3秒')
    expect(html).toContain('已完成 1 个工具')
    expect(html).not.toContain('Worked for 3s / 1 tools / 0 pending')
    expect(html).toContain('调用 1 个工具')
    expect(html).toContain('查询工作区数据')
    expect(html).toContain('data_query_workspace')
    expect(html.match(/data_query_workspace/g)?.length).toBe(1)
    expect(html).not.toContain('调用工具：data_query_workspace')
    expect(html).not.toContain('工作组')
    expect(html).not.toContain('工具调用')
    expect(html).toContain('已打开：看测算')
    expect(html).not.toContain('工具已选择，参数可展开查看')
    expect(html).not.toContain('工作区数据问答需要打开经营总览页面')
    expect(html).not.toContain('业务检查')
    expect(html).not.toContain('本次只读取当前工作区数据，未修改业务数据')
    expect(html).not.toContain('结果已用于本轮回复')
    expect(html).toContain('当前还未回本。')
    expect(html).toContain('参数')
    expect(html).toContain('&quot;question&quot;')
    expect(html).toContain('workspace_summary')
    expect(html).toContain('data-transcript-tool-body="true"')
    expect(html).not.toContain('data-transcript-section-kind="arguments"')
    expect(html).not.toContain('data-transcript-section-kind="result"')
    expect(html).not.toContain('Arguments')
    expect(html).not.toContain('Result Preview')
    expect(html).not.toContain('Raw JSON')
    expect(html).toContain('border-t border-stone-200 py-2')
    expect(html).toContain('ml-5 border-l border-stone-200 py-1 pl-3')
    expect(html).toContain('grid-cols-[18px_20px_minmax(0,1fr)_auto]')
    expect(html).not.toContain('rounded-md border border-stone-900/10 bg-white')
    expect(html).not.toContain('rounded-md border border-stone-900/10 bg-stone-50')
  })

  it('renders tool arguments and returns in one expanded tool body', () => {
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({
          id: 'tool',
          kind: 'tool_call',
          title: '调用工具：data_query_workspace',
          status: 'completed',
          defaultOpen: true,
          tool: { name: 'data_query_workspace' },
          sections: [
            {
              id: 'tool:arguments',
              kind: 'arguments',
              title: 'Arguments',
              content: '{"question":"当前工作区利润","scope":"workspace_summary"}',
              defaultOpen: true,
            },
            {
              id: 'tool:result',
              kind: 'result',
              title: 'Result Preview',
              content: '总收入 ¥12,000，总成本 ¥8,000，总利润 ¥4,000。',
              defaultOpen: true,
            },
          ],
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html.match(/data-transcript-tool-body="true"/g)?.length).toBe(1)
    expect(html).toContain('参数')
    expect(html).toContain('&quot;question&quot;')
    expect(html).toContain('返回')
    expect(html).toContain('总利润 ¥4,000')
    expect(html).not.toContain('Arguments')
    expect(html).not.toContain('Result Preview')
    expect(html).not.toContain('Raw JSON')
    expect(html).not.toContain('data-transcript-section-kind="arguments"')
    expect(html).not.toContain('data-transcript-section-kind="result"')
  })

  it('hides generic result previews but keeps real tool result summaries', () => {
    const genericHtml = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({
          id: 'generic-tool',
          kind: 'tool_call',
          title: '调用工具：data_query_workspace',
          status: 'completed',
          defaultOpen: true,
          tool: { name: 'data_query_workspace' },
          sections: [
            {
              id: 'generic-tool:result',
              kind: 'result',
              title: 'Result Preview',
              content: '工具调用已完成，结果已用于本轮回复或后续业务步骤。',
              defaultOpen: true,
            },
          ],
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(genericHtml).not.toContain('Result Preview')
    expect(genericHtml).not.toContain('工具调用已完成')

    const realHtml = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({
          id: 'real-tool',
          kind: 'tool_call',
          title: '调用工具：data_query_workspace',
          status: 'completed',
          defaultOpen: true,
          tool: { name: 'data_query_workspace' },
          sections: [
            {
              id: 'real-tool:result',
              kind: 'result',
              title: 'Result Preview',
              content: '命中 3 笔分录，总收入 ¥12,000。',
              defaultOpen: true,
            },
          ],
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(realHtml).toContain('返回')
    expect(realHtml).toContain('data-transcript-tool-body="true"')
    expect(realHtml).not.toContain('Result Preview')
    expect(realHtml).toContain('命中 3 笔分录，总收入 ¥12,000。')
  })

  it('hides empty successful business checks but keeps actionable checks', () => {
    const emptyCheck = item({
      id: 'empty-check',
      kind: 'evaluation',
      title: '业务检查',
      summary: '本次只读取当前工作区数据，未修改业务数据。',
      status: 'completed',
    })
    const failedCheck = item({
      id: 'failed-check',
      kind: 'evaluation',
      title: '业务检查',
      summary: '有 1 个步骤失败，请展开查看并修复。',
      status: 'failed',
    })

    expect(shouldRenderTranscriptNode(emptyCheck)).toBe(false)
    expect(shouldRenderTranscriptNode(failedCheck)).toBe(true)

    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [emptyCheck, failedCheck],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html).toContain('有 1 个步骤失败，请展开查看并修复。')
    expect(html.match(/业务检查/g)?.length).toBe(1)
    expect(summarizeAgentChatTimeline([emptyCheck, failedCheck]).visibleCount).toBe(1)
  })

  it('opens pending confirmation sections inline by default', () => {
    const pending = action()
    const html = renderToStaticMarkup(createElement(AgentChatTimeline, {
      nodes: [
        item({
          id: 'tool-write',
          kind: 'tool_call',
          title: '调用工具：ledger.create_entry',
          summary: pending.summary,
          status: 'waiting',
          defaultOpen: true,
          tool: { name: pending.kind },
          actionRequestId: pending.id,
          actionRequest: pending,
          sections: [
            {
              id: 'tool-write:confirmation',
              kind: 'confirmation',
              title: '确认卡',
              summary: pending.summary,
              actionRequest: pending,
              defaultOpen: true,
            },
          ],
        }),
      ],
      busy: false,
      actionDiffsById: new Map(),
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onUpdate: () => undefined,
    }))

    expect(html).toContain('确认执行')
    expect(html).toContain('新增收入入账')
    expect(html).toContain('176')
  })
})
