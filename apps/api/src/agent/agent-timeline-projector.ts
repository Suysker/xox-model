import type {
  AgentActionRequest,
  AgentMessage,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTranscriptItem,
} from '@xox/contracts'
import type { AgentProjectionState } from './ag-ui-projection.js'
import { buildAgentTranscriptItems } from './agent-transcript-projector.js'

type PendingTimelineItem = AgentTimelineItem & { order: number }

function timeOrder(createdAt: string, fallback = 0, rank = 0) {
  const millis = Date.parse(createdAt)
  const safeMillis = Number.isFinite(millis) ? millis : 0
  return safeMillis * 1000 + fallback * 10 + rank
}

function transcriptOrder(state: AgentProjectionState, item: AgentTranscriptItem) {
  const firstRunEventTime = state.runEvents[0]?.createdAt
  if (firstRunEventTime) return timeOrder(firstRunEventTime, item.sequence, 4)
  return timeOrder(item.createdAt, item.sequence, 4)
}

function latestRunId(state: AgentProjectionState) {
  return state.runEvents[0]?.runId ?? state.planSteps[0]?.runId ?? state.actionRequests[0]?.runId ?? state.goals[0]?.runId ?? null
}

function messageTitle(message: AgentMessage) {
  if (message.role === 'user') return '你'
  if (message.role === 'assistant') return 'Agent'
  return '系统'
}

function messageKind(message: AgentMessage): AgentTimelineItemKind {
  if (message.role === 'user') return 'user_message'
  if (message.role === 'assistant') return 'assistant_message'
  return 'technical'
}

function messageToTimelineItem(message: AgentMessage, runId: string | null, index: number): PendingTimelineItem {
  return {
    id: `message-${message.id}`,
    threadId: message.threadId,
    runId,
    sequence: index + 1,
    kind: messageKind(message),
    title: messageTitle(message),
    summary: message.content,
    content: message.content,
    status: 'completed',
    visibility: message.role === 'system' ? 'technical' : 'user',
    sourceType: 'agent_message',
    createdAt: message.createdAt,
    order: timeOrder(message.createdAt, index + 1, message.role === 'user' ? 0 : 9),
  }
}

function transcriptKind(item: AgentTranscriptItem): AgentTimelineItemKind {
  if (item.kind === 'message') return 'assistant_stream'
  if (item.kind === 'tool_call') return 'tool_call'
  if (item.kind === 'tool_result') return 'tool_result'
  if (item.kind === 'navigation') return 'navigation'
  if (item.kind === 'confirmation') return 'confirmation'
  if (item.kind === 'action_update') return 'action_edit'
  if (item.kind === 'memory') return 'memory'
  if (item.kind === 'evaluation') return 'evaluation'
  if (item.kind === 'technical') return 'technical'
  return item.visibility === 'technical' ? 'technical' : 'summary'
}

function timelineItemFromTranscript(
  state: AgentProjectionState,
  item: AgentTranscriptItem,
  action: AgentActionRequest | null,
  visibility: AgentTimelineItem['visibility'],
): PendingTimelineItem {
  const kind = action && item.kind === 'confirmation' ? 'tool_call' : transcriptKind(item)
  return {
    id: `timeline-${item.id}`,
    threadId: item.threadId,
    runId: item.runId || latestRunId(state),
    sequence: item.sequence,
    kind,
    title: kind === 'tool_call' && action ? `调用工具：${action.kind}` : item.title,
    summary: item.summary,
    ...(kind === 'assistant_stream' ? { content: item.summary } : {}),
    status: item.status,
    visibility,
    ...(item.sourceType ? { sourceType: item.sourceType } : {}),
    ...(item.agUiEventType ? { agUiEventType: item.agUiEventType } : {}),
    ...((action?.kind ?? item.toolName) ? { toolName: action?.kind ?? item.toolName } : {}),
    ...(item.actionRequestId ? { actionRequestId: item.actionRequestId } : {}),
    ...(action ? { actionRequest: action } : {}),
    ...(item.navigation ? { navigation: item.navigation } : {}),
    ...(item.details ? { details: item.details } : {}),
    ...(item.payload ? { payload: item.payload } : {}),
    createdAt: item.createdAt,
    order: transcriptOrder(state, item),
  }
}

function hasFinalAssistantMessageForRun(state: AgentProjectionState) {
  const firstRunEventTime = state.runEvents[0]?.createdAt
  if (!firstRunEventTime) return state.messages.some((message) => message.role === 'assistant')
  const firstRunEventMillis = Date.parse(firstRunEventTime)
  return state.messages.some((message) => {
    if (message.role !== 'assistant') return false
    const messageMillis = Date.parse(message.createdAt)
    return Number.isFinite(messageMillis) && Number.isFinite(firstRunEventMillis)
      ? messageMillis >= firstRunEventMillis
      : true
  })
}

function shouldDropTranscriptItem(item: AgentTranscriptItem, state: AgentProjectionState) {
  return item.kind === 'message' && hasFinalAssistantMessageForRun(state)
}

