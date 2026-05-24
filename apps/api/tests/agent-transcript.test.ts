import { describe, expect, it } from 'vitest'
import type { AgentActionRequest, AgentMessage, AgentNavigationEvent, AgentPlanStep, AgentRunEvent, AgentTranscriptSection } from '@xox/contracts'
import { buildAgentAgUiEvents } from '../src/agent/ag-ui-projection.js'
import { buildAgentTranscriptItems } from '../src/agent/agent-transcript-projector.js'
import { buildAgentTimelineItems, buildAgentTranscriptNodes } from '../src/agent/agent-timeline-projector.js'
import type { AgentProjectionState } from '../src/agent/ag-ui-projection.js'

const createdAt = '2026-05-22T00:00:00.000Z'

function navigation(): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: 'period-1' },
    panel: null,
    focusRecordId: null,
    reason: '记账动作需要打开本期账本。',
  }
}

function runEvent(overrides: Partial<AgentRunEvent>): AgentRunEvent {
  return {
    id: `event-${overrides.sequence ?? 1}`,
    threadId: 'thread-1',
    runId: 'run-1',
    sequence: overrides.sequence ?? 1,
    type: 'run_queued',
    title: 'Run 已入队',
    message: '用户指令已持久化，等待 Agent worker 认领执行。',
    status: 'queued',
    data: null,
    createdAt,
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
    navigation: navigation(),
    payload: { amount: 176 },
    createdAt,
    executedAt: null,
    errorMessage: null,
    ...overrides,
  }
}

function planStep(overrides: Partial<AgentPlanStep> = {}): AgentPlanStep {
  return {
    id: 'step-1',
    threadId: 'thread-1',
    runId: 'run-1',
    actionRequestId: 'action-1',
    sequence: 1,
    title: '新增收入入账',
    description: '生成确认卡等待确认。',
    status: 'ready',
    navigation: navigation(),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function defaultMessages(): AgentMessage[] {
  return [
    {
      id: 'message-user-1',
      threadId: 'thread-1',
      role: 'user',
      content: '把 3 月成员 A 收入入账。',
      createdAt,
    },
    {
      id: 'message-assistant-1',
      threadId: 'thread-1',
      role: 'assistant',
      content: '我已经准备好一张确认卡，请检查金额后确认。',
      createdAt,
    },
  ]
}

function projectionState(input: { runEvents: AgentRunEvent[]; planSteps?: AgentPlanStep[]; actionRequests?: AgentActionRequest[]; messages?: AgentMessage[] }): AgentProjectionState {
  return {
    thread: { id: 'thread-1' },
    messages: input.messages ?? defaultMessages(),
    goals: [],
    evaluations: [],
    navigationEvents: input.planSteps?.map((step) => step.navigation).filter((item): item is AgentNavigationEvent => Boolean(item)) ?? [],
    runEvents: input.runEvents,
    planSteps: input.planSteps ?? [],
    actionRequests: input.actionRequests ?? [],
  }
}

function flattenNodes(nodes: ReturnType<typeof buildAgentTranscriptNodes>) {
  return nodes.flatMap((node): ReturnType<typeof buildAgentTranscriptNodes> => [node, ...flattenNodes(node.children ?? [])])
}

function flattenSections(sections: AgentTranscriptSection[] = []): AgentTranscriptSection[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children ?? [])])
}

