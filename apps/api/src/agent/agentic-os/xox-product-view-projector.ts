import type { AgentTranscriptItem as OsTranscriptItem } from '@agentic-os/contracts'
import { parseBoundedAgentJson } from '@agentic-os/core'

export type XoxProductMessageRole = 'user' | 'assistant' | 'system'
export type XoxProductTranscriptVisibility = 'user' | 'technical'
export type XoxProductTranscriptItemKind =
  | 'message'
  | 'model_turn'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_update'
  | 'evaluation'
  | 'memory'
  | 'status'
  | 'error'
  | 'technical'

export type XoxProductTranscriptStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'info'

export type XoxProductTimelineItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_stream'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_edit'
  | 'memory'
  | 'evaluation'
  | 'summary'
  | 'technical'

export type XoxProductTranscriptNodeKind =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_stream'
  | 'work_group'
  | 'tool_group'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_update'
  | 'memory'
  | 'evaluation'
  | 'summary'
  | 'technical_group'
  | 'technical'

export interface XoxProductTranscriptItem<TNavigation = unknown> {
  id: string
  threadId: string
  runId: string
  sequence: number
  kind: XoxProductTranscriptItemKind
  title: string
  summary: string
  status: XoxProductTranscriptStatus
  visibility: XoxProductTranscriptVisibility
  sourceType?: string
  agUiEventType?: string
  actionRequestId?: string | null
  toolCallId?: string | null
  toolName?: string | null
  navigation?: TNavigation | null
  details?: Array<{ label: string; value: string }>
  payload?: Record<string, unknown> | null
  createdAt: string
}
export interface XoxProductTimelineItem<TAction = unknown, TNavigation = unknown> {
  id: string
  threadId: string
  runId: string | null
  sequence: number
  kind: XoxProductTimelineItemKind
  title: string
  summary: string
  content?: string
  status: XoxProductTranscriptStatus
  visibility: XoxProductTranscriptVisibility
  sourceType?: string
  agUiEventType?: string
  toolCallId?: string | null
  toolName?: string | null
  actionRequestId?: string | null
  actionRequest?: TAction | null
  navigation?: TNavigation | null
  details?: Array<{ label: string; value: string }>
  payload?: Record<string, unknown> | null
  createdAt: string
}

export type XoxProductTranscriptDisclosureKind =
  | 'group'
  | 'tool_body'
  | 'arguments'
  | 'result'
  | 'raw'
  | 'confirmation'
  | 'audit'
  | 'navigation'
  | 'details'

export interface XoxProductTranscriptSection<TAction = unknown, TNavigation = unknown> {
  id: string
  kind: XoxProductTranscriptDisclosureKind
  title: string
  summary?: string
  content?: string
  defaultOpen: boolean
  details?: Array<{ label: string; value: string }>
  navigation?: TNavigation | null
  actionRequest?: TAction | null
  payload?: Record<string, unknown> | null
  children?: Array<XoxProductTranscriptSection<TAction, TNavigation>>
}

export interface XoxProductTranscriptNode<TAction = unknown, TNavigation = unknown> {
  id: string
  threadId: string
  runId: string | null
  sequence: number
  kind: XoxProductTranscriptNodeKind
  title: string
  summary: string
  content?: string
  status: XoxProductTranscriptStatus
  visibility: XoxProductTranscriptVisibility
  defaultOpen?: boolean
  disclosure?: {
    kind: XoxProductTranscriptDisclosureKind
    defaultOpen: boolean
    reason?: string
  }
  tool?: {
    name: string
    callId?: string | null
    argumentsPreview?: string
    resultPreview?: string
  }
  sourceType?: string
  agUiEventType?: string
  actionRequestId?: string | null
  actionRequest?: TAction | null
  navigation?: TNavigation | null
  details?: Array<{ label: string; value: string }>
  sections?: Array<XoxProductTranscriptSection<TAction, TNavigation>>
  children?: Array<XoxProductTranscriptNode<TAction, TNavigation>>
  payload?: Record<string, unknown> | null
  createdAt: string
}

export interface XoxProductProjectionViews<TAction = unknown, TNavigation = unknown> {
  transcriptItems: Array<XoxProductTranscriptItem<TNavigation>>
  timelineItems: Array<XoxProductTimelineItem<TAction, TNavigation>>
  transcriptNodes: Array<XoxProductTranscriptNode<TAction, TNavigation>>
}

export interface XoxProductProjectionMessage {
  id: string
  threadId: string
  role: XoxProductMessageRole
  content: string
  createdAt: string
}

export interface XoxProductProjectionPlanStep<TNavigation = unknown> {
  id: string
  threadId: string
  runId: string
  sequence: number
  title: string
  description: string
  status: string
  actionRequestId?: string | null
  toolName?: string | null
  toolCallId?: string | null
  toolArguments?: unknown
  navigation?: TNavigation | null
  createdAt: string
}

