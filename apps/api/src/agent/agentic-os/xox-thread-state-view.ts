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
  AgentThreadState,
  AgentThreadSummary,
} from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import { buildAgentTranscriptItems } from './xox-thread-transcript-adapter.js'
import { buildAgentTimelineItems, buildAgentTranscriptNodes } from './xox-thread-timeline-adapter.js'

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

  return {
    thread: input.thread,
    messages: input.messages,
    runs: input.runs,
    planner: input.planner,
    goals: input.goals,
    evaluations: input.evaluations,
    navigationEvents: input.navigationEvents,
    runEvents,
    agUiEvents: projectAgentServerAgUiEvents(projection, { eventNamePrefix: 'xox' }) as AgentAgUiEvent[],
    transcriptItems: buildAgentTranscriptItems(projection),
    timelineItems: buildAgentTimelineItems(projection),
    transcriptNodes: buildAgentTranscriptNodes(projection),
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
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