describe('Agent execution transcript projection', () => {
  it('keeps harness internals out of the default user transcript', () => {
    const transcript = buildAgentTranscriptItems(projectionState({
      runEvents: [
        runEvent({ sequence: 1, type: 'run_queued', title: 'Run 已入队', message: '用户指令已持久化，等待 Agent worker 认领执行。' }),
        runEvent({ sequence: 2, type: 'worker_claimed', title: 'Worker 已认领', message: '后台 worker 已取得 run lease，开始执行。', status: 'running' }),
        runEvent({ sequence: 3, type: 'goal_contract_created', title: '目标契约已建立', message: 'Goal Run Engine 已建立目标契约。', status: 'info' }),
        runEvent({ sequence: 4, type: 'goal_iteration_started', title: '目标循环 1', message: '开始第一轮模型规划。', status: 'running' }),
        runEvent({ sequence: 5, type: 'model_planning', title: '模型规划中', message: '正在调用配置的模型。', status: 'running' }),
      ],
    }))

    const visibleText = transcript.filter((item) => item.visibility === 'user').map((item) => `${item.title}\n${item.summary}`).join('\n')
    expect(visibleText).toContain('正在理解你的目标')
    expect(visibleText).toContain('已拆解业务目标')
    expect(visibleText).toContain('正在规划下一步')
    expect(visibleText).not.toContain('Run 已入队')
    expect(visibleText).not.toContain('Worker 已认领')
    expect(visibleText).not.toContain('run lease')
    expect(visibleText).not.toContain('目标循环')

    const technicalText = transcript.filter((item) => item.visibility === 'technical').map((item) => item.title).join('\n')
    expect(technicalText).toContain('Run 已入队')
    expect(technicalText).toContain('Worker 已认领')
    expect(technicalText).toContain('目标循环 1')
  })

  it('projects tool-call streaming, confirmation interrupts, edits, and execution results', () => {
    const state = projectionState({
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_started', title: 'Provider 流已打开', message: '正在接收 deepseek 输出。', status: 'running', data: { kind: 'stream_started' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '工具调用片段', message: 'ledger_create_entry', status: 'running', data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'ledger_create_entry', argumentsPreview: '{"amount":176}' } }),
        runEvent({ sequence: 3, type: 'action_updated', title: '确认卡已编辑', message: '确认卡已编辑：新增收入入账', status: 'info', data: { actionRequestId: 'action-1', actionKind: 'ledger.create_entry', changes: [{ label: '金额', value: '176 -> 188' }] } }),
        runEvent({ sequence: 4, type: 'action_executed', title: '确认卡已执行', message: '已执行：新增收入入账', status: 'completed', data: { actionRequestId: 'action-1', actionKind: 'ledger.create_entry' } }),
      ],
      planSteps: [planStep()],
      actionRequests: [action()],
    })
    const agUiEvents = buildAgentAgUiEvents(state)
    const transcript = buildAgentTranscriptItems(state)

    expect(agUiEvents.some((event) => event.type === 'TOOL_CALL_ARGS' && event.toolName === 'ledger_create_entry')).toBe(true)
    expect(agUiEvents.some((event) => event.type === 'CUSTOM' && event.name === 'xox.interrupt.confirmation_card')).toBe(true)
    expect(agUiEvents.some((event) => event.type === 'TOOL_CALL_RESULT' && event.toolName === 'ledger.create_entry')).toBe(true)

    expect(transcript.some((item) => item.kind === 'tool_call' && item.title === '调用工具：ledger_create_entry')).toBe(true)
    expect(transcript.some((item) => item.kind === 'confirmation' && item.status === 'waiting')).toBe(true)
    expect(transcript.some((item) => item.kind === 'action_update' && item.details?.[0]?.value === '176 -> 188')).toBe(true)
    expect(transcript.some((item) => item.kind === 'tool_result' && item.status === 'completed')).toBe(true)
  })

  it('builds one unified chat timeline with inline confirmations and technical separation', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      runEvents: [
        runEvent({ sequence: 1, type: 'run_queued', title: 'Run 已入队', message: '用户指令已持久化，等待 Agent worker 认领执行。' }),
        runEvent({ sequence: 2, type: 'worker_claimed', title: 'Worker 已认领', message: '后台 worker 已取得 run lease，开始执行。', status: 'running' }),
        runEvent({ sequence: 3, type: 'provider_stream_delta', title: '工具调用片段', message: 'ledger_create_entry', status: 'running', data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'ledger_create_entry', argumentsPreview: '{"amount":176}' } }),
        runEvent({ sequence: 4, type: 'tool_plan_ready', title: '模型工具调用已解析', message: '模型规划生成 1 个步骤。', status: 'running', data: { stepCount: 1, pendingActionCount: 1 } }),
      ],
      planSteps: [planStep()],
      actionRequests: [action()],
    }))

    const visible = timeline.filter((item) => item.visibility === 'user')
    const technical = timeline.filter((item) => item.visibility === 'technical')

    expect(visible.map((item) => item.kind)).toContain('user_message')
    expect(visible.map((item) => item.kind)).toContain('assistant_message')
    expect(visible.some((item) => item.kind === 'tool_call' && item.toolName === 'ledger_create_entry')).toBe(true)
    expect(visible.some((item) => item.kind === 'tool_call' && item.actionRequest?.id === 'action-1')).toBe(true)
    const visibleText = visible.map((item) => `${item.title}\n${item.summary}`).join('\n')
    expect(visibleText).not.toContain('run lease')
    expect(visibleText).not.toContain('业务步骤已生成')
    expect(technical.map((item) => item.title).join('\n')).toContain('Worker 已认领')
  })

  it('keeps a simple greeting concise in the default timeline', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-greeting', threadId: 'thread-1', role: 'user', content: '你好', createdAt },
        { id: 'message-assistant-greeting', threadId: 'thread-1', role: 'assistant', content: '你好！我是 xox-model Agent OS。', createdAt },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'run_queued', title: 'Run 已入队', message: '用户指令已持久化，等待 Agent worker 认领执行。' }),
        runEvent({ sequence: 2, type: 'goal_contract_created', title: '目标契约已建立', message: 'Goal Run Engine 已建立目标契约。', status: 'info' }),
        runEvent({ sequence: 3, type: 'model_planning', title: '模型规划中', message: '正在调用配置的模型。', status: 'running' }),
        runEvent({ sequence: 4, type: 'memory_recall_started', title: '正在查找相关记忆', message: '正在查找与本次任务相关的工作区记忆。', status: 'running' }),
        runEvent({ sequence: 5, type: 'provider_stream_delta', title: '文本片段', message: '你好', status: 'running', data: { kind: 'content_delta', preview: '你好！我是 xox-model Agent OS。' } }),
        runEvent({ sequence: 6, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { toolCallCount: 0 } }),
        runEvent({ sequence: 7, type: 'tool_plan_ready', title: '模型回复已生成', message: '模型规划生成 1 个步骤。', status: 'completed', data: { stepCount: 1, pendingActionCount: 0 } }),
        runEvent({ sequence: 8, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
    }))

    const visible = timeline.filter((item) => item.visibility === 'user')
    const technical = timeline.filter((item) => item.visibility === 'technical')

    expect(visible.map((item) => item.kind)).toEqual(['user_message', 'assistant_message'])
    expect(visible.map((item) => `${item.title}\n${item.summary}`).join('\n')).not.toContain('正在规划下一步')
    expect(visible.map((item) => `${item.title}\n${item.summary}`).join('\n')).not.toContain('正在查找相关记忆')
    expect(technical.some((item) => item.title === '正在查找相关记忆')).toBe(true)
  })

  it('keeps provider stream lifecycle metadata out of the user timeline', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-provider-stream', threadId: 'thread-1', role: 'user', content: '我们几个月可以回本？', createdAt },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_started', title: 'Provider 流已打开', message: '正在接收 deepseek / deepseek-v4-pro 的流式输出。', status: 'running', data: { kind: 'stream_started' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '模型输出片段', message: '当前未回本。', status: 'running', data: { kind: 'content_delta', preview: '当前未回本。' } }),
        runEvent({ sequence: 3, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { kind: 'stream_completed', toolCallCount: 0 } }),
      ],
    }))

    const visible = timeline.filter((item) => item.visibility === 'user')
    const technical = timeline.filter((item) => item.visibility === 'technical')

    expect(visible.some((item) => item.kind === 'assistant_stream' && item.summary.includes('当前未回本'))).toBe(true)
    expect(visible.map((item) => `${item.title}\n${item.summary}`).join('\n')).not.toContain('Provider 流')
    expect(technical.map((item) => item.title)).toContain('正在规划下一步')
    expect(technical.map((item) => item.title)).toContain('模型回复已完成')
  })

  it('keeps provider retry and repair events in the technical timeline only', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-provider-retry', threadId: 'thread-1', role: 'user', content: '生成复杂经营模型', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_retrying',
          title: '模型服务请求重试',
          message: '模型服务返回的流式工具调用不可解析，正在改用非流式请求对同一轮规划重试一次。',
          status: 'running',
          data: { toolName: 'workspace_configure_operating_model' },
        }),
        runEvent({
          sequence: 2,
          type: 'provider_tool_call_repaired',
          title: '工具参数已修复',
          message: '模型返回的工具参数包含污染片段，已在安全范围内修复后继续。',
          status: 'info',
          data: { toolName: 'workspace_configure_operating_model' },
        }),
      ],
    }))

    const visibleText = timeline.filter((item) => item.visibility === 'user').map((item) => `${item.title}\n${item.summary}`).join('\n')
    const technicalSourceTypes = timeline.filter((item) => item.visibility === 'technical').map((item) => item.sourceType)

    expect(visibleText).not.toContain('正在重试工具规划')
    expect(visibleText).not.toContain('工具参数已修复')
    expect(visibleText).not.toContain('流式工具调用不可解析')
    expect(technicalSourceTypes).toContain('provider_retrying')
    expect(technicalSourceTypes).toContain('provider_tool_call_repaired')
  })

  it('projects simple greetings as only user and assistant transcript nodes', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-greeting', threadId: 'thread-1', role: 'user', content: '你好', createdAt },
        { id: 'message-assistant-greeting', threadId: 'thread-1', role: 'assistant', content: '你好！我是 xox-model Agent OS。', createdAt },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'run_queued', title: 'Run 已入队', message: '用户指令已持久化，等待 Agent worker 认领执行。' }),
        runEvent({ sequence: 2, type: 'goal_contract_created', title: '目标契约已建立', message: 'Goal Run Engine 已建立目标契约。', status: 'info' }),
        runEvent({ sequence: 3, type: 'memory_recall_started', title: '正在查找相关记忆', message: '正在查找与本次任务相关的工作区记忆。', status: 'running' }),
        runEvent({ sequence: 4, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    const technical = nodes.filter((node) => node.visibility === 'technical')

    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'assistant_message'])
    expect(visible.map((node) => `${node.title}\n${node.summary}`).join('\n')).not.toContain('Run 已入队')
    expect(technical.map((node) => node.title)).toContain('正在查找相关记忆')
  })

  it('attaches pending confirmation cards to the producing tool node', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_delta', title: '工具调用片段', message: 'ledger_create_entry', status: 'running', data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'ledger_create_entry', argumentsPreview: '{"amount":176}' } }),
        runEvent({ sequence: 2, type: 'tool_plan_ready', title: '模型工具调用已解析', message: '模型规划生成 1 个步骤。', status: 'running', data: { stepCount: 1, pendingActionCount: 1 } }),
        runEvent({ sequence: 3, type: 'confirmation_ready', title: '需要你确认动作', message: '已生成 1 张待确认动作卡，用户可编辑后执行。', status: 'blocked', data: { actionRequestIds: ['action-1'] } }),
      ],
      planSteps: [planStep()],
      actionRequests: [action()],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    const workGroup = visible.find((node) => node.kind === 'work_group')
    const toolGroup = workGroup?.children?.find((node) => node.kind === 'tool_group')
    const toolNode = flattenNodes(nodes).find((node) => node.kind === 'tool_call' && node.actionRequest?.id === 'action-1')
    const navigationNode = toolGroup?.children?.find((node) => node.kind === 'navigation')
    const sections = flattenSections(toolNode?.sections)

    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'work_group', 'assistant_message'])
    expect(flattenNodes(nodes).map((node) => `${node.title}\n${node.summary}`).join('\n')).not.toContain('需要你确认动作')
    expect(flattenNodes(nodes).map((node) => `${node.title}\n${node.summary}`).join('\n')).not.toContain('待确认动作卡')
    expect(workGroup).toBeTruthy()
    expect(toolGroup).toBeTruthy()
    expect(toolNode).toBeTruthy()
    expect(toolNode?.defaultOpen).toBe(true)
    expect(navigationNode?.title).toContain('已打开')
    expect(workGroup?.children?.some((node) => node.kind === 'evaluation')).toBe(false)
    expect(toolNode?.summary).not.toContain('"amount"')
    expect(sections.some((section) => section.kind === 'confirmation' && section.actionRequest?.id === 'action-1' && section.defaultOpen)).toBe(true)
    expect(toolNode?.sections?.some((section) => section.kind === 'arguments')).toBe(true)
    expect(sections.some((section) => section.kind === 'raw' && section.content?.includes('"amount":176') && section.defaultOpen === false)).toBe(true)
  })

  it('wraps a single read-only tool in mandatory work and tool groups', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-payback', threadId: 'thread-1', role: 'user', content: '我现在几个月回本', createdAt },
        { id: 'message-assistant-payback', threadId: 'thread-1', role: 'assistant', content: '当前按资金回报率计算还未回本。', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'data_query_workspace',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 0,
            toolName: 'data_query_workspace',
            argumentsPreview: '{"question":"当前工作区几个月回本","scope":"workspace_summary","metrics":["payback"]}',
          },
        }),
        runEvent({ sequence: 2, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { toolCallCount: 1 } }),
        runEvent({ sequence: 3, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
      planSteps: [
        planStep({
          id: 'step-read',
          actionRequestId: null,
          title: '查询回本周期',
          description: '已读取当前工作区测算结果。',
          status: 'executed',
          navigation: { ...navigation(), route: { mainTab: 'dashboard', secondaryTab: 'overview', selectedPeriodId: null }, reason: '工作区数据问答需要打开经营总览页面，便于核对口径。' },
        }),
      ],
      actionRequests: [],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    const workGroup = visible.find((node) => node.kind === 'work_group')
    const toolGroup = workGroup?.children?.find((node) => node.kind === 'tool_group')
    const toolNode = toolGroup?.children?.find((node) => node.kind === 'tool_call')
    const navigationNode = toolGroup?.children?.find((node) => node.kind === 'navigation')
    const sections = flattenSections(toolNode?.sections)
    const resultSection = toolNode?.sections?.find((section) => section.kind === 'result')

    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'work_group', 'assistant_message'])
    expect(workGroup?.title).toMatch(/^Worked for .* \/ 1 tools \/ 0 pending$/)
    expect(workGroup?.defaultOpen).toBe(true)
    expect(toolGroup?.title).toBe('调用 1 个工具')
    expect(toolGroup?.defaultOpen).toBe(true)
    expect(toolNode).toMatchObject({ tool: { name: 'data_query_workspace' }, status: 'completed' })
    expect(toolNode?.summary).not.toContain('"question"')
    expect(toolNode?.summary).not.toContain('workspace_summary')
    expect(toolNode?.sections?.some((section) => section.kind === 'arguments' && section.title === 'Arguments')).toBe(true)
    expect(toolNode?.sections?.some((section) => section.kind === 'result' && section.title === 'Result Preview')).toBe(true)
    expect(resultSection?.content).toBe('已读取当前工作区测算结果。')
    expect(sections.some((section) => section.kind === 'raw' && section.content?.includes('"question"'))).toBe(true)
    expect(navigationNode?.title).toBe('已打开：看测算')
    expect(workGroup?.children?.some((node) => node.kind === 'evaluation')).toBe(false)
    expect(workGroup?.children?.some((node) => node.title === '查询回本周期')).toBe(false)
    expect(nodes.filter((node) => node.kind === 'navigation')).toHaveLength(0)
  })

  it('attaches read results to the matching provider tool instead of the nearest later tool', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-mixed-tools', threadId: 'thread-1', role: 'user', content: '查回本，再问我缺哪个成员', createdAt },
        { id: 'message-assistant-mixed-tools', threadId: 'thread-1', role: 'assistant', content: '当前未回本，还需要确认成员。', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'data_query_workspace',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 0,
            toolName: 'data_query_workspace',
            argumentsPreview: '{"question":"我们几个月才能回本？","scope":"workspace_summary","metrics":["payback"]}',
          },
        }),
        runEvent({
          sequence: 2,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'ask_user_clarification',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 1,
            toolName: 'ask_user_clarification',
            argumentsPreview: '{"missingFields":["memberName"],"question":"你说的成员A是哪位？"}',
          },
        }),
        runEvent({ sequence: 3, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
      planSteps: [
        planStep({
          id: 'step-data-query',
          actionRequestId: null,
          sequence: 1,
          title: '查询回本周期',
          description: '基准场景总收入 ¥4,375,800，总成本 ¥7,273,781，总利润 ¥-2,897,981。',
          status: 'executed',
          navigation: null,
          toolName: 'data_query_workspace',
          toolCallId: 'call_data_query_workspace',
          toolArguments: { scope: 'workspace_summary', metrics: ['payback'] },
        }),
        planStep({
          id: 'step-clarification',
          actionRequestId: null,
          sequence: 2,
          title: '需要补充信息',
          description: '当前团队里没有叫「成员A」的成员，请确认是哪位。',
          status: 'info',
          navigation: null,
          toolName: 'ask_user_clarification',
          toolCallId: 'call_ask_user_clarification',
          toolArguments: { missingFields: ['memberName'] },
        }),
      ],
      actionRequests: [],
    }))

    const toolGroup = flattenNodes(nodes).find((node) => node.kind === 'tool_group')
    const dataNode = toolGroup?.children?.find((node) => node.tool?.name === 'data_query_workspace')
    const clarificationNode = toolGroup?.children?.find((node) => node.tool?.name === 'ask_user_clarification')
    const dataResult = dataNode?.sections?.find((section) => section.kind === 'result')?.content
    const clarificationResult = clarificationNode?.sections?.find((section) => section.kind === 'result')?.content

    expect(dataResult).toContain('基准场景总收入')
    expect(clarificationResult ?? '').not.toContain('基准场景总收入')
    expect(flattenSections(dataNode?.sections).some((section) => section.kind === 'raw' && section.content?.includes('workspace_summary'))).toBe(true)
  })

  it('uses provider tool index as a compatibility fallback for older read plan steps without tool metadata', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-old-run', threadId: 'thread-1', role: 'user', content: '查回本，再问我缺哪个成员', createdAt },
        { id: 'message-assistant-old-run', threadId: 'thread-1', role: 'assistant', content: '当前未回本，还需要确认成员。', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'data_query_workspace',
          status: 'running',
          data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'data_query_workspace', argumentsPreview: '{"scope":"workspace_summary"}' },
        }),
        runEvent({
          sequence: 2,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'ask_user_clarification',
          status: 'running',
          data: { kind: 'tool_call_delta', toolCallIndex: 1, toolName: 'ask_user_clarification', argumentsPreview: '{"missingFields":["memberName"]}' },
        }),
        runEvent({ sequence: 3, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
      planSteps: [
        planStep({
          id: 'step-old-data-query',
          actionRequestId: null,
          sequence: 1,
          title: '查询回本周期',
          description: '基准场景总收入 ¥4,375,800，总成本 ¥7,273,781。',
          status: 'executed',
          navigation: null,
        }),
      ],
      actionRequests: [],
    }))

    const toolGroup = flattenNodes(nodes).find((node) => node.kind === 'tool_group')
    const dataNode = toolGroup?.children?.find((node) => node.tool?.name === 'data_query_workspace')
    const clarificationNode = toolGroup?.children?.find((node) => node.tool?.name === 'ask_user_clarification')

    expect(dataNode?.sections?.find((section) => section.kind === 'result')?.content).toContain('基准场景总收入')
    expect(clarificationNode?.sections?.find((section) => section.kind === 'result')?.content ?? '').not.toContain('基准场景总收入')
  })

  it('merges provider draft tool calls into the generic workspace confirmation row', () => {
    const draftNavigation: AgentNavigationEvent = {
      type: 'navigation',
      route: { mainTab: 'inputs', secondaryTab: 'revenue' },
      panel: null,
      focusRecordId: null,
      reason: '线上系数属于收入引擎设置，先打开调模型页面供核对。',
    }
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-write', threadId: 'thread-1', role: 'user', content: '把 4 月线上系数改成 0.3 并保存', createdAt },
        { id: 'message-assistant-write', threadId: 'thread-1', role: 'assistant', content: '我已生成确认卡。', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'workspace_update_online_factor',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 0,
            toolName: 'workspace_update_online_factor',
            argumentsPreview: '{"monthLabel":"4月","onlineSalesFactor":0.3}',
          },
        }),
        runEvent({ sequence: 2, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { toolCallCount: 1 } }),
        runEvent({ sequence: 3, type: 'tool_plan_ready', title: '模型工具调用已解析', message: '模型规划生成 1 个步骤。', status: 'blocked', data: { stepCount: 1, pendingActionCount: 1 } }),
      ],
      planSteps: [
        planStep({
          id: 'step-online-factor',
          actionRequestId: 'action-online-factor',
          title: '确认修改线上系数',
          description: '将4月线上系数改为 0.3 并保存到当前草稿。',
          navigation: draftNavigation,
        }),
      ],
      actionRequests: [
        action({
          id: 'action-online-factor',
          kind: 'workspace.update_draft',
          title: '确认修改线上系数',
          summary: '将4月线上系数改为 0.3 并保存到当前草稿。',
          targetLabel: '4月',
          details: [
            { label: '月份', value: '4月' },
            { label: '原线上系数', value: '0' },
            { label: '新线上系数', value: '0.3' },
          ],
          navigation: draftNavigation,
          payload: { revision: 1, workspaceName: '默认工作区', config: { months: [] } },
        }),
      ],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    const workGroup = visible.find((node) => node.kind === 'work_group')
    const toolGroup = workGroup?.children?.find((node) => node.kind === 'tool_group')
    const toolNodes = toolGroup?.children?.filter((node) => node.kind === 'tool_call') ?? []
    const toolNode = toolNodes[0]
    const sections = flattenSections(toolNode?.sections)

    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'work_group', 'assistant_message'])
    expect(workGroup?.title).toMatch(/^Worked for .* \/ 1 tools \/ 1 pending$/)
    expect(toolGroup?.title).toBe('调用 1 个工具')
    expect(toolNodes).toHaveLength(1)
    expect(toolNode?.tool?.name).toBe('workspace_update_online_factor')
    expect(toolNode?.actionRequest?.kind).toBe('workspace.update_draft')
    expect(toolNode?.summary).toContain('线上系数')
    expect(sections.some((section) => section.kind === 'arguments')).toBe(true)
    expect(sections.some((section) => section.kind === 'raw' && section.content?.includes('onlineSalesFactor'))).toBe(true)
    expect(sections.some((section) => section.kind === 'confirmation' && section.actionRequest?.id === 'action-online-factor')).toBe(true)
    expect(workGroup?.children?.some((node) => node.kind === 'evaluation')).toBe(false)
  })

  it('keeps planner preface text but drops duplicated final-answer stream after tool observations', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-preface', threadId: 'thread-1', role: 'user', content: '回本并记一笔账', createdAt },
        { id: 'message-assistant-preface', threadId: 'thread-1', role: 'assistant', content: '当前还不能回本，我已经准备好确认卡。', createdAt: '2026-05-22T00:00:08.000Z' },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_delta', title: '模型输出片段', message: '我先拆成查询和记账两步。', status: 'running', data: { kind: 'content_delta', phase: 'planning', preview: '我先拆成查询和记账两步。' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '工具调用片段', message: 'ledger_create_entry', status: 'running', data: { kind: 'tool_call_delta', phase: 'planning', toolCallIndex: 0, toolName: 'ledger_create_entry', argumentsPreview: '{"amount":176}' } }),
        runEvent({ sequence: 3, type: 'provider_stream_delta', title: '模型输出片段', message: '当前还不能回本', status: 'running', data: { kind: 'content_delta', phase: 'final_answer', preview: '当前还不能回本，我已经准备好确认卡。' } }),
        runEvent({ sequence: 4, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { toolCallCount: 0, phase: 'final_answer' } }),
      ],
      planSteps: [planStep()],
      actionRequests: [action()],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'assistant_stream', 'work_group', 'assistant_message'])
    expect(visible[1]?.summary).toContain('我先拆成查询和记账两步')
    expect(visible.map((node) => node.summary).join('\n')).not.toContain('当前还不能回本，我已经准备好确认卡。\n当前还不能回本')
  })

  it('preserves the first planner preface when later repair turns stream unrelated planning text', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-preface-merge', threadId: 'thread-1', role: 'user', content: '回本、记账、股东注资', createdAt },
        { id: 'message-assistant-preface-merge', threadId: 'thread-1', role: 'assistant', content: '我已经处理完查询并准备好待确认动作。', createdAt: '2026-05-22T00:00:08.000Z' },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_delta', title: '模型输出片段', message: '我会同时处理三件事。', status: 'running', data: { kind: 'content_delta', phase: 'planning', preview: '我会同时处理三件事：查询回本、准备记账、准备股东注资。' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '工具调用片段', message: 'data_query_workspace', status: 'running', data: { kind: 'tool_call_delta', phase: 'planning', toolCallIndex: 0, toolName: 'data_query_workspace', argumentsPreview: '{"scope":"workspace_summary"}' } }),
        runEvent({ sequence: 3, type: 'provider_stream_delta', title: '模型输出片段', message: '用户给了三个任务。', status: 'running', data: { kind: 'content_delta', phase: 'planning', preview: '用户给了三个任务，但当前还缺成员名称。' } }),
      ],
      planSteps: [
        planStep({
          id: 'step-data-query-preface',
          actionRequestId: null,
          title: '查询回本周期',
          description: '当前还不能回本。',
          status: 'executed',
          toolName: 'data_query_workspace',
          toolCallId: 'call_data_query_workspace',
          toolArguments: { scope: 'workspace_summary' },
        }),
      ],
      actionRequests: [],
    }))

    const visible = nodes.filter((node) => node.visibility === 'user')
    const preface = visible.find((node) => node.kind === 'assistant_stream')

    expect(visible.map((node) => node.kind)).toEqual(['user_message', 'assistant_stream', 'work_group', 'assistant_message'])
    expect(preface?.summary).toContain('我会同时处理三件事')
    expect(preface?.summary).not.toContain('当前还缺成员名称')
  })

  it('groups multi-tool turns into a work group and a compact tool group', () => {
    const nodes = buildAgentTranscriptNodes(projectionState({
      messages: [
        { id: 'message-user-multi', threadId: 'thread-1', role: 'user', content: '查回本并打开偏差页', createdAt },
        { id: 'message-assistant-multi', threadId: 'thread-1', role: 'assistant', content: '已完成查询。', createdAt },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_delta', title: '工具调用片段', message: 'data_query_workspace', status: 'running', data: { kind: 'tool_call_delta', toolCallIndex: 0, toolName: 'data_query_workspace', argumentsPreview: '{"scope":"workspace_summary"}' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '工具调用片段', message: 'ui_navigate', status: 'running', data: { kind: 'tool_call_delta', toolCallIndex: 1, toolName: 'ui_navigate', argumentsPreview: '{"mainTab":"variance"}' } }),
        runEvent({ sequence: 3, type: 'provider_stream_completed', title: 'Provider 流已结束', message: '模型流已结束。', status: 'completed', data: { toolCallCount: 2 } }),
        runEvent({ sequence: 4, type: 'run_completed', title: '运行完成', message: '模型规划和只读回答已完成。', status: 'completed' }),
      ],
    }))

    const workGroup = nodes.find((node) => node.kind === 'work_group')
    const toolGroup = workGroup?.children?.find((node) => node.kind === 'tool_group')

    expect(workGroup).toBeTruthy()
    expect(toolGroup).toBeTruthy()
    expect(toolGroup?.children?.filter((node) => node.kind === 'tool_call')).toHaveLength(2)
    expect(toolGroup?.defaultOpen).toBe(true)
  })

  it('shows one live assistant stream row before the final assistant message exists', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-live', threadId: 'thread-1', role: 'user', content: '你好', createdAt },
      ],
      runEvents: [
        runEvent({ sequence: 1, type: 'provider_stream_delta', title: '文本片段', message: '你好', status: 'running', data: { kind: 'content_delta', preview: '你好' } }),
        runEvent({ sequence: 2, type: 'provider_stream_delta', title: '文本片段', message: '你好，我是 Agent', status: 'running', data: { kind: 'content_delta', preview: '你好，我是 Agent' } }),
      ],
    }))

    const visible = timeline.filter((item) => item.visibility === 'user')
    const streamRows = visible.filter((item) => item.kind === 'assistant_stream')

    expect(streamRows).toHaveLength(1)
    expect(streamRows[0]?.content).toContain('我是 Agent')
  })

  it('marks read-only provider tool calls completed after the run finishes', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-payback', threadId: 'thread-1', role: 'user', content: '我现在几个月回本', createdAt },
        { id: 'message-assistant-payback', threadId: 'thread-1', role: 'assistant', content: '当前按资金回报率计算还未回本。', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'data_query_workspace',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 0,
            toolName: 'data_query_workspace',
            argumentsPreview: '{"scope":"workspace_summary","metrics":["payback"]}',
          },
        }),
        runEvent({
          sequence: 2,
          type: 'provider_stream_completed',
          title: 'Provider 流已结束',
          message: '模型流已结束。',
          status: 'completed',
          data: { toolCallCount: 1 },
        }),
        runEvent({
          sequence: 3,
          type: 'tool_plan_ready',
          title: '模型回复已生成',
          message: '模型规划生成 1 个步骤。',
          status: 'completed',
          data: { stepCount: 1, pendingActionCount: 0, executedActionCount: 0 },
        }),
        runEvent({
          sequence: 4,
          type: 'run_completed',
          title: '运行完成',
          message: '模型规划和只读回答已完成。',
          status: 'completed',
        }),
      ],
      planSteps: [
        planStep({
          id: 'step-read',
          actionRequestId: null,
          title: '查询回本周期',
          description: '已读取当前工作区测算结果。',
          status: 'executed',
        }),
      ],
      actionRequests: [],
    }))

    const toolCall = timeline.find((item) => item.kind === 'tool_call' && item.toolName === 'data_query_workspace')
    expect(toolCall).toMatchObject({
      status: 'completed',
      visibility: 'user',
    })
  })

  it('keeps provider tool calls running while the provider stream is still open', () => {
    const timeline = buildAgentTimelineItems(projectionState({
      messages: [
        { id: 'message-user-live-tool', threadId: 'thread-1', role: 'user', content: '查一下回本', createdAt },
      ],
      runEvents: [
        runEvent({
          sequence: 1,
          type: 'provider_stream_delta',
          title: '工具调用片段',
          message: 'data_query_workspace',
          status: 'running',
          data: {
            kind: 'tool_call_delta',
            toolCallIndex: 0,
            toolName: 'data_query_workspace',
            argumentsPreview: '{"scope":"workspace_summary"}',
          },
        }),
      ],
      planSteps: [],
      actionRequests: [],
    }))

    const toolCall = timeline.find((item) => item.kind === 'tool_call' && item.toolName === 'data_query_workspace')
    expect(toolCall?.status).toBe('running')
  })
})
