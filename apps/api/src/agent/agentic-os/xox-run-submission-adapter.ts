import type { Kysely } from 'kysely'
import {
  projectAgentServerSaaSAgUiEvents,
  projectAgentServerSaaSRunSubmissionView,
} from '@agentic-os/server'
import type {
  AgentActionRequest,
  AgentAutomationLevel,
  AgentAgUiEvent,
  AgentNavigationEvent,
  AgentPlanStep,
  AgentSendResponse,
  AgentThreadState,
} from '@xox/contracts'
import { normalizeAgentAutomationLevel } from '@agentic-os/core'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { CurrentUser } from '../../modules/auth.js'
import { addRunEvent, agentThreadEvents, listSerializedRunEvents, serializeRunEvent } from './xox-run-event-store-adapter.js'
import {
  addMessage,
  buildThreadState,
  projectXoxProductViews,
  projectXoxHarnessUi,
  getOrCreateThread,
  serializeAction,
  serializeMessage,
  serializePlanStep,
  touchThreadAfterRun,
  sortXoxRunEventsByOsView,
  xoxActionRequestToOsActionRequest,
  xoxCompletedRunResultToOs,
  xoxMessageToOsMessage,
  xoxRunEventToOsRunEvent,
  xoxRunInputToOs,
  xoxRunToOsRunRecord,
} from './xox-thread-store-adapter.js'
import { createXoxDurableRunStore } from './xox-run-store-adapter.js'

export type SubmitAgentMessageRunInput = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId?: string | null | undefined
  message: string
  background?: boolean | undefined
  automationLevel?: AgentAutomationLevel | undefined
}

type XoxSubmittedRunResponseInput = {
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  createdAt: string
  userMessage: string
  status: AgentSendResponse['status']
  runtimeSource: AgentSendResponse['runtimeSource']
  automationLevel: AgentSendResponse['automationLevel']
  messages: AgentSendResponse['messages']
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentSendResponse['runEvents']
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
  assistantText?: string | undefined
}

function buildSubmittedRunResponse(input: XoxSubmittedRunResponseInput): AgentSendResponse {
  const osRun = xoxRunToOsRunRecord({
    workspace: input.workspace,
    user: input.user,
    run: {
      id: input.runId,
      threadId: input.threadId,
      status: input.status,
      runtimeSource: input.runtimeSource,
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
  const osView = projectAgentServerSaaSRunSubmissionView({
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
    events: input.runEvents.map((event) => xoxRunEventToOsRunEvent(event, osRun.scope)),
    metadata: {
      host: 'xox-model',
      xoxRuntime: input.runtimeSource,
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
  const agUiEvents = projectAgentServerSaaSAgUiEvents(projection, { eventNamePrefix: 'xox' }) as AgentAgUiEvent[]
  const harnessUi = projectXoxHarnessUi({
    threadId: osView.thread.threadId,
    messages: osView.messages,
    runs: [osView.run],
    transcriptItems: osView.transcriptItems,
    runEvents,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  })
  const projected = projectXoxProductViews({
    messages: input.messages,
    osTranscriptItems: osView.transcriptItems,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
    fallbackCreatedAt: input.createdAt,
  })

  return {
    threadId: osView.thread.threadId,
    runId: osView.run.runId,
    status: input.status,
    runtimeSource: input.runtimeSource,
    automationLevel: input.automationLevel,
    messages: input.messages,
    navigationEvents: input.navigationEvents,
    runEvents,
    agUiEvents,
    harnessUi,
    transcriptItems: projected.transcriptItems,
    timelineItems: projected.timelineItems,
    transcriptNodes: projected.transcriptNodes,
    planSteps: input.planSteps,
    actionRequests: input.actionRequests,
  }
}

export async function failSubmittedAgentRun(db: Kysely<Database>, runId: string, thread: Row<'agent_threads'>) {
  await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_failed')
}

export async function submitAgentMessageRun(input: SubmitAgentMessageRunInput): Promise<AgentSendResponse | AgentThreadState> {
  const thread = await getOrCreateThread(input.db, input.workspace, input.user, input.threadId)
  const runId = newId()
  const automationLevel = normalizeAgentAutomationLevel(input.automationLevel)
  try {
    const now = utcNow()
    await input.db
      .insertInto('agent_runs')
      .values({
        id: runId,
        thread_id: thread.id,
        user_id: input.user.id,
        status: 'running',
        input_message_id: null,
        input_message: input.message,
        runtime_source: null,
        automation_level: automationLevel,
        goal_status: null,
        worker_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
        created_at: now,
        completed_at: null,
      })
      .execute()
    const userMessage = await addMessage(input.db, thread.id, 'user', input.message)
    await input.db.updateTable('agent_runs').set({ input_message_id: userMessage.id }).where('id', '=', runId).execute()
    const queuedEvent = await addRunEvent(input.db, {
      threadId: thread.id,
      runId,
      type: 'run_queued',
      title: 'Run 已入队',
      message: input.background === true ? '用户指令已持久化，等待 Agent worker 认领执行。' : '用户指令已持久化，将在当前请求中同步执行。',
      status: 'queued',
      data: { background: input.background === true },
    })

    if (input.background === true) {
      await touchThreadAfterRun(input.db, thread, input.message)
      agentThreadEvents.publish(thread.id, 'thread_started')
      createXoxDurableRunStore(input.db, input.settings).scheduleReady()
      const messages = [serializeMessage(userMessage)]
      const runEvents = [serializeRunEvent(queuedEvent)]
      return buildSubmittedRunResponse({
        workspace: input.workspace,
        user: input.user,
        threadId: thread.id,
        runId,
        createdAt: now,
        userMessage: input.message,
        status: 'running',
        runtimeSource: null,
        automationLevel,
        messages,
        navigationEvents: [],
        runEvents,
        planSteps: [],
        actionRequests: [],
      })
    }

    const completed = await createXoxDurableRunStore(input.db, input.settings).runSubmitted({ runId })
    if (!completed) return buildThreadState(input.db, input.workspace, input.user, thread.id)
    const runEvents = await listSerializedRunEvents(input.db, runId)
    const messages = [
      serializeMessage(userMessage),
      ...(completed.assistantMessage ? [serializeMessage(completed.assistantMessage)] : []),
    ]
    const planSteps = completed.planRows.map(serializePlanStep)
    const actionRequests = completed.actionRows.map(serializeAction)
    return buildSubmittedRunResponse({
      workspace: input.workspace,
      user: input.user,
      threadId: thread.id,
      runId,
      createdAt: now,
      userMessage: input.message,
      status: 'completed',
      runtimeSource: completed.runtimeSource,
      automationLevel,
      messages,
      navigationEvents: completed.navigationEvents,
      runEvents,
      planSteps,
      actionRequests,
      assistantText: completed.assistantMessage?.content,
    })
  } catch (error) {
    await failSubmittedAgentRun(input.db, runId, thread)
    throw error
  }
}
