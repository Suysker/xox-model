import type {
  AgentActionRequest,
  AgentEvaluationResult,
  AgentNavigationEvent,
  AgentPlanStep,
  AgentRunEvent,
  AgentTranscriptItem,
  AgentTranscriptItemKind,
  AgentTranscriptItemStatus,
} from '@xox/contracts'
import type { AgentProjectionState } from './ag-ui-projection.js'

type PendingTranscriptItem = AgentTranscriptItem & { order: number }

const INTERNAL_RUN_EVENT_TYPES = new Set([
  'worker_claimed',
  'goal_iteration_started',
  'tool_catalog_ready',
  'confirmation_ready',
  'provider_stable_long_tool_mode',
  'provider_retrying',
  'provider_tool_call_repaired',
])

const INTERNAL_LABEL_PATTERNS = [
  /Run 已入队/i,
  /Worker 已认领/i,
  /run lease/i,
  /lease guard/i,
  /目标契约已建立/i,
  /目标循环\s*\d+/i,
  /Completion Evaluator 已运行/i,
  /后台 worker/i,
]

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function eventOrder(createdAt: string, fallback: number, rank = 0) {
  const millis = Date.parse(createdAt)
  const safeMillis = Number.isFinite(millis) ? millis : 0
  return safeMillis * 1000 + fallback * 10 + rank
}

function visibilityForRunEvent(event: AgentRunEvent): 'user' | 'technical' {
  if (INTERNAL_RUN_EVENT_TYPES.has(event.type)) return 'technical'
  const text = `${event.title}\n${event.message}`
  return INTERNAL_LABEL_PATTERNS.some((pattern) => pattern.test(text)) ? 'technical' : 'user'
}

function transcriptStatus(status: AgentRunEvent['status']): AgentTranscriptItemStatus {
  if (status === 'queued') return 'pending'
  if (status === 'blocked') return 'waiting'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'running') return 'running'
  return 'info'
}