export interface XoxProductActionAdapter<TAction, TNavigation> {
  id(action: TAction): string
  status(action: TAction): string
  kind(action: TAction): string
  title(action: TAction): string
  summary(action: TAction): string
  navigation(action: TAction): TNavigation | null | undefined
  details(action: TAction): Array<{ label: string; value: string }> | undefined
}

export interface XoxProductProjectionCopy {
  userTitle?: string
  assistantTitle?: string
  systemTitle?: string
  osUserMessageTitle?: string
  osAssistantFinalTitle?: string
  executedActionTitle?: string
  toolCallTitle?: (toolName: string) => string
}

export interface XoxProductProjectionInput<TAction, TNavigation> {
  messages: readonly XoxProductProjectionMessage[]
  osTranscriptItems: readonly OsTranscriptItem[]
  actionRequests: readonly TAction[]
  planSteps?: readonly XoxProductProjectionPlanStep<TNavigation>[]
  action: XoxProductActionAdapter<TAction, TNavigation>
  fallbackCreatedAt: string
  copy?: XoxProductProjectionCopy
}

export function projectXoxTranscriptViews<TAction, TNavigation = unknown>(
  input: XoxProductProjectionInput<TAction, TNavigation>,
): XoxProductProjectionViews<TAction, TNavigation> {
  const actionById = new Map(input.actionRequests.map((action) => [input.action.id(action), action]))
  const copy = input.copy ?? {}
  const messageItems = input.messages.map((message, index): XoxProductTranscriptItem<TNavigation> => ({
    id: `transcript-message-${message.id}`,
    threadId: message.threadId,
    runId: input.osTranscriptItems.find((item) => item.threadId === message.threadId)?.runId ?? 'run',
    sequence: index + 1,
    kind: 'message',
    title: message.role === 'user'
      ? copy.userTitle ?? 'User'
      : message.role === 'assistant'
        ? copy.assistantTitle ?? 'Assistant'
        : copy.systemTitle ?? 'System',
    summary: message.content,
    status: 'completed',
    visibility: message.role === 'system' ? 'technical' : 'user',
    sourceType: 'message',
    createdAt: message.createdAt,
  }))
  const messageKeys = new Set(input.messages.map((message) => `${message.role}:${message.content}`))
  const osItems = input.osTranscriptItems
    .filter((item) => !messageKeys.has(`${item.role}:${xoxProductOsContentSummary(item.content)}`))
    .map((item, index) => xoxProductTranscriptItemFromOs(item, {
      sequence: messageItems.length + index + 1,
      actionById,
      action: input.action,
      fallbackCreatedAt: input.fallbackCreatedAt,
      copy,
    }))
  const transcriptItems = [...messageItems, ...osItems]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence)
    .map((item, index) => ({ ...item, sequence: index + 1 }))
  const rawTimelineItems = transcriptItems.map((item, index) =>
    xoxProductTimelineItemFromTranscriptItem(item, actionById, input.action, index + 1, copy))
  const enrichedTimelineItems = collapseXoxProductDuplicateToolResults(enrichXoxProductTimelineItemsWithPlanSteps(
    mergeXoxProductTimelineItems(rawTimelineItems),
    input.planSteps ?? [],
  ))
  const representedPlanStepIds = new Set(enrichedTimelineItems
    .map((item) => xoxProductOsString(item.payload?.planStepId))
    .filter((id): id is string => Boolean(id)))
  const planStepTimelineItems = (input.planSteps ?? [])
    .filter((step) => !representedPlanStepIds.has(step.id))
    .map((step, index) =>
      xoxProductTimelineItemFromPlanStep<TAction, TNavigation>(step, copy, transcriptItems.length + index + 1))
  const timelineItems = [...enrichedTimelineItems, ...planStepTimelineItems]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence)
    .map((item, index) => ({ ...item, sequence: index + 1 }))
  const transcriptNodes = timelineItems.map((item, index) =>
    xoxProductTranscriptNodeFromTimelineItem(item, index + 1))
  return { transcriptItems, timelineItems, transcriptNodes }
}

