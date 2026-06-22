import type { Kysely } from 'kysely'
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
  AgentPlanStepStatus,
  AgentRunEvent,
  AgentRunRecord,
  AgentTimelineItem,
  AgentTranscriptItem,
  AgentTranscriptNode,
  AgentThreadState,
  AgentThreadSummary,
} from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import { parseJson } from '../../db/database.js'
import { forbidden, notFound } from '../../core/http.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import { normalizeGoalStatus, serializeEvaluation, serializeGoal } from './xox-goal-store-adapter.js'
import { coerceAgentActionKind, normalizeAgentAutomationLevel } from '../tool-policy.js'
import { serializeRunEvent } from './xox-run-event-store-adapter.js'

export type AgentThreadUser = {
  id: string
}

export function serializeAction(row: Row<'agent_action_requests'>): AgentActionRequest {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: coerceAgentActionKind(row.kind),
    status: row.status as AgentActionRequest['status'],
    title: row.title,
    summary: row.summary,
    targetLabel: row.target_label,
    riskLevel: row.risk_level as AgentActionRequest['riskLevel'],
    details: parseJson<Array<{ label: string; value: string }>>(row.details_json, []),
    navigation: parseJson<AgentNavigationEvent>(row.navigation_json, {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      reason: '默认打开经营总览。',
    }),
    payload: parseJson<unknown>(row.payload_json, null),
    createdAt: row.created_at,
    executedAt: row.executed_at,
    errorMessage: row.error_message,
  }
}

export function serializePlanStep(row: Row<'agent_plan_steps'>): AgentPlanStep {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    actionRequestId: row.action_request_id,
    sequence: row.sequence_no,
    title: row.title,
    description: row.description,
    status: row.status as AgentPlanStepStatus,
    navigation: row.navigation_json ? parseJson<AgentNavigationEvent | null>(row.navigation_json, null) : null,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    toolArguments: row.tool_arguments_json ? parseJson<Record<string, unknown>>(row.tool_arguments_json, {}) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageRole(value: string): AgentMessage['role'] {
  return value === 'assistant' || value === 'system' ? value : 'user'
}

export function serializeMessage(row: Row<'agent_messages'>): AgentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: messageRole(row.role),
    content: row.content,
    createdAt: row.created_at,
  }
}

function plannerSource(value: string | null): AgentPlannerSource | null {
  return value === 'openai_agents' || value === 'openai_compatible_tool_calls' || value === 'rules'
    ? value
    : null
}

function runStatus(value: string): AgentRunRecord['status'] {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value
  return 'running'
}

export function serializeRun(row: Row<'agent_runs'>): AgentRunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: runStatus(row.status),
    planner: plannerSource(row.planner_source),
    automationLevel: normalizeAgentAutomationLevel(row.automation_level),
    goalStatus: normalizeGoalStatus(row.goal_status),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function threadTitleFromMessage(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized || 'Agent 对话'
}