function actionStatus(status: AgentActionRequest['status']): AgentTranscriptItemStatus {
  if (status === 'pending') return 'waiting'
  if (status === 'executed' || status === 'confirmed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'info'
}

function planStatus(status: AgentPlanStep['status'], action?: AgentActionRequest | null): AgentTranscriptItemStatus {
  if (action) return actionStatus(action.status)
  if (status === 'ready' || status === 'pending') return status === 'ready' ? 'waiting' : 'running'
  if (status === 'executed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'info'
}

function technicalItem(event: AgentRunEvent): PendingTranscriptItem {
  return {
    id: `technical-${event.id}`,
    threadId: event.threadId,
    runId: event.runId,
    sequence: event.sequence,
    kind: 'technical',
    title: event.title,
    summary: event.message,
    status: transcriptStatus(event.status),
    visibility: 'technical',
    sourceType: event.type,
    agUiEventType: 'CUSTOM',
    payload: event.data,
    createdAt: event.createdAt,
    order: eventOrder(event.createdAt, event.sequence, 9),
  }
}

function memorySummary(event: AgentRunEvent) {
  const count = asNumber(event.data?.memoryCount)
  const ids = asStringArray(event.data?.memoryIds)
  const idSummary = ids.length > 0 ? `，记忆 ${ids.map((id) => id.slice(0, 8)).join(', ')}` : ''
  if (event.type === 'memory_recall_started') return '正在查找与本次任务相关的工作区记忆。'
  if (event.type === 'memory_recall_completed') {
    if (count && count > 0) return `找到 ${count} 条相关记忆${idSummary}。`
    return '本次没有找到需要注入的相关记忆。'
  }
  if (event.type === 'memory_injected') return `已把 ${count ?? ids.length} 条相关记忆作为参考上下文${idSummary}。`
  if (event.type === 'memory_promoted') return `有 ${count ?? ids.length} 条记忆因重复有效使用被提升。`
  return event.message
}

function evaluationSummary(event: AgentRunEvent) {
  const status = asString(event.data?.evaluationStatus)
  const unsatisfiedCount = asNumber(event.data?.unsatisfiedCount)
  if (status === 'pass') return '检查结果：本轮目标已经满足。'
  if (status === 'needs_confirmation') return '检查结果：已准备好待确认动作，需要你先处理确认卡。'
  if (status === 'continue') return `检查结果：还缺 ${unsatisfiedCount ?? 1} 个步骤，正在继续完善。`
  if (status === 'blocked' || status === 'failed') return `检查结果：当前目标无法继续，原因是 ${event.message.replace(/^Completion Evaluator[^：]*：?/, '').trim() || '存在失败步骤'}`
  return '检查结果：需要补充信息或等待下一步。'
}

function providerStreamItem(event: AgentRunEvent): PendingTranscriptItem | null {
  const kind = asString(event.data?.kind)
  if (event.type === 'provider_stream_started') {
    return {
      id: `transcript-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'planning',
      title: '正在规划下一步',
      summary: '模型正在根据当前页面、记忆和可用工具准备下一步动作。',
      status: 'running',
      visibility: 'technical',
      sourceType: event.type,
      agUiEventType: 'STEP_STARTED',
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence),
    }
  }
  if (event.type === 'provider_stream_completed') {
    const toolCallCount = asNumber(event.data?.toolCallCount)
    return {
      id: `transcript-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'planning',
      title: toolCallCount && toolCallCount > 0 ? '工具选择已完成' : '模型回复已完成',
      summary: toolCallCount && toolCallCount > 0 ? `模型已选择 ${toolCallCount} 个工具调用，正在生成业务步骤。` : '模型已完成本轮回复。',
      status: 'completed',
      visibility: 'technical',
      sourceType: event.type,
      agUiEventType: 'STEP_FINISHED',
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence),
    }
  }
  if (event.type !== 'provider_stream_delta') return null

  if (kind === 'content_delta') {
    const summary = asString(event.data?.preview) || asString(event.data?.delta) || event.message
    return {
      id: `transcript-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'message',
      title: '模型实时输出',
      summary,
      status: 'running',
      visibility: 'user',
      sourceType: event.type,
      agUiEventType: 'TEXT_MESSAGE_CONTENT',
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence),
    }
  }

  if (kind === 'tool_call_delta') {
    const toolName = asString(event.data?.toolName) || '工具调用'
    const summary = asString(event.data?.argumentsPreview) || asString(event.data?.argumentsDelta) || '正在组装工具参数。'
    return {
      id: `transcript-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'tool_call',
      title: `调用工具：${toolName}`,
      summary,
      status: 'running',
      visibility: 'user',
      sourceType: event.type,
      agUiEventType: 'TOOL_CALL_ARGS',
      toolName,
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence),
    }
  }

  return null
}