function xoxProductTranscriptItemFromOs<TAction, TNavigation>(
  item: OsTranscriptItem,
  input: {
    sequence: number
    actionById: Map<string, TAction>
    action: XoxProductActionAdapter<TAction, TNavigation>
    fallbackCreatedAt: string
    copy: XoxProductProjectionCopy
  },
): XoxProductTranscriptItem<TNavigation> {
  const content = xoxProductOsRecordContent(item.content)
  const actionRequestId = xoxProductOsString(content.actionRequestId)
  const action = actionRequestId ? input.actionById.get(actionRequestId) ?? null : null
  const payload = xoxProductOsPayload(item)
  const eventType = xoxProductRuntimeEventType(content, payload)
  const kind = xoxProductTranscriptKindFromOs(item, content, action, payload, input.action)
  const title = xoxProductTranscriptTitleFromOs(item, content, action, payload, input.action, input.copy)
  const summary = xoxProductTranscriptSummaryFromOs(item, content, action, payload, input.action)
  const details = action ? input.action.details(action) : undefined
  const toolCallId = action
    ? input.action.id(action)
    : xoxProductTranscriptToolCallIdFromOs(content, payload)
  const toolName = action
    ? input.action.kind(action)
    : xoxProductTranscriptToolNameFromOs(content, payload)
  const agUiEventType = xoxProductTranscriptAgUiEventTypeFromOs(item, content, payload)
  const transcriptItem: XoxProductTranscriptItem<TNavigation> = {
    id: `transcript-os-${item.itemId}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence: input.sequence,
    kind,
    title,
    summary,
    status: xoxProductTranscriptStatusFromOs(item, content, action, payload, input.action),
    visibility: item.visibility,
    sourceType: eventType ?? item.kind,
    actionRequestId,
    toolCallId,
    toolName,
    navigation: action ? input.action.navigation(action) ?? null : null,
    ...(details ? { details } : {}),
    payload,
    createdAt: item.createdAt ?? input.fallbackCreatedAt,
  }
  if (agUiEventType !== undefined) transcriptItem.agUiEventType = agUiEventType
  return transcriptItem
}

function xoxProductTimelineItemFromTranscriptItem<TAction, TNavigation>(
  item: XoxProductTranscriptItem<TNavigation>,
  actionById: Map<string, TAction>,
  actionAdapter: XoxProductActionAdapter<TAction, TNavigation>,
  sequence: number,
  copy: XoxProductProjectionCopy,
): XoxProductTimelineItem<TAction, TNavigation> {
  const action = item.actionRequestId ? actionById.get(item.actionRequestId) ?? null : null
  const kind: XoxProductTimelineItemKind = item.kind === 'confirmation'
    ? 'tool_call'
    : item.kind === 'tool_call'
      ? 'tool_call'
    : item.kind === 'message' && item.title === (copy.userTitle ?? 'User')
      ? 'user_message'
      : item.kind === 'message' && item.sourceType === 'provider_stream_delta'
        ? 'assistant_stream'
      : item.kind === 'message'
        ? 'assistant_message'
        : item.kind === 'tool_result'
          ? 'tool_result'
          : item.kind === 'navigation'
            ? 'navigation'
            : item.kind === 'action_update'
              ? 'action_edit'
              : item.kind === 'memory'
                ? 'memory'
                : item.kind === 'evaluation'
                  ? 'evaluation'
                  : item.kind === 'technical'
                    ? 'technical'
                    : 'summary'
  const timelineItem: XoxProductTimelineItem<TAction, TNavigation> = {
    id: `timeline-${item.id}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence,
    kind,
    title: kind === 'tool_call' && item.toolName
      ? (copy.toolCallTitle?.(item.toolName) ?? `Tool call: ${item.toolName}`)
      : item.title,
    summary: item.summary,
    content: item.summary,
    status: item.status,
    visibility: item.visibility,
    createdAt: item.createdAt,
  }
  if (item.sourceType !== undefined) timelineItem.sourceType = item.sourceType
  if (item.agUiEventType !== undefined) timelineItem.agUiEventType = item.agUiEventType
  if (item.toolCallId !== undefined) timelineItem.toolCallId = item.toolCallId
  if (item.toolName !== undefined) timelineItem.toolName = item.toolName
  if (item.actionRequestId !== undefined) timelineItem.actionRequestId = item.actionRequestId
  if (action !== undefined) timelineItem.actionRequest = action
  if (item.navigation !== undefined) timelineItem.navigation = item.navigation
  if (item.details !== undefined) timelineItem.details = item.details
  if (item.payload !== undefined) timelineItem.payload = item.payload
  void actionAdapter
  return timelineItem
}

function xoxProductTimelineStatusFromPlanStep(status: string): XoxProductTranscriptStatus {
  if (status === 'pending' || status === 'queued') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'executed' || status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'cancelled'
  return 'info'
}

