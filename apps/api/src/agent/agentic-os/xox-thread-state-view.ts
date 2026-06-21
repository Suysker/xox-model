import type {
  AgentActionRequest as OsActionRequest,
  AgentMessage as OsMessage,
  AgentRunEvent as OsRunEvent,
  AgentRunEventChannel as OsRunEventChannel,
  AgentRunEventType as OsRunEventType,
  AgentRunInput as OsRunInput,
  AgentRunRecord as OsRunRecord,
  AgentRunResult as OsRunResult,
  AgentScope as OsScope,
  AgentTranscriptItem as OsTranscriptItem,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import type { AgentServerThreadRunState, AgentServerThreadSnapshot } from '@agentic-os/server'
import { AgentServerThreadStateProjector, projectAgentServerAgUiEvents } from '@agentic-os/server'
import type {
  AgentActionRequest,
  AgentAgUiEvent,
  AgentEvaluationResult,
  AgentGoalRecord,
  AgentMessage,
  AgentNavigationEvent,
  AgentPlannerSource,
  AgentPlanStep,
  AgentRunEvent,
  AgentRunRecord,
  AgentTimelineItem,
  AgentTranscriptItem,
  AgentTranscriptNode,
  AgentThreadState,
  AgentThreadSummary,
} from '@xox/contracts'
import type { Row } from '../../db/schema.js'

export type XoxAgenticOsUser = {
  id: string
}

type XoxAgenticOsScopeInput = {
  workspace: Row<'workspaces'>
  user: XoxAgenticOsUser
}

function xoxAgenticOsScope(input: XoxAgenticOsScopeInput): OsScope {
  return {
    tenantId: input.workspace.owner_id,
    workspaceId: input.workspace.id,
    userId: input.user.id,
  }
}

export function xoxMessageToOsMessage(message: AgentMessage): OsMessage {
  return {
    role: message.role,
    content: message.content,
  }
}

export function xoxRunToOsRunRecord(input: XoxAgenticOsScopeInput & { run: AgentRunRecord }): OsRunRecord {
  return {
    runId: input.run.id,
    threadId: input.run.threadId,
    scope: xoxAgenticOsScope(input),
    status: input.run.status,
    createdAt: input.run.createdAt,
  }
}

export function xoxRunInputToOs(
  input: XoxAgenticOsScopeInput & {
    threadId: string
    userMessage: string
    automationLevel?: AgentRunRecord['automationLevel'] | undefined
    metadata?: OsJsonObject | undefined
  },
): OsRunInput {
  const runInput: OsRunInput = {
    threadId: input.threadId,
    scope: xoxAgenticOsScope(input),
    userMessage: input.userMessage,
  }
  if (input.automationLevel !== undefined) {
    runInput.automationLevel = input.automationLevel
  }
  if (input.metadata !== undefined) {
    runInput.metadata = input.metadata
  }
  return runInput
}

export function xoxActionRequestToOsActionRequest(action: AgentActionRequest): OsActionRequest {
  const request: OsActionRequest = {
    actionRequestId: action.id,
    runId: action.runId,
    threadId: action.threadId,
    toolCallId: action.id,
    toolName: action.kind,
    status: xoxActionStatusToOs(action.status),
    title: action.title,
    description: action.summary,
    preview: xoxJsonObject({
      kind: action.kind,
      targetLabel: action.targetLabel,
      riskLevel: action.riskLevel,
      details: action.details,
      navigation: action.navigation,
      payload: action.payload,
    }),
  }
  if (action.errorMessage) {
    request.warnings = [action.errorMessage]
  }
  return request
}

export function xoxRunEventToOsRunEvent(event: AgentRunEvent): OsRunEvent {
  return {
    eventId: event.id,
    sequence: event.sequence,
    runId: event.runId,
    threadId: event.threadId,
    type: xoxRunEventTypeToOs(event),
    channel: xoxRunEventChannelToOs(event.channel),
    createdAt: event.createdAt,
    payload: xoxJsonObject({
      hostEventType: event.type,
      title: event.title,
      message: event.message,
      status: event.status,
      data: event.data ?? null,
    }),
  }
}

export function xoxCompletedRunResultToOs(input: {
  run: OsRunRecord
  assistantText?: string | undefined
}): OsRunResult | undefined {
  if (input.run.status !== 'completed' || !input.assistantText) return undefined
  return {
    status: 'completed',
    runId: input.run.runId,
    threadId: input.run.threadId,
    assistantText: input.assistantText,
    observations: [],
    evidence: [],
  }
}

export function sortXoxRunEventsByOsView(
  runEvents: AgentRunEvent[],
  osEvents: OsRunEvent[],
): AgentRunEvent[] {
  if (runEvents.length !== osEvents.length) return runEvents
  const byId = new Map(runEvents.map((event) => [event.id, event]))
  const sorted = osEvents.map((event) => byId.get(event.eventId))
  if (sorted.some((event) => event === undefined)) return runEvents
  return sorted as AgentRunEvent[]
}

function xoxJsonObject(value: Record<string, unknown>): OsJsonObject {
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

function xoxActionStatusToOs(status: AgentActionRequest['status']): OsActionRequest['status'] {
  if (status === 'pending') return 'pending'
  if (status === 'confirmed') return 'edited'
  if (status === 'executed') return 'executed'
  if (status === 'failed') return 'failed'
  return 'rejected'
}

function xoxRunEventChannelToOs(channel: AgentRunEvent['channel']): OsRunEventChannel {
  if (channel === 'assistant' || channel === 'tool' || channel === 'lifecycle') return channel
  return 'technical'
}

function xoxRunEventTypeToOs(event: AgentRunEvent): OsRunEventType {
  if (event.type === 'run_queued') return 'run.created'
  if (event.type === 'assistant_final_message' || event.type === 'final_answer_candidate') return 'model.completed'
  if (event.type === 'action_executed' || event.type === 'action_auto_executed') return 'action.executed'
  if (event.type === 'action_cancelled') return 'action.rejected'
  if (event.type === 'action_updated') return 'action.previewed'
  if (event.type.includes('tool')) return 'tool.observed'
  if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') return 'run.finished'
  return 'turn.started'
}

export type XoxThreadStateRunInput = {
  runId: string
  userMessage: string | null
}

export type XoxThreadStateViewInput = {
  workspace: Row<'workspaces'>
  user: XoxAgenticOsUser
  thread: AgentThreadSummary
  messages: AgentMessage[]
  runs: AgentRunRecord[]
  runInputs: XoxThreadStateRunInput[]
  planner: AgentPlannerSource | null
  goals: AgentGoalRecord[]
  evaluations: AgentEvaluationResult[]
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentRunEvent[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
}

type XoxProjectionViews = {
  transcriptItems: AgentTranscriptItem[]
  timelineItems: AgentTimelineItem[]
  transcriptNodes: AgentTranscriptNode[]
}

type XoxProjectionViewInput = {
  threadId: string
  messages: AgentMessage[]
  osTranscriptItems: OsTranscriptItem[]
  actionRequests: AgentActionRequest[]
  fallbackCreatedAt: string
}

export function buildXoxThreadStateView(input: XoxThreadStateViewInput): AgentThreadState {
  const osState = new AgentServerThreadStateProjector().project(buildOsThreadSnapshot(input))
  const runEvents = sortXoxRunEventsByOsView(input.runEvents, osState.events)
  const projection = {
    thread: { id: osState.thread.threadId },
    messages: input.messages,
    goals: input.goals,
    evaluations: input.evaluations,
    navigationEvents: input.navigationEvents,
    runEvents,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  }
  const agUiEvents = projectAgentServerAgUiEvents(projection, { eventNamePrefix: 'xox' }) as AgentAgUiEvent[]
  const projected = buildXoxProjectionViews({
    threadId: input.thread.id,
    messages: input.messages,
    osTranscriptItems: osState.transcriptItems,
    actionRequests: input.actionRequests,
    fallbackCreatedAt: input.thread.updatedAt,
  })

  return {
    thread: input.thread,
    messages: input.messages,
    runs: input.runs,
    planner: input.planner,
    goals: input.goals,
    evaluations: input.evaluations,
    navigationEvents: input.navigationEvents,
    runEvents,
    agUiEvents,
    transcriptItems: projected.transcriptItems,
    timelineItems: projected.timelineItems,
    transcriptNodes: projected.transcriptNodes,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  }
}

export function buildXoxProjectionViews(input: XoxProjectionViewInput): XoxProjectionViews {
  const actionById = new Map(input.actionRequests.map((action) => [action.id, action]))
  const productMessages = input.messages.filter((message) =>
    !(message.role === 'assistant' && input.actionRequests.length > 0 && message.content.includes('待确认动作卡'))
  )
  const messageItems = productMessages.map((message, index): AgentTranscriptItem => ({
    id: `transcript-message-${message.id}`,
    threadId: message.threadId,
    runId: input.osTranscriptItems.find((item) => item.threadId === message.threadId)?.runId ?? 'run',
    sequence: index + 1,
    kind: 'message',
    title: message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '系统',
    summary: message.content,
    status: 'completed',
    visibility: message.role === 'system' ? 'technical' : 'user',
    sourceType: 'message',
    createdAt: message.createdAt,
  }))
  const messageKeys = new Set(productMessages.map((message) => `${message.role}:${message.content}`))
  const osItems = input.osTranscriptItems
    .filter((item) => !messageKeys.has(`${item.role}:${osContentSummary(item.content)}`))
    .filter((item) =>
      !(item.role === 'assistant' && input.actionRequests.length > 0 && osContentSummary(item.content).includes('待确认动作卡'))
    )
    .map((item, index) => xoxTranscriptItemFromOs(item, {
      sequence: messageItems.length + index + 1,
      actionById,
      fallbackCreatedAt: input.fallbackCreatedAt,
    }))
  const transcriptItems = [...messageItems, ...osItems]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence)
    .map((item, index) => ({ ...item, sequence: index + 1 }))
  const timelineItems = transcriptItems.map((item, index) => timelineItemFromTranscriptItem(item, actionById, index + 1))
  const transcriptNodes = timelineItems.map((item, index) => transcriptNodeFromTimelineItem(item, index + 1))
  return { transcriptItems, timelineItems, transcriptNodes }
}

function xoxTranscriptItemFromOs(
  item: OsTranscriptItem,
  input: {
    sequence: number
    actionById: Map<string, AgentActionRequest>
    fallbackCreatedAt: string
  },
): AgentTranscriptItem {
  const content = osRecordContent(item.content)
  const actionRequestId = osString(content.actionRequestId)
  const action = actionRequestId ? input.actionById.get(actionRequestId) ?? null : null
  const payload = osPayload(item)
  const kind = transcriptKindFromOs(item, action)
  const title = transcriptTitleFromOs(item, content, action, payload)
  const summary = transcriptSummaryFromOs(item, content, action, payload)
  return {
    id: `transcript-os-${item.itemId}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence: input.sequence,
    kind,
    title,
    summary,
    status: transcriptStatusFromOs(item, content, action, payload),
    visibility: item.visibility,
    sourceType: item.kind,
    actionRequestId,
    toolCallId: action?.id ?? osString(content.toolCallId),
    toolName: action?.kind ?? osString(content.toolName),
    navigation: action?.navigation ?? null,
    ...(action?.details ? { details: action.details } : {}),
    payload,
    createdAt: item.createdAt ?? input.fallbackCreatedAt,
  }
}

function timelineItemFromTranscriptItem(
  item: AgentTranscriptItem,
  actionById: Map<string, AgentActionRequest>,
  sequence: number,
): AgentTimelineItem {
  const action = item.actionRequestId ? actionById.get(item.actionRequestId) ?? null : null
  const kind: AgentTimelineItem['kind'] = item.kind === 'confirmation'
    ? 'tool_call'
    : item.kind === 'message' && item.title === '你'
      ? 'user_message'
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
  const timelineItem: AgentTimelineItem = {
    id: `timeline-${item.id}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence,
    kind,
    title: kind === 'tool_call' && item.toolName ? `调用工具：${item.toolName}` : item.title,
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
  return timelineItem
}

function transcriptNodeFromTimelineItem(item: AgentTimelineItem, sequence: number): AgentTranscriptNode {
  const kind: AgentTranscriptNode['kind'] = item.kind === 'action_edit'
    ? 'action_update'
    : item.kind === 'summary'
      ? 'summary'
      : item.kind
  const node: AgentTranscriptNode = {
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
  if (item.toolName) node.tool = { name: item.toolName, callId: item.toolCallId ?? null }
  if (item.sourceType !== undefined) node.sourceType = item.sourceType
  if (item.agUiEventType !== undefined) node.agUiEventType = item.agUiEventType
  if (item.actionRequestId !== undefined) node.actionRequestId = item.actionRequestId
  if (item.actionRequest !== undefined) node.actionRequest = item.actionRequest
  if (item.navigation !== undefined) node.navigation = item.navigation
  if (item.details !== undefined) node.details = item.details
  if (item.payload !== undefined) node.payload = item.payload
  return node
}

function transcriptKindFromOs(item: OsTranscriptItem, action?: AgentActionRequest | null): AgentTranscriptItem['kind'] {
  if (item.kind === 'action_request') return action?.status === 'executed' ? 'tool_result' : 'confirmation'
  if (item.kind === 'tool_observation') return 'tool_result'
  if (item.kind === 'technical_event') return 'technical'
  if (item.kind === 'run_status') return 'status'
  return 'message'
}

function transcriptStatusFromOs(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: AgentActionRequest | null,
  payload: Record<string, unknown> | null,
): AgentTranscriptItem['status'] {
  if (action) return action.status === 'pending' || action.status === 'confirmed'
    ? 'waiting'
    : action.status === 'executed'
      ? 'completed'
      : action.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
  const status = osString(payload?.status) ?? osString(content.status)
  if (status === 'pending' || status === 'queued') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'completed' || status === 'executed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'cancelled'
  return item.kind === 'technical_event' ? 'info' : 'completed'
}

function transcriptTitleFromOs(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: AgentActionRequest | null,
  payload: Record<string, unknown> | null,
) {
  if (action?.status === 'executed') return '已执行动作'
  if (action) return action.title
  if (item.kind === 'user_message') return '用户消息'
  if (item.kind === 'assistant_final') return '最终回答'
  return osString(payload?.title) ?? osString(content.title) ?? osString(content.toolName) ?? item.kind
}

function transcriptSummaryFromOs(
  item: OsTranscriptItem,
  content: Record<string, unknown>,
  action: AgentActionRequest | null,
  payload: Record<string, unknown> | null,
) {
  if (action) return action.summary
  return osString(payload?.message) ?? osString(content.description) ?? osString(content.reason) ?? osContentSummary(item.content)
}

function osPayload(item: OsTranscriptItem): Record<string, unknown> | null {
  const content = osRecordContent(item.content)
  const payload = content.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : content
}

function osRecordContent(content: unknown): Record<string, unknown> {
  return content && typeof content === 'object' && !Array.isArray(content)
    ? content as Record<string, unknown>
    : {}
}

function osString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function osContentSummary(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function buildOsThreadSnapshot(input: XoxThreadStateViewInput): AgentServerThreadSnapshot {
  return {
    thread: {
      threadId: input.thread.id,
      title: input.thread.title,
      createdAt: input.thread.createdAt,
      updatedAt: input.thread.updatedAt,
    },
    messages: input.messages.map(xoxMessageToOsMessage),
    runs: input.runs.map((run) => osRunState(input, run)),
  }
}

function osRunState(input: XoxThreadStateViewInput, run: AgentRunRecord): AgentServerThreadRunState {
  const runState: AgentServerThreadRunState = {
    run: xoxRunToOsRunRecord({
      workspace: input.workspace,
      user: input.user,
      run,
    }),
  }
  const userMessage = input.runInputs.find((item) => item.runId === run.id)?.userMessage
  if (userMessage) {
    runState.request = xoxRunInputToOs({
      workspace: input.workspace,
      user: input.user,
      threadId: run.threadId,
      userMessage,
      automationLevel: run.automationLevel,
      metadata: {
        host: 'xox-model',
        xoxRunId: run.id,
      },
    })
  }
  const actionRequests = input.actionRequests
    .filter((actionRequest) => actionRequest.runId === run.id)
    .map(xoxActionRequestToOsActionRequest)
  if (actionRequests.length > 0) {
    runState.actionRequests = actionRequests
  }
  const events = input.runEvents
    .filter((event) => event.runId === run.id)
    .map(xoxRunEventToOsRunEvent)
  if (events.length > 0) {
    runState.events = events
  }
  return runState
}