function runEventToTranscriptItem(event: AgentRunEvent): PendingTranscriptItem | null {
  const streamItem = providerStreamItem(event)
  if (streamItem) return streamItem
  if (visibilityForRunEvent(event) === 'technical') return technicalItem(event)

  let kind: AgentTranscriptItemKind = 'status'
  let title = event.title
  let summary = event.message
  let status = transcriptStatus(event.status)
  let agUiEventType: AgentTranscriptItem['agUiEventType'] = 'CUSTOM'
  let toolName: string | null = null
  let actionRequestId: string | null = null

  if (event.type === 'run_queued') {
    title = '正在理解你的目标'
    summary = '已收到你的指令，正在准备执行流程。'
    status = 'running'
    agUiEventType = 'RUN_STARTED'
  } else if (event.type === 'goal_contract_created') {
    kind = 'planning'
    title = '已拆解业务目标'
    summary = '已把你的指令转成可检查的业务目标，后续会逐步规划、确认和执行。'
  } else if (event.type === 'model_planning') {
    kind = 'planning'
    title = '正在规划下一步'
    summary = '正在结合当前工作区数据和可用工具，准备下一步可见动作。'
    status = 'running'
    agUiEventType = 'STEP_STARTED'
  } else if (event.type === 'tool_plan_ready') {
    const stepCount = asNumber(event.data?.stepCount)
    const pendingActionCount = asNumber(event.data?.pendingActionCount)
    kind = 'planning'
    title = '业务步骤已生成'
    summary = `已生成 ${stepCount ?? 0} 个步骤，其中 ${pendingActionCount ?? 0} 个需要确认。`
    status = pendingActionCount && pendingActionCount > 0 ? 'waiting' : transcriptStatus(event.status)
    agUiEventType = 'STEP_FINISHED'
  } else if (event.type === 'confirmation_ready') {
    kind = 'confirmation'
    title = '需要你确认动作'
    summary = event.message.replace('确认卡', '动作卡')
    status = 'waiting'
  } else if (event.type === 'action_updated') {
    kind = 'action_update'
    title = '已按你的编辑更新确认卡'
    summary = event.message
    actionRequestId = asString(event.data?.actionRequestId) || null
  } else if (event.type === 'action_executed') {
    kind = 'tool_result'
    title = '已执行动作'
    summary = event.message
    status = 'completed'
    agUiEventType = 'TOOL_CALL_RESULT'
    toolName = asString(event.data?.actionKind) || null
    actionRequestId = asString(event.data?.actionRequestId) || null
  } else if (event.type === 'action_execution_failed') {
    kind = 'error'
    title = '动作执行失败'
    summary = event.message
    status = 'failed'
    toolName = asString(event.data?.actionKind) || null
    actionRequestId = asString(event.data?.actionRequestId) || null
  } else if (event.type === 'action_cancelled') {
    kind = 'action_update'
    title = '已取消动作'
    summary = event.message
    status = 'cancelled'
    actionRequestId = asString(event.data?.actionRequestId) || null
  } else if (event.type === 'goal_evaluated') {
    kind = 'evaluation'
    title = '检查执行结果'
    summary = evaluationSummary(event)
    status = transcriptStatus(event.status)
  } else if (event.type.startsWith('memory_')) {
    kind = 'memory'
    title = event.type === 'memory_injected' ? '已使用相关记忆' : event.type === 'memory_promoted' ? '记忆已更新' : '正在查找相关记忆'
    summary = memorySummary(event)
    status = transcriptStatus(event.status)
  } else if (event.type === 'run_completed') {
    title = '本轮运行完成'
    summary = 'Agent 已完成本轮可执行步骤和检查。'
    status = 'completed'
    agUiEventType = 'RUN_FINISHED'
  } else if (event.type === 'run_failed') {
    kind = 'error'
    title = '本轮运行失败'
    summary = event.message
    status = 'failed'
    agUiEventType = 'RUN_ERROR'
  } else if (event.type === 'run_cancelled') {
    title = '本轮运行已取消'
    summary = event.message
    status = 'cancelled'
    agUiEventType = 'RUN_FINISHED'
  }

  const changes = Array.isArray(event.data?.changes) ? event.data.changes as Array<{ label: string; value: string }> : null
  return {
    id: `transcript-${event.id}`,
    threadId: event.threadId,
    runId: event.runId,
    sequence: event.sequence,
    kind,
    title,
    summary,
    status,
    visibility: 'user',
    sourceType: event.type,
    agUiEventType,
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(changes ? { details: changes } : {}),
    payload: event.data,
    createdAt: event.createdAt,
    order: eventOrder(event.createdAt, event.sequence),
  }
}