function xoxProductTimelineItemFromPlanStep<TAction, TNavigation>(
  step: XoxProductProjectionPlanStep<TNavigation>,
  copy: XoxProductProjectionCopy,
  sequence: number,
): XoxProductTimelineItem<TAction, TNavigation> {
  const toolName = step.toolName ?? 'tool'
  const payload: Record<string, unknown> = {
    planStepId: step.id,
    planStepStatus: step.status,
    planStepTitle: step.title,
    planStepSequence: step.sequence,
  }
  const argumentsPreview = xoxProductStringPreview(step.toolArguments)
  const resultPreview = xoxProductStringPreview(step.description)
  if (argumentsPreview) payload.argumentsPreview = argumentsPreview
  if (resultPreview) payload.resultPreview = resultPreview

  const item: XoxProductTimelineItem<TAction, TNavigation> = {
    id: `timeline-plan-step-${step.id}`,
    threadId: step.threadId,
    runId: step.runId,
    sequence,
    kind: 'tool_call',
    title: copy.toolCallTitle?.(toolName) ?? `Tool call: ${toolName}`,
    summary: step.title || '参数和结果可展开查看。',
    content: step.description,
    status: xoxProductTimelineStatusFromPlanStep(step.status),
    visibility: 'user',
    sourceType: 'plan_step',
    toolName,
    toolCallId: step.toolCallId ?? null,
    payload,
    createdAt: step.createdAt,
  }
  if (step.actionRequestId !== undefined) item.actionRequestId = step.actionRequestId
  if (step.navigation !== undefined) item.navigation = step.navigation
  return item
}

function xoxProductMergeText(existing: string | undefined, next: string | undefined) {
  if (!existing) return next ?? ''
  if (!next) return existing
  if (next.startsWith(existing)) return next
  if (existing.startsWith(next)) return existing
  return existing
}

function xoxProductStreamKey<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
) {
  if (item.kind !== 'assistant_stream') return null
  return `${item.runId ?? item.threadId}:assistant_stream`
}

function xoxProductToolCallKey<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
) {
  if (item.kind !== 'tool_call' || item.sourceType !== 'provider_stream_delta') return null
  const data = xoxProductRunEventData(item.payload ?? null, null)
  const index = typeof data?.toolCallIndex === 'number' ? data.toolCallIndex : null
  return `${item.runId ?? item.threadId}:${item.toolCallId ?? item.toolName ?? 'tool'}:${index ?? ''}`
}

function xoxProductCompletedStreamRunIds<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
) {
  return new Set(items
    .filter((item) =>
      item.sourceType === 'provider_stream_completed' ||
      item.sourceType === 'run_completed' ||
      (item.status === 'completed' && item.sourceType === 'run_status'))
    .map((item) => item.runId)
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0))
}

function xoxProductFinalAssistantRunIds<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
) {
  return new Set(items
    .filter((item) =>
      item.kind === 'assistant_message' &&
      item.visibility === 'user' &&
      item.sourceType !== 'provider_stream_delta')
    .map((item) => item.runId)
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0))
}

function xoxProductProviderToolRunIds<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
) {
  return new Set(items
    .filter((item) => item.kind === 'tool_call' && item.sourceType === 'provider_stream_delta')
    .map((item) => item.runId)
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0))
}

function xoxProductFinalizeStreamStatus<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
  completedRunIds: Set<string>,
): XoxProductTimelineItem<TAction, TNavigation> {
  if (item.sourceType !== 'provider_stream_delta' || item.status !== 'running') return item
  if (!item.runId || !completedRunIds.has(item.runId)) return item
  return { ...item, status: 'completed' }
}

function mergeXoxProductTimelineItems<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
) {
  const merged: Array<XoxProductTimelineItem<TAction, TNavigation>> = []
  const streamIndexByKey = new Map<string, number>()
  const toolIndexByKey = new Map<string, number>()
  const completedRunIds = xoxProductCompletedStreamRunIds(items)
  const finalAssistantRunIds = xoxProductFinalAssistantRunIds(items)
  const providerToolRunIds = xoxProductProviderToolRunIds(items)

  for (const item of items) {
    const streamKey = xoxProductStreamKey(item)
    if (streamKey) {
      const existingIndex = streamIndexByKey.get(streamKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          const summary = xoxProductMergeText(existing.summary, item.summary)
          const content = xoxProductMergeText(existing.content, item.content)
          const payload = item.payload ?? existing.payload
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary,
            content,
            status: item.status,
            createdAt: existing.createdAt <= item.createdAt ? existing.createdAt : item.createdAt,
          }
          if (payload !== undefined) merged[existingIndex].payload = payload
        }
        continue
      }
      streamIndexByKey.set(streamKey, merged.length)
    }

    const toolKey = xoxProductToolCallKey(item)
    if (toolKey) {
      const existingIndex = toolIndexByKey.get(toolKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          const content = item.content || existing.content
          const payload = item.payload ?? existing.payload
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary: item.summary || existing.summary,
            status: item.status,
            createdAt: existing.createdAt <= item.createdAt ? existing.createdAt : item.createdAt,
          }
          if (content !== undefined) merged[existingIndex].content = content
          if (payload !== undefined) merged[existingIndex].payload = payload
        }
        continue
      }
      toolIndexByKey.set(toolKey, merged.length)
    }

    merged.push(item)
  }

  return merged
    .filter((item) =>
      item.kind !== 'assistant_stream' ||
      !item.runId ||
      !finalAssistantRunIds.has(item.runId) ||
      providerToolRunIds.has(item.runId))
    .map((item) => xoxProductFinalizeStreamStatus(item, completedRunIds))
}

