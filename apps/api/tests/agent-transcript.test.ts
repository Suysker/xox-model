import { describe, expect, it } from 'vitest'
import type { AgentActionRequest, AgentMessage, AgentNavigationEvent, AgentPlanStep, AgentRunEvent } from '@xox/contracts'
import { buildAgentAgUiEvents } from '../src/agent/ag-ui-projection.js'
import { buildAgentTranscriptItems } from '../src/agent/agent-transcript-projector.js'
import { buildAgentTimelineItems } from '../src/agent/agent-timeline-projector.js'
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