function userFacingInternalRunItem(event: AgentRunEvent): PendingTranscriptItem | null {
  if (event.type === 'run_queued') {
    return {
      id: `transcript-user-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'status',
      title: '正在理解你的目标',
      summary: '已收到你的指令，正在准备执行流程。',
      status: 'running',
      visibility: 'user',
      sourceType: event.type,
      agUiEventType: 'RUN_STARTED',
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence, 1),
    }
  }
  if (event.type === 'goal_contract_created') {
    return {
      id: `transcript-user-${event.id}`,
      threadId: event.threadId,
      runId: event.runId,
      sequence: event.sequence,
      kind: 'planning',
      title: '已拆解业务目标',
      summary: '已把你的指令转成可检查的业务目标，后续会逐步规划、确认和执行。',
      status: 'info',
      visibility: 'user',
      sourceType: event.type,
      agUiEventType: 'CUSTOM',
      payload: event.data,
      createdAt: event.createdAt,
      order: eventOrder(event.createdAt, event.sequence, 1),
    }
  }
  return null
}

function navigationTitle(navigation: AgentNavigationEvent | null | undefined) {
  if (!navigation) return '打开对应页面'
  const tab = navigation.route.mainTab === 'bookkeeping'
    ? '记实际'
    : navigation.route.mainTab === 'inputs'
      ? '调模型'
      : navigation.route.mainTab === 'variance'
        ? '看偏差'
        : '看测算'
  return `已打开：${tab}`
}

function planStepToTranscriptItem(step: AgentPlanStep, action: AgentActionRequest | null, index: number): PendingTranscriptItem {
  const status = planStatus(step.status, action)
  const toolName = action?.kind ?? step.toolName ?? null
  const payload = step.toolArguments
    ? { toolArguments: step.toolArguments, planStepSequence: step.sequence }
    : { planStepSequence: step.sequence }
  return {
    id: `plan-${step.id}`,
    threadId: step.threadId,
    runId: step.runId,
    sequence: index + 1,
    kind: action ? action.status === 'pending' ? 'confirmation' : action.status === 'executed' ? 'tool_result' : 'action_update' : 'planning',
    title: action ? action.title : step.title,
    summary: action ? action.summary : step.description,
    status,
    visibility: 'user',
    sourceType: 'plan_step',
    agUiEventType: status === 'completed' ? 'STEP_FINISHED' : 'STEP_STARTED',
    ...((action?.id ?? step.actionRequestId) ? { actionRequestId: action?.id ?? step.actionRequestId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(step.toolCallId ? { toolCallId: step.toolCallId } : {}),
    ...((action?.navigation ?? step.navigation) ? { navigation: action?.navigation ?? step.navigation } : {}),
    ...(action?.details ? { details: action.details } : {}),
    payload: action ? { ...payload, riskLevel: action.riskLevel, targetLabel: action.targetLabel } : payload,
    createdAt: step.createdAt,
    order: eventOrder(step.createdAt, index + 1, 3),
  }
}

function navigationToTranscriptItem(navigation: AgentNavigationEvent, runId: string, index: number): PendingTranscriptItem {
  return {
    id: `navigation-${runId}-${index}`,
    threadId: '',
    runId,
    sequence: index + 1,
    kind: 'navigation',
    title: navigationTitle(navigation),
    summary: navigation.reason,
    status: 'completed',
    visibility: 'user',
    sourceType: 'navigation',
    agUiEventType: 'CUSTOM',
    navigation,
    payload: null,
    createdAt: new Date(0).toISOString(),
    order: Number.MAX_SAFE_INTEGER - 1000 + index,
  }
}

export function buildAgentTranscriptItems(state: AgentProjectionState): AgentTranscriptItem[] {
  const actionsById = new Map(state.actionRequests.map((action) => [action.id, action]))
  const latestRunId = state.runEvents[0]?.runId ?? state.planSteps[0]?.runId ?? state.actionRequests[0]?.runId ?? state.goals[0]?.runId ?? ''
  const threadId = state.thread.id
  const items: PendingTranscriptItem[] = [
    ...state.runEvents.flatMap((event) => [runEventToTranscriptItem(event), userFacingInternalRunItem(event)].filter((item): item is PendingTranscriptItem => Boolean(item))),
    ...state.planSteps.map((step, index) => planStepToTranscriptItem(step, step.actionRequestId ? actionsById.get(step.actionRequestId) ?? null : null, index)),
    ...state.navigationEvents.map((navigation, index) => ({
      ...navigationToTranscriptItem(navigation, latestRunId, index),
      id: `navigation-${threadId}-${latestRunId}-${index}`,
      threadId,
    })),
  ]

  return items
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(({ order: _order, details, payload, navigation, ...item }, index) => ({
      ...item,
      sequence: index + 1,
      ...(details ? { details } : {}),
      ...(payload ? { payload } : {}),
      ...(navigation ? { navigation } : {}),
    }))
}