function xoxProductPlanStepByKey<TNavigation>(
  planSteps: readonly XoxProductProjectionPlanStep<TNavigation>[],
) {
  const byToolCallId = new Map<string, XoxProductProjectionPlanStep<TNavigation>>()
  const byToolName = new Map<string, XoxProductProjectionPlanStep<TNavigation>[]>()
  const byThreadToolName = new Map<string, XoxProductProjectionPlanStep<TNavigation>[]>()
  for (const step of planSteps) {
    if (step.toolCallId) byToolCallId.set(`${step.runId}:call:${step.toolCallId}`, step)
    if (step.toolName) {
      const runKey = `${step.runId}:name:${step.toolName}`
      byToolName.set(runKey, [...(byToolName.get(runKey) ?? []), step])
      const threadKey = `${step.threadId}:name:${step.toolName}`
      byThreadToolName.set(threadKey, [...(byThreadToolName.get(threadKey) ?? []), step])
    }
  }
  for (const entries of [...byToolName.values(), ...byThreadToolName.values()]) {
    entries.sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt))
  }
  return { byToolCallId, byToolName, byThreadToolName }
}

function xoxProductTimelinePlanStep<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
  indexes: ReturnType<typeof xoxProductPlanStepByKey<TNavigation>>,
): XoxProductProjectionPlanStep<TNavigation> | null {
  if ((item.kind !== 'tool_call' && item.kind !== 'tool_result') || !item.runId) return null
  if (item.toolCallId) {
    const exact = indexes.byToolCallId.get(`${item.runId}:call:${item.toolCallId}`)
    if (exact) return exact
  }
  if (!item.toolName) return null
  return indexes.byToolName.get(`${item.runId}:name:${item.toolName}`)?.[0] ??
    indexes.byThreadToolName.get(`${item.threadId}:name:${item.toolName}`)?.[0] ??
    null
}

function enrichXoxProductTimelineItemsWithPlanSteps<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
  planSteps: readonly XoxProductProjectionPlanStep<TNavigation>[],
) {
  if (planSteps.length === 0) return items
  const indexes = xoxProductPlanStepByKey(planSteps)
  return items.map((item) => {
    const planStep = xoxProductTimelinePlanStep(item, indexes)
    if (!planStep) return item

    const payload: Record<string, unknown> = {
      ...(item.payload ?? {}),
      planStepId: planStep.id,
      planStepStatus: planStep.status,
      planStepTitle: planStep.title,
      planStepSequence: planStep.sequence,
    }
    const argumentsPreview = xoxProductToolArgumentsPreview(item) ??
      xoxProductStringPreview(planStep.toolArguments)
    const resultPreview = xoxProductStringPreview(planStep.description) ??
      xoxProductToolResultPreview(item)
    if (argumentsPreview) payload.argumentsPreview = argumentsPreview
    if (resultPreview) payload.resultPreview = resultPreview

    const next: XoxProductTimelineItem<TAction, TNavigation> = {
      ...item,
      payload,
    }
    if ((!next.toolName || next.toolName === 'tool call') && planStep.toolName) next.toolName = planStep.toolName
    if ((!next.toolCallId || next.toolCallId.startsWith('tool-call-')) && planStep.toolCallId) {
      next.toolCallId = planStep.toolCallId
    }
    if (!next.navigation && planStep.navigation) next.navigation = planStep.navigation
    return next
  })
}

function collapseXoxProductDuplicateToolResults<TAction, TNavigation>(
  items: Array<XoxProductTimelineItem<TAction, TNavigation>>,
) {
  const representedByToolCall = new Set(items
    .filter((item) => item.kind === 'tool_call')
    .map((item) => xoxProductOsString(item.payload?.planStepId))
    .filter((id): id is string => Boolean(id)))
  if (representedByToolCall.size === 0) return items
  return items.filter((item) => {
    if (item.kind !== 'tool_result' || item.sourceType !== 'tool_call_completed') return true
    const planStepId = xoxProductOsString(item.payload?.planStepId)
    return !planStepId || !representedByToolCall.has(planStepId)
  })
}

function xoxProductRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function xoxProductStringPreview(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim().length > 0 ? value : null
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function xoxProductToolArgumentsPreview<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
) {
  const payload = item.payload ?? {}
  const data = xoxProductRunEventData(payload, null)
  return xoxProductOsString(payload.argumentsPreview) ??
    xoxProductOsString(payload.argumentsDelta) ??
    xoxProductOsString(data?.argumentsPreview) ??
    xoxProductOsString(data?.argumentsDelta)
}

function xoxProductToolResultPreview<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
) {
  const payload = item.payload ?? {}
  const data = xoxProductRunEventData(payload, null)
  return xoxProductOsString(payload.resultPreview) ??
    xoxProductOsString(data?.resultPreview) ??
    (item.kind === 'tool_result' ? xoxProductOsString(item.summary) : null)
}

function xoxProductCompactSummary(content: string, fallback: string) {
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.length > 0 ? compact.slice(0, 180) : fallback
}

function xoxProductRawSection<TAction, TNavigation>(
  id: string,
  content: string,
): XoxProductTranscriptSection<TAction, TNavigation> {
  const rawPayload = xoxProductRecord(safeJsonParse(content))
  const section: XoxProductTranscriptSection<TAction, TNavigation> = {
    id,
    kind: 'raw',
    title: 'Raw JSON',
    summary: '二级折叠',
    content,
    defaultOpen: false,
  }
  if (rawPayload) section.payload = rawPayload
  return section
}

function safeJsonParse(value: string): unknown {
  try {
    return parseBoundedAgentJson(value, {
      maxBytes: 256_000,
      maxDepth: 32,
      maxNodes: 32_768,
      maxStringBytes: 128_000,
      maxArrayItems: 8_192,
      maxObjectProperties: 8_192,
    })
  } catch {
    return null
  }
}

function xoxProductToolSections<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
): Array<XoxProductTranscriptSection<TAction, TNavigation>> {
  const sections: Array<XoxProductTranscriptSection<TAction, TNavigation>> = []
  const argumentsPreview = xoxProductToolArgumentsPreview(item)
  if (argumentsPreview) {
    sections.push({
      id: `${item.id}:arguments`,
      kind: 'arguments',
      title: 'Arguments',
      summary: xoxProductCompactSummary(argumentsPreview, '参数可展开查看'),
      content: argumentsPreview,
      defaultOpen: false,
      children: [xoxProductRawSection(`${item.id}:arguments:raw`, argumentsPreview)],
    })
  }
  const resultPreview = xoxProductToolResultPreview(item)
  if (resultPreview) {
    sections.push({
      id: `${item.id}:result`,
      kind: 'result',
      title: 'Result Preview',
      summary: xoxProductCompactSummary(resultPreview, '结果已用于本轮回复'),
      content: resultPreview,
      defaultOpen: item.status === 'failed',
    })
  }
  return sections
}

