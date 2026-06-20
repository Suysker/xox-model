import { projectAgentServerRunSubmissionView } from '@agentic-os/server'
import type { AgentActionRequest, AgentNavigationEvent, AgentPlanStep, AgentSendResponse } from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { buildAgentAgUiEvents } from '../ag-ui-projection.js'
import { buildAgentTranscriptItems } from '../agent-transcript-projector.js'
import { buildAgentTimelineItems, buildAgentTranscriptNodes } from '../agent-timeline-projector.js'
import {
  sortXoxRunEventsByOsView,
  xoxActionRequestToOsActionRequest,
  xoxCompletedRunResultToOs,
  xoxMessageToOsMessage,
  xoxRunEventToOsRunEvent,
  xoxRunInputToOs,
  xoxRunToOsRunRecord,
} from './xox-agentic-os-facts.js'

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

export function buildSubmittedRunResponse(input: XoxSubmittedRunResponseInput): AgentSendResponse {
  const osRun = xoxRunToOsRunRecord({
    workspace: input.workspace,
    user: input.user,
    run: {
      id: input.runId,
      threadId: input.threadId,
      status: input.status,
      planner: input.planner,
      automationLevel: input.automationLevel,
      goalStatus: null,
      createdAt: input.createdAt,
      completedAt: input.status === 'completed' ? input.createdAt : null,
    },
  })
  const result = xoxCompletedRunResultToOs({
    run: osRun,
    assistantText: input.assistantText,
  })
  const osView = projectAgentServerRunSubmissionView({
    thread: {
      threadId: input.threadId,
    },
    run: osRun,
    request: xoxRunInputToOs({
      workspace: input.workspace,
      user: input.user,
      threadId: input.threadId,
      userMessage: input.userMessage,
      automationLevel: input.automationLevel,
      metadata: {
        host: 'xox-model',
        xoxRunId: input.runId,
      },
    }),
    messages: input.messages.map(xoxMessageToOsMessage),
    actionRequests: input.actionRequests.map(xoxActionRequestToOsActionRequest),
    events: input.runEvents.map(xoxRunEventToOsRunEvent),
    metadata: {
      host: 'xox-model',
      xoxPlanner: input.planner,
      navigationEventCount: input.navigationEvents.length,
      planStepCount: input.planSteps.length,
    },
    ...(result ? { result } : {}),
  })
  const runEvents = sortXoxRunEventsByOsView(input.runEvents, osView.events)
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
