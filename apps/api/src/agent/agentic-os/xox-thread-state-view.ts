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
import { buildAgentTranscriptItems } from '../agent-transcript-projector.js'
import { buildAgentTimelineItems, buildAgentTranscriptNodes } from '../agent-timeline-projector.js'
import {
  sortXoxRunEventsByOsView,
  xoxActionRequestToOsActionRequest,
  xoxMessageToOsMessage,
  xoxRunEventToOsRunEvent,
  xoxRunInputToOs,
  xoxRunToOsRunRecord,
  type XoxAgenticOsUser,
} from './xox-agentic-os-facts.js'

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
