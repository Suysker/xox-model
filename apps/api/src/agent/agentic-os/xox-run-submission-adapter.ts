import type { Kysely } from 'kysely'
import type { AgentSendResponse, AgentThreadState } from '@xox/contracts'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { CurrentUser } from '../../modules/auth.js'
import { addRunEvent, listSerializedRunEvents, serializeRunEvent } from './xox-run-event-store-adapter.js'
import { agentThreadEvents } from './xox-thread-signal-adapter.js'
import {
  addMessage,
  buildThreadState,
  getOrCreateThread,
  serializeAction,
  serializeMessage,
  serializePlanStep,
  touchThreadAfterRun,
} from './xox-thread-store-adapter.js'
import { completeAgentRun, createAgentRunController, scheduleAgentRunQueueDrain } from './xox-run-worker-adapter.js'
import { normalizeAgentAutomationLevel, type AgentAutomationLevel } from '../tool-policy.js'
import { buildSubmittedRunResponse } from './xox-run-submission-view.js'

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

export async function failSubmittedAgentRun(db: Kysely<Database>, runId: string, thread: Row<'agent_threads'>) {
  await db.updateTable('agent_runs').set({ status: 'failed', goal_status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
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
        planner_source: null,
        automation_level: automationLevel,
        goal_status: 'interpreting',
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
      scheduleAgentRunQueueDrain(input.db, input.settings)
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
        planner: null,
        automationLevel,
        messages,
        navigationEvents: [],
        runEvents,
        planSteps: [],
        actionRequests: [],
      })
    }

    const controller = createAgentRunController(input.db, input.settings, runId)
    const completed = await completeAgentRun({
      db: input.db,
      settings: input.settings,
      user: input.user,
      workspace: input.workspace,
      thread,
      threadId: thread.id,
      runId,
      message: input.message,
      automationLevel,
      abortSignal: controller.signal,
    })
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
      planner: completed.plannerSource,
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
