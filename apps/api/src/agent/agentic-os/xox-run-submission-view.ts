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
import { projectAgentServerRunSubmissionView } from '@agentic-os/server'
import type { AgentActionRequest, AgentNavigationEvent, AgentPlanStep, AgentSendResponse } from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { buildAgentAgUiEvents } from '../ag-ui-projection.js'
import { buildAgentTranscriptItems } from '../agent-transcript-projector.js'
import { buildAgentTimelineItems, buildAgentTranscriptNodes } from '../agent-timeline-projector.js'

export type XoxSubmittedRunResponseInput = {
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  createdAt: string
  userMessage: string
  status: AgentSendResponse['status']
  planner: AgentSendResponse['planner']
  automationLevel: AgentSendResponse['automationLevel']
  messages: AgentSendResponse['messages']
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentSendResponse['runEvents']
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
  assistantText?: string | undefined
}

function osSubmissionScope(input: Pick<XoxSubmittedRunResponseInput, 'workspace' | 'user'>): OsScope {
  return {
    tenantId: input.workspace.owner_id,
    workspaceId: input.workspace.id,
    userId: input.user.id,
  }
}

function osSubmissionRun(input: XoxSubmittedRunResponseInput): OsRunRecord {
  return {
    runId: input.runId,
    threadId: input.threadId,
    scope: osSubmissionScope(input),
    status: input.status,
    createdAt: input.createdAt,
  }
}

function osSubmissionRunInput(input: XoxSubmittedRunResponseInput): OsRunInput {
  return {
    threadId: input.threadId,
    scope: osSubmissionScope(input),
    userMessage: input.userMessage,
    automationLevel: input.automationLevel,
    metadata: {
      host: 'xox-model',
      xoxRunId: input.runId,
    },
  }
}

function osMessage(message: AgentSendResponse['messages'][number]): OsMessage {
  return {
    role: message.role,
    content: message.content,
  }
}

function osActionStatus(status: AgentActionRequest['status']): OsActionRequest['status'] {
  if (status === 'pending') return 'pending'
  if (status === 'confirmed') return 'edited'
  if (status === 'executed') return 'executed'
  if (status === 'failed') return 'failed'
  return 'rejected'
}

function osJsonObject(value: Record<string, unknown>): OsJsonObject {
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

function osActionRequest(action: AgentActionRequest): OsActionRequest {
  const request: OsActionRequest = {
    actionRequestId: action.id,
    runId: action.runId,
    threadId: action.threadId,
    toolCallId: action.id,
    toolName: action.kind,
    status: osActionStatus(action.status),
    title: action.title,
    description: action.summary,
    preview: osJsonObject({
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

function osRunEventChannel(channel: AgentSendResponse['runEvents'][number]['channel']): OsRunEventChannel {
  if (channel === 'assistant' || channel === 'tool' || channel === 'lifecycle') return channel
  return 'technical'
}

function osRunEventType(event: AgentSendResponse['runEvents'][number]): OsRunEventType {
  if (event.type === 'run_queued') return 'run.created'
  if (event.type === 'assistant_final_message' || event.type === 'final_answer_candidate') return 'model.completed'
  if (event.type === 'action_executed' || event.type === 'action_auto_executed') return 'action.executed'
  if (event.type === 'action_cancelled') return 'action.rejected'
  if (event.type === 'action_updated') return 'action.previewed'
  if (event.type.includes('tool')) return 'tool.observed'
  if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') return 'run.finished'
  return 'turn.started'
}

function osRunEvent(event: AgentSendResponse['runEvents'][number]): OsRunEvent {
  return {
    eventId: event.id,
    sequence: event.sequence,
    runId: event.runId,
    threadId: event.threadId,
    type: osRunEventType(event),
    channel: osRunEventChannel(event.channel),
    createdAt: event.createdAt,
    payload: osJsonObject({
      hostEventType: event.type,
      title: event.title,
      message: event.message,
      status: event.status,
      data: event.data ?? null,
    }),
  }
}

function osRunResult(input: XoxSubmittedRunResponseInput, run: OsRunRecord): OsRunResult | undefined {
  if (input.status !== 'completed' || !input.assistantText) return undefined
  return {
    status: 'completed',
    runId: run.runId,
    threadId: run.threadId,
    assistantText: input.assistantText,
    observations: [],
    evidence: [],
  }
}

function sortRunEventsByOsView(
  runEvents: AgentSendResponse['runEvents'],
  osEvents: OsRunEvent[],
): AgentSendResponse['runEvents'] {
  if (runEvents.length !== osEvents.length) return runEvents
  const byId = new Map(runEvents.map((event) => [event.id, event]))
  const sorted = osEvents.map((event) => byId.get(event.eventId))
  if (sorted.some((event) => event === undefined)) return runEvents
  return sorted as AgentSendResponse['runEvents']
}

export function buildSubmittedRunResponse(input: XoxSubmittedRunResponseInput): AgentSendResponse {
  const osRun = osSubmissionRun(input)
  const result = osRunResult(input, osRun)
  const osView = projectAgentServerRunSubmissionView({
    thread: {
      threadId: input.threadId,
    },
    run: osRun,
    request: osSubmissionRunInput(input),
    messages: input.messages.map(osMessage),
    actionRequests: input.actionRequests.map(osActionRequest),
    events: input.runEvents.map(osRunEvent),
    metadata: {
      host: 'xox-model',
      xoxPlanner: input.planner,
      navigationEventCount: input.navigationEvents.length,
      planStepCount: input.planSteps.length,
    },
    ...(result ? { result } : {}),
  })
  const runEvents = sortRunEventsByOsView(input.runEvents, osView.events)
  const projection = {
    thread: { id: osView.thread.threadId },
    messages: input.messages,
    goals: [],
    evaluations: [],
    navigationEvents: input.navigationEvents,
    runEvents,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  }

  return {
    threadId: osView.thread.threadId,
    runId: osView.run.runId,
    status: input.status,
    planner: input.planner,
    automationLevel: input.automationLevel,
    messages: input.messages,
    navigationEvents: input.navigationEvents,
    runEvents,
    agUiEvents: buildAgentAgUiEvents(projection),
    transcriptItems: buildAgentTranscriptItems(projection),
    timelineItems: buildAgentTimelineItems(projection),
    transcriptNodes: buildAgentTranscriptNodes(projection),
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  }
}