function xoxProductTranscriptNodeFromTimelineItem<TAction, TNavigation>(
  item: XoxProductTimelineItem<TAction, TNavigation>,
  sequence: number,
): XoxProductTranscriptNode<TAction, TNavigation> {
  const kind: XoxProductTranscriptNodeKind = item.kind === 'action_edit'
    ? 'action_update'
    : item.kind === 'summary'
      ? 'summary'
      : item.kind
  const node: XoxProductTranscriptNode<TAction, TNavigation> = {
    id: `node-${item.id}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence,
    kind,
    title: item.title,
    summary: item.summary,
    ...(item.content ? { content: item.content } : {}),
    status: item.status,
    visibility: item.visibility,
    defaultOpen: item.visibility === 'user',
    createdAt: item.createdAt,
  }
  const isToolNode = item.kind === 'tool_call' || item.kind === 'tool_result'
  const sections = isToolNode ? xoxProductToolSections(item) : []
  if (isToolNode) {
    node.disclosure = { kind: 'tool_body', defaultOpen: item.visibility === 'user' }
  }
  if (item.toolName) {
    const tool: NonNullable<XoxProductTranscriptNode<TAction, TNavigation>['tool']> = {
      name: item.toolName,
      callId: item.toolCallId ?? null,
    }
    const argumentsPreview = xoxProductToolArgumentsPreview(item)
    const resultPreview = xoxProductToolResultPreview(item)
    if (argumentsPreview) tool.argumentsPreview = argumentsPreview
    if (resultPreview) tool.resultPreview = resultPreview
    node.tool = tool
  }
  if (item.sourceType !== undefined) node.sourceType = item.sourceType
  if (item.agUiEventType !== undefined) node.agUiEventType = item.agUiEventType
  if (item.actionRequestId !== undefined) node.actionRequestId = item.actionRequestId
  if (item.actionRequest !== undefined) node.actionRequest = item.actionRequest
  if (item.navigation !== undefined) node.navigation = item.navigation
  if (item.details !== undefined) node.details = item.details
  if (sections.length > 0) node.sections = sections
  if (item.payload !== undefined) node.payload = item.payload
  return node
}

function xoxProductTranscriptKindFromOs<TAction, TNavigation>(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: TAction | null,
  payload: Record<string, unknown> | null,
  adapter: XoxProductActionAdapter<TAction, TNavigation>,
): XoxProductTranscriptItemKind {
  if (item.kind === 'action_request') return action && adapter.status(action) === 'executed' ? 'tool_result' : 'confirmation'
  if (item.kind === 'assistant_stream') return 'message'
  if (item.kind === 'tool_call') return 'tool_call'
  if (item.kind === 'tool_result') return 'tool_result'
  if (item.kind === 'action_event') return xoxProductRuntimeEventKind(content, payload)
  if (item.kind === 'tool_observation') return 'tool_result'
  if (item.kind === 'technical_event') return xoxProductRuntimeEventKind(content, payload)
  if (item.kind === 'run_status') return 'status'
  return 'message'
}

function xoxProductRuntimeEventKind(
  content: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): XoxProductTranscriptItemKind {
  const eventType = xoxProductRuntimeEventType(content, payload)
  const channel = xoxProductOsString(content.channel)
  if (eventType === 'provider_stream_delta') {
    const data = xoxProductRunEventData(payload, content)
    const streamKind = xoxProductStreamKind(data)
    if (streamKind === 'content_delta') return 'message'
    if (streamKind === 'tool_call_delta') return 'tool_call'
    return 'technical'
  }
  if (eventType === 'run_failed') return 'error'
  if (eventType?.startsWith('memory_')) return 'memory'
  if (eventType === 'goal_evaluated' || eventType === 'final_answer_candidate') return 'evaluation'
  if (eventType === 'action_executed' || eventType === 'tool_call_completed') return 'tool_result'
  if (
    eventType === 'action_cancelled' ||
    eventType === 'action_execution_failed' ||
    eventType === 'action_updated' ||
    eventType === 'confirmation_ready' ||
    eventType === 'provider_tool_call_repaired' ||
    eventType === 'tool_call_failed' ||
    eventType === 'tool_call_started' ||
    eventType === 'tool_plan_ready' ||
    channel === 'tool' ||
    channel === 'action'
  ) {
    return 'tool_call'
  }
  if (
    eventType === 'goal_iteration_started' ||
    eventType === 'model_turn_started' ||
    eventType === 'provider_retrying' ||
    eventType === 'provider_stable_long_tool_mode' ||
    eventType === 'provider_stream_completed' ||
    eventType === 'provider_stream_started' ||
    eventType === 'tool_catalog_ready'
  ) {
    return 'model_turn'
  }
  return 'technical'
}

function xoxProductTranscriptStatusFromOs<TAction, TNavigation>(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: TAction | null,
  payload: Record<string, unknown> | null,
  adapter: XoxProductActionAdapter<TAction, TNavigation>,
): XoxProductTranscriptStatus {
  if (action) return adapter.status(action) === 'pending' || adapter.status(action) === 'confirmed'
    ? 'waiting'
    : adapter.status(action) === 'executed'
      ? 'completed'
      : adapter.status(action) === 'cancelled'
        ? 'cancelled'
        : 'failed'
  const status = xoxProductOsString(payload?.status) ?? xoxProductOsString(content.status)
  if (status === 'pending' || status === 'queued') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'completed' || status === 'executed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'cancelled'
  return item.kind === 'technical_event' ? 'info' : 'completed'
}

function xoxProductTranscriptTitleFromOs<TAction, TNavigation>(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: TAction | null,
  payload: Record<string, unknown> | null,
  adapter: XoxProductActionAdapter<TAction, TNavigation>,
  copy: XoxProductProjectionCopy,
) {
  if (action && adapter.status(action) === 'executed') return copy.executedActionTitle ?? 'Executed action'
  if (action) return adapter.title(action)
  if (item.kind === 'user_message') return copy.osUserMessageTitle ?? 'User message'
  if (item.kind === 'assistant_final') return copy.osAssistantFinalTitle ?? 'Final answer'
  const eventType = xoxProductRuntimeEventType(content, payload)
  if (eventType === 'provider_stream_delta') {
    const data = xoxProductRunEventData(payload, content)
    const streamKind = xoxProductStreamKind(data)
    if (streamKind === 'content_delta') return '实时回复'
    if (streamKind === 'tool_call_delta') {
      const toolName = xoxProductTranscriptToolNameFromOs(content, payload) ?? 'tool call'
      return copy.toolCallTitle?.(toolName) ?? `Tool call: ${toolName}`
    }
  }
  return xoxProductOsString(payload?.title) ?? xoxProductOsString(content.title) ?? xoxProductOsString(content.toolName) ?? item.kind
}

function xoxProductTranscriptSummaryFromOs<TAction, TNavigation>(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: TAction | null,
  payload: Record<string, unknown> | null,
  adapter: XoxProductActionAdapter<TAction, TNavigation>,
) {
  if (action) return adapter.summary(action)
  const eventType = xoxProductRuntimeEventType(content, payload)
  if (eventType === 'provider_stream_delta') {
    const data = xoxProductRunEventData(payload, content)
    const streamKind = xoxProductStreamKind(data)
    if (streamKind === 'content_delta') {
      return xoxProductOsString(data?.text) ??
        xoxProductOsString(data?.preview) ??
        xoxProductOsString(data?.delta) ??
        xoxProductOsString(payload?.message) ??
        xoxProductOsString(content.message) ??
        xoxProductOsContentSummary(item.content)
    }
    if (streamKind === 'tool_call_delta') {
      return xoxProductOsString(data?.argumentsPreview) ??
        xoxProductOsString(data?.argumentsDelta) ??
        '工具参数正在生成。'
    }
  }
  return xoxProductOsString(payload?.message) ??
    xoxProductOsString(content.description) ??
    xoxProductOsString(content.reason) ??
    xoxProductOsContentSummary(item.content)
}

function xoxProductRuntimeEventType(
  content: Record<string, unknown>,
  payload: Record<string, unknown> | null,
) {
  return xoxProductOsString(payload?.hostEventType) ??
    xoxProductOsString(payload?.sourceType) ??
    xoxProductOsString(content.eventType) ??
    xoxProductOsString(content.sourceType)
}

function xoxProductRunEventData(
  payload: Record<string, unknown> | null | undefined,
  content: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const payloadData = payload?.data
  if (payloadData && typeof payloadData === 'object' && !Array.isArray(payloadData)) {
    return payloadData as Record<string, unknown>
  }
  const contentData = content?.data
  if (contentData && typeof contentData === 'object' && !Array.isArray(contentData)) {
    return contentData as Record<string, unknown>
  }
  if (xoxProductOsString(content?.streamKind) !== null) {
    return content as Record<string, unknown>
  }
  return null
}

function xoxProductStreamKind(data: Record<string, unknown> | null) {
  return xoxProductOsString(data?.kind) ?? xoxProductOsString(data?.streamKind)
}

function xoxProductTranscriptToolNameFromOs(
  content: Record<string, unknown>,
  payload: Record<string, unknown> | null,
) {
  const data = xoxProductRunEventData(payload, content)
  return xoxProductOsString(content.toolName) ??
    xoxProductOsString(payload?.toolName) ??
    xoxProductOsString(data?.toolName)
}

function xoxProductTranscriptToolCallIdFromOs(
  content: Record<string, unknown>,
  payload: Record<string, unknown> | null,
) {
  const data = xoxProductRunEventData(payload, content)
  const explicit = xoxProductOsString(content.toolCallId) ??
    xoxProductOsString(payload?.toolCallId) ??
    xoxProductOsString(data?.toolCallId)
  if (explicit) return explicit
  const index = data?.toolCallIndex
  return typeof index === 'number' && Number.isFinite(index) ? `tool-call-${index}` : null
}

function xoxProductTranscriptAgUiEventTypeFromOs(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  payload: Record<string, unknown> | null,
) {
  if (
    item.kind !== 'technical_event' &&
    item.kind !== 'assistant_stream' &&
    item.kind !== 'tool_call'
  ) {
    return undefined
  }
  const eventType = xoxProductRuntimeEventType(content, payload)
  const data = xoxProductRunEventData(payload, content)
  if (eventType === 'provider_stream_delta') {
    const streamKind = xoxProductStreamKind(data)
    if (streamKind === 'content_delta') return 'TEXT_MESSAGE_CONTENT'
    if (streamKind === 'tool_call_delta') return 'TOOL_CALL_ARGS'
  }
  if (eventType === 'provider_stream_started' || eventType === 'model_turn_started') return 'STEP_STARTED'
  if (eventType === 'provider_stream_completed') return 'STEP_FINISHED'
  return undefined
}

function xoxProductOsPayload(item: OsTranscriptItem): Record<string, unknown> | null {
  const content = xoxProductOsRecordContent(item.content)
  const payload = content.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : content
}

function xoxProductOsRecordContent(content: unknown): Record<string, unknown> {
  return content && typeof content === 'object' && !Array.isArray(content)
    ? content as Record<string, unknown>
    : {}
}

function xoxProductOsString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function xoxProductOsContentSummary(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}