export async function getOrCreateThread(db: Kysely<Database>, workspace: Row<'workspaces'>, user: AgentThreadUser, threadId?: string | null) {
  if (threadId) {
    const existing = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
    if (!existing) throw notFound('Agent thread not found')
    if (existing.workspace_id !== workspace.id || existing.user_id !== user.id) throw forbidden()
    return existing
  }

  const now = utcNow()
  const id = newId()
  await db
    .insertInto('agent_threads')
    .values({
      id,
      workspace_id: workspace.id,
      user_id: user.id,
      title: 'Agent 对话',
      created_at: now,
      updated_at: now,
    })
    .execute()
  return db.selectFrom('agent_threads').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function getThreadForUser(db: Kysely<Database>, workspace: Row<'workspaces'>, user: AgentThreadUser, threadId: string) {
  const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
  if (!thread) throw notFound('Agent thread not found')
  if (thread.workspace_id !== workspace.id || thread.user_id !== user.id) throw forbidden()
  return thread
}

export async function addMessage(db: Kysely<Database>, threadId: string, role: 'user' | 'assistant' | 'system', content: string) {
  const id = newId()
  await db
    .insertInto('agent_messages')
    .values({
      id,
      thread_id: threadId,
      role,
      content,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function buildThreadSummary(db: Kysely<Database>, thread: Row<'agent_threads'>): Promise<AgentThreadSummary> {
  const [lastMessage, latestRun, pendingActions] = await Promise.all([
    db
      .selectFrom('agent_messages')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_action_requests')
      .select('id')
      .where('thread_id', '=', thread.id)
      .where('status', '=', 'pending')
      .execute(),
  ])
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    lastMessage: lastMessage?.content ?? null,
    lastMessageAt: lastMessage?.created_at ?? null,
    latestRunStatus: latestRun ? runStatus(latestRun.status) : null,
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    pendingActionCount: pendingActions.length,
  }
}

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

type XoxThreadStateViewInput = {
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
  messages: AgentMessage[]
  osTranscriptItems: OsTranscriptItem[]
  actionRequests: AgentActionRequest[]
  fallbackCreatedAt: string
}

function buildXoxThreadStateView(input: XoxThreadStateViewInput): AgentThreadState {
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

export async function buildThreadState(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: AgentThreadUser,
  threadId: string,
): Promise<AgentThreadState> {
  const thread = await getThreadForUser(db, workspace, user, threadId)
  const [messages, runs, actions] = await Promise.all([
    db.selectFrom('agent_messages').selectAll().where('thread_id', '=', thread.id).orderBy('created_at', 'asc').execute(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .execute(),
  ])
  const latestRun = runs[0] ?? null
  const [planSteps, runEvents, goals, evaluations] = latestRun
    ? await Promise.all([
        db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', latestRun.id).orderBy('sequence_no', 'asc').execute(),
        db.selectFrom('agent_run_events').selectAll().where('run_id', '=', latestRun.id).orderBy('sequence_no', 'asc').execute(),
        db.selectFrom('agent_goals').selectAll().where('run_id', '=', latestRun.id).orderBy('created_at', 'asc').execute(),
        db.selectFrom('agent_evaluations')
          .selectAll()
          .where('run_id', '=', latestRun.id)
          .orderBy((eb) => eb.case().when('status', '=', 'pass').then(1).else(0).end(), 'asc')
          .orderBy('iteration_no', 'asc')
          .execute(),
      ])
    : [[], [], [], []] as [Row<'agent_plan_steps'>[], Row<'agent_run_events'>[], Row<'agent_goals'>[], Row<'agent_evaluations'>[]]
  const navigationEvents = planSteps
    .map((step) => (step.navigation_json ? parseJson<AgentNavigationEvent | null>(step.navigation_json, null) : null))
    .filter((event): event is AgentNavigationEvent => Boolean(event))

  return buildXoxThreadStateView({
    workspace,
    user,
    thread: await buildThreadSummary(db, thread),
    messages: messages.map(serializeMessage),
    runs: runs.map(serializeRun),
    runInputs: runs.map((run) => ({
      runId: run.id,
      userMessage: run.input_message,
    })),
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    goals: (goals as Row<'agent_goals'>[]).map(serializeGoal) as AgentGoalRecord[],
    evaluations: (evaluations as Row<'agent_evaluations'>[]).map(serializeEvaluation) as AgentEvaluationResult[],
    navigationEvents,
    runEvents: runEvents.map(serializeRunEvent),
    planSteps: planSteps.map(serializePlanStep),
    actionRequests: actions.map(serializeAction),
  })
}

export async function touchThreadAfterRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  message: string,
) {
  await db
    .updateTable('agent_threads')
    .set({
      title: thread.title === 'Agent 对话' ? threadTitleFromMessage(message) : thread.title,
      updated_at: utcNow(),
    })
    .where('id', '=', thread.id)
    .execute()
}
