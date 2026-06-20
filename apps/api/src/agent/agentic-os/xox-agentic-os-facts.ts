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
import type { AgentActionRequest, AgentMessage, AgentRunEvent, AgentRunRecord } from '@xox/contracts'
import type { Row } from '../../db/schema.js'

export type XoxAgenticOsUser = {
  id: string
}

export type XoxAgenticOsScopeInput = {
  workspace: Row<'workspaces'>
  user: XoxAgenticOsUser
}

export function xoxAgenticOsScope(input: XoxAgenticOsScopeInput): OsScope {
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

export function xoxJsonObject(value: Record<string, unknown>): OsJsonObject {
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