function transcriptTimelineVisibility(item: AgentTranscriptItem, action: AgentActionRequest | null): AgentTimelineItem['visibility'] {
  if (item.visibility === 'technical') return 'technical'
  if (action) return 'user'
  if (item.kind === 'message') return 'user'
  if (item.kind === 'error') return 'user'
  if (item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'navigation' || item.kind === 'confirmation' || item.kind === 'action_update') {
    return 'user'
  }
  if (item.kind === 'evaluation' && (item.status === 'failed' || item.status === 'waiting')) return 'user'
  return 'technical'
}

function actionKind(status: AgentActionRequest['status']): AgentTimelineItemKind {
  if (status === 'pending') return 'confirmation'
  if (status === 'executed' || status === 'confirmed') return 'tool_result'
  return 'action_edit'
}

function actionStatus(status: AgentActionRequest['status']): AgentTimelineItem['status'] {
  if (status === 'pending') return 'waiting'
  if (status === 'executed' || status === 'confirmed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'info'
}

function actionToTimelineItem(action: AgentActionRequest, index: number): PendingTimelineItem {
  return {
    id: `timeline-action-${action.id}`,
    threadId: action.threadId,
    runId: action.runId,
    sequence: index + 1,
    kind: actionKind(action.status),
    title: action.title,
    summary: action.summary,
    status: actionStatus(action.status),
    visibility: 'user',
    sourceType: 'agent_action_request',
    toolName: action.kind,
    actionRequestId: action.id,
    actionRequest: action,
    navigation: action.navigation,
    details: action.details,
    payload: {
      riskLevel: action.riskLevel,
      targetLabel: action.targetLabel,
      errorMessage: action.errorMessage,
    },
    createdAt: action.executedAt ?? action.createdAt,
    order: timeOrder(action.executedAt ?? action.createdAt, index + 1, 6),
  }
}

function toolCallKey(item: PendingTimelineItem) {
  if (item.kind !== 'tool_call') return null
  const payloadIndex = typeof item.payload?.toolCallIndex === 'number' ? item.payload.toolCallIndex : null
  return `${item.runId ?? 'run'}:${item.toolCallId ?? item.toolName ?? 'tool'}:${payloadIndex ?? ''}`
}

function assistantStreamKey(item: PendingTimelineItem) {
  if (item.kind !== 'assistant_stream') return null
  return `${item.runId ?? item.threadId}:assistant_stream`
}

function shouldHideGenericConfirmation(item: AgentTranscriptItem, state: AgentProjectionState) {
  return item.sourceType === 'confirmation_ready' && state.actionRequests.some((action) => action.status === 'pending')
}

function mergeTimelineItems(items: PendingTimelineItem[]) {
  const merged: PendingTimelineItem[] = []
  const toolIndexByKey = new Map<string, number>()
  const assistantStreamIndexByKey = new Map<string, number>()
  const actionIds = new Set<string>()

  for (const item of items) {
    const streamKey = assistantStreamKey(item)
    if (streamKey) {
      const existingIndex = assistantStreamIndexByKey.get(streamKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary: item.summary || existing.summary,
            status: item.status,
            ...((item.content || existing.content) ? { content: item.content || existing.content } : {}),
            ...(item.payload ? { payload: item.payload } : {}),
            order: Math.min(existing.order, item.order),
          }
        }
        continue
      }
      assistantStreamIndexByKey.set(streamKey, merged.length)
    }

    const toolKey = toolCallKey(item)
    if (toolKey) {
      const existingIndex = toolIndexByKey.get(toolKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary: item.summary || existing.summary,
            status: item.status,
            ...(item.payload ? { payload: item.payload } : {}),
            ...(item.details ? { details: item.details } : {}),
            order: Math.min(existing.order, item.order),
          }
        }
        continue
      }
      toolIndexByKey.set(toolKey, merged.length)
    }

    if (item.actionRequestId && item.kind !== 'action_edit') {
      const dedupeKey = `${item.actionRequestId}:${item.kind}`
      if (actionIds.has(dedupeKey)) continue
      actionIds.add(dedupeKey)
    }

    merged.push(item)
  }

  return merged
}

export function buildAgentTimelineItems(state: AgentProjectionState): AgentTimelineItem[] {
  const actionsById = new Map(state.actionRequests.map((action) => [action.id, action]))
  const transcriptItems = buildAgentTranscriptItems(state)
  const representedActionIds = new Set<string>()
  const runId = latestRunId(state)

  const items: PendingTimelineItem[] = [
    ...state.messages.map((message, index) => messageToTimelineItem(message, runId, index)),
  ]

  for (const item of transcriptItems) {
    if (shouldHideGenericConfirmation(item, state)) continue
    if (shouldDropTranscriptItem(item, state)) continue
    const action = item.actionRequestId ? actionsById.get(item.actionRequestId) ?? null : null
    if (action) representedActionIds.add(action.id)
    items.push(timelineItemFromTranscript(state, item, action, transcriptTimelineVisibility(item, action)))
  }

  state.actionRequests.forEach((action, index) => {
    if (!representedActionIds.has(action.id)) items.push(actionToTimelineItem(action, index))
  })

  return mergeTimelineItems(items)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(({ order: _order, ...item }, index) => ({ ...item, sequence: index + 1 }))
}
