import type {
  AgentActionRequest,
  AgentAgUiEvent,
  AgentAgUiEventType,
  AgentEvaluationResult,
  AgentGoalRecord,
  AgentMessage,
  AgentNavigationEvent,
  AgentPlanStep,
  AgentRunEvent,
} from '@xox/contracts'

export type AgentProjectionState = {
  thread: { id: string }
  messages: AgentMessage[]
  goals: AgentGoalRecord[]
  evaluations: AgentEvaluationResult[]
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentRunEvent[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
}

type PendingAgUiEvent = AgentAgUiEvent & { order: number }

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function eventOrder(createdAt: string, fallback: number, rank = 0) {
  const millis = Date.parse(createdAt)
  const safeMillis = Number.isFinite(millis) ? millis : 0
  return safeMillis * 1000 + fallback * 10 + rank
}

function customEventName(event: AgentRunEvent) {
  if (event.type === 'run_queued' || event.type === 'worker_claimed') return 'xox.internal_run_lifecycle'
  if (event.type === 'goal_contract_created') return 'xox.goal_contract'
  if (event.type === 'goal_iteration_started') return 'xox.internal_goal_loop'
  if (event.type === 'model_planning') return 'xox.model_planning'
  if (event.type === 'tool_catalog_ready') return 'xox.tool_catalog_ready'
  if (event.type === 'tool_plan_ready') return 'xox.plan_step'
  if (event.type === 'confirmation_ready') return 'xox.interrupt.confirmation_card'
  if (event.type === 'action_updated') return 'xox.confirmation_edited'
  if (event.type === 'action_cancelled') return 'xox.action_cancelled'
  if (event.type === 'action_execution_failed' || event.type === 'action_auto_execution_failed') return 'xox.action_failed'
  if (event.type === 'goal_evaluated') return 'xox.evaluation_result'
  if (event.type.startsWith('memory_')) return `xox.${event.type}`
  if (event.type === 'provider_tool_call_repaired') return 'xox.tool_call_repaired'
  if (event.type === 'provider_retrying') return 'xox.provider_retrying'
  if (event.type === 'provider_stable_long_tool_mode') return 'xox.provider_stable_long_tool_mode'
  return `xox.${event.type}`
}

function eventTypeForRunEvent(event: AgentRunEvent): AgentAgUiEventType {
  if (event.type === 'run_queued') return 'RUN_STARTED'
  if (event.type === 'run_failed') return 'RUN_ERROR'
  if (event.type === 'run_completed' || event.type === 'run_cancelled') return 'RUN_FINISHED'
  if (event.type === 'model_planning' || event.type === 'provider_stream_started') return 'STEP_STARTED'
  if (event.type === 'provider_stream_completed') return 'STEP_FINISHED'
  if (event.type === 'action_executed' || event.type === 'action_auto_executed') return 'TOOL_CALL_RESULT'
  return 'CUSTOM'
}

function toolCallId(event: AgentRunEvent) {
  const explicit = asString(event.data?.toolCallId)
  const index = asNumber(event.data?.toolCallIndex)
  if (explicit) return explicit
  if (index !== null) return `tool-call-${index}`
  return undefined
}

function streamEvents(event: AgentRunEvent): PendingAgUiEvent[] {
  const kind = asString(event.data?.kind)
  const base = {
    id: event.id,
    threadId: event.threadId,
    runId: event.runId,
    status: event.status,
    createdAt: event.createdAt,
    payload: event.data,
  }

  if (kind === 'content_delta') {
    const delta = asString(event.data?.delta)
    const content = asString(event.data?.preview) || delta
    return [{
      ...base,
      sequence: event.sequence,
      type: 'TEXT_MESSAGE_CONTENT',
      title: 'Assistant text delta',
      role: 'assistant',
      delta,
      content,
      order: eventOrder(event.createdAt, event.sequence),
    }]
  }

  if (kind === 'tool_call_delta') {
    const name = asString(event.data?.toolName)
    const id = toolCallId(event)
    const argsPreview = asString(event.data?.argumentsPreview)
    const argsDelta = asString(event.data?.argumentsDelta)
    return [{
      ...base,
      sequence: event.sequence,
      type: 'TOOL_CALL_ARGS',
      title: 'Tool call arguments',
      ...(id ? { toolCallId: id } : {}),
      ...(name ? { toolName: name } : {}),
      delta: argsDelta,
      content: argsPreview || argsDelta,
      order: eventOrder(event.createdAt, event.sequence),
    }]
  }

  return [{
    ...base,
    sequence: event.sequence,
    type: eventTypeForRunEvent(event),
    name: customEventName(event),
    title: event.title,
    content: event.message,
    order: eventOrder(event.createdAt, event.sequence),
  }]
}

function runEventToAgUiEvents(event: AgentRunEvent): PendingAgUiEvent[] {
  if (event.type === 'provider_stream_delta') return streamEvents(event)
  const base = {
    id: event.id,
    threadId: event.threadId,
    runId: event.runId,
    sequence: event.sequence,
    status: event.status,
    payload: event.data,
    createdAt: event.createdAt,
    order: eventOrder(event.createdAt, event.sequence),
  }
  if (event.type === 'provider_stream_started') {
    return [{
      ...base,
      type: 'STEP_STARTED',
      name: 'xox.provider_stream_started',
      title: 'Provider stream started',
      content: event.message,
    }]
  }
  if (event.type === 'provider_stream_completed') {
    return [{
      ...base,
      type: 'STEP_FINISHED',
      name: 'xox.provider_stream_completed',
      title: 'Provider stream completed',
      content: event.message,
    }]
  }
  if (event.type === 'action_executed' || event.type === 'action_auto_executed') {
    const actionKind = asString(event.data?.actionKind)
    return [{
      ...base,
      type: 'TOOL_CALL_RESULT',
      name: 'xox.action_executed',
      title: event.title,
      content: event.message,
      ...(actionKind ? { toolName: actionKind } : {}),
    }]
  }
  return [{
    ...base,
    type: eventTypeForRunEvent(event),
    name: customEventName(event),
    title: event.title,
    content: event.message,
  }]
}

function planStepToAgUiEvent(step: AgentPlanStep, index: number): PendingAgUiEvent {
  return {
    id: step.id,
    threadId: step.threadId,
    runId: step.runId,
    sequence: index + 1,
    type: step.status === 'ready' || step.status === 'pending' ? 'STEP_STARTED' : 'STEP_FINISHED',
    name: 'xox.plan_step',
    title: step.title,
    content: step.description,
    status: step.status,
    payload: {
      actionRequestId: step.actionRequestId,
      navigation: step.navigation,
    },
    createdAt: step.createdAt,
    order: eventOrder(step.createdAt, index + 1, 4),
  }
}

function actionToAgUiEvent(action: AgentActionRequest, index: number): PendingAgUiEvent {
  const isPending = action.status === 'pending'
  return {
    id: action.id,
    threadId: action.threadId,
    runId: action.runId,
    sequence: index + 1,
    type: isPending ? 'CUSTOM' : action.status === 'executed' ? 'TOOL_CALL_RESULT' : 'CUSTOM',
    name: isPending ? 'xox.interrupt.confirmation_card' : `xox.action_${action.status}`,
    title: action.title,
    content: action.summary,
    status: action.status,
    toolName: action.kind,
    payload: {
      actionRequestId: action.id,
      kind: action.kind,
      riskLevel: action.riskLevel,
      targetLabel: action.targetLabel,
      details: action.details,
      navigation: action.navigation,
    },
    createdAt: action.executedAt ?? action.createdAt,
    order: eventOrder(action.executedAt ?? action.createdAt, index + 1, 5),
  }
}

export function buildAgentAgUiEvents(state: AgentProjectionState): AgentAgUiEvent[] {
  const events: PendingAgUiEvent[] = [
    ...state.runEvents.flatMap(runEventToAgUiEvents),
    ...state.planSteps.map(planStepToAgUiEvent),
    ...state.actionRequests.map(actionToAgUiEvent),
  ]

  return events
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(({ order: _order, ...event }, index) => ({ ...event, sequence: index + 1 }))
}
