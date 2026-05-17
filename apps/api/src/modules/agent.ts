import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type {
  AgentActionRequest,
  AgentActionUpdatePayload,
  AgentNavigationEvent,
  AgentPlanStep,
  AgentThreadEvent,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import { requireCurrentUser, type CurrentUser } from './auth.js'
import { getWorkspaceForUser } from './workspace.js'
import {
  archiveAgentMemory,
  listAgentMemories,
  rememberFromUserMessage,
  serializeMemory,
} from '../agent/memory.js'
import { agentThreadEvents, type AgentThreadEventSignal } from '../agent/thread-events.js'
import { addRunEvent, listSerializedRunEvents, serializeRunEvent } from '../agent/run-events.js'
import {
  cancelAgentActionRequest,
  confirmAgentActionRequest,
  updateAgentActionRequest,
} from '../agent/action-requests.js'
import {
  deleteAgentProviderSetting,
  getAgentProviderSetting,
  serializeAgentProviderSetting,
  upsertAgentProviderSetting,
} from '../agent/provider-settings.js'
import {
  addMessage,
  buildThreadState,
  buildThreadSummary,
  getOrCreateThread,
  getThreadForUser,
  serializeAction,
  serializeMessage,
  serializePlanStep,
  touchThreadAfterRun,
} from '../agent/thread-store.js'
import {
  cancelRunningAgentRun,
  completeAgentRun,
  createAgentRunController,
  recoverRunningAgentRuns,
  safeRunErrorMessage,
  scheduleAgentRunQueueDrain,
  startAgentRunQueueWorker,
} from '../agent/run-worker.js'

export { recoverRunningAgentRuns } from '../agent/run-worker.js'

const providerSettingSchema = z.object({
  provider: z.string().min(2).max(64),
  baseUrl: z.string().min(1).max(500),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(4096).optional(),
})

function parseAgentBody<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw unprocessable(parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return parsed.data
}

function writeSseEvent(response: ServerResponse, event: string, data: unknown) {
  if (response.destroyed || response.writableEnded) return
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function writeSseComment(response: ServerResponse, comment: string) {
  if (response.destroyed || response.writableEnded) return
  response.write(`: ${comment}\n\n`)
}

async function writeAgentThreadStateEvent(
  response: ServerResponse,
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  threadId: string,
  signal: AgentThreadEventSignal,
) {
  const state = await buildThreadState(db, workspace, user, threadId)
  const event: AgentThreadEvent = {
    type: 'thread_state',
    threadId,
    sequence: signal.sequence,
    reason: signal.reason,
    state,
  }
  writeSseEvent(response, 'thread_state', event)
}

export function registerAgentRoutes(app: FastifyInstance, db: Kysely<Database>, settings: Settings) {
  app.get('/api/v1/agent/threads', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const threads = await db
        .selectFrom('agent_threads')
        .selectAll()
        .where('workspace_id', '=', workspace.id)
        .where('user_id', '=', user.id)
        .orderBy('updated_at', 'desc')
        .limit(30)
        .execute()
      return { threads: await Promise.all(threads.map((thread) => buildThreadSummary(db, thread))) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/threads/:threadId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { threadId } = request.params as { threadId: string }
      return buildThreadState(db, workspace, user, threadId)
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/threads/:threadId/events', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { threadId } = request.params as { threadId: string }
      await getThreadForUser(db, workspace, user, threadId)

      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.flushHeaders?.()

      let closed = false
      let unsubscribe: () => void = () => undefined
      let heartbeat: NodeJS.Timeout | null = null
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }
      const sendState = (signal: AgentThreadEventSignal) => {
        void writeAgentThreadStateEvent(reply.raw, db, workspace, user, threadId, signal).catch((error) => {
          writeSseEvent(reply.raw, 'error', { message: safeRunErrorMessage(error) })
          close()
        })
      }
      unsubscribe = agentThreadEvents.subscribe(threadId, sendState)
      heartbeat = setInterval(() => writeSseComment(reply.raw, 'heartbeat'), 15_000)
      heartbeat.unref?.()

      request.raw.on('close', close)
      request.raw.on('aborted', close)
      sendState({ threadId, sequence: 0, reason: 'thread_restored' })
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/provider-settings', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const setting = await getAgentProviderSetting(db, workspace, user)
      return { setting: setting ? serializeAgentProviderSetting(setting) : null }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.put('/api/v1/agent/provider-settings', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const body = parseAgentBody(providerSettingSchema, request.body)
      const setting = await upsertAgentProviderSetting(db, settings, workspace, user, body)
      return { setting: serializeAgentProviderSetting(setting) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/agent/provider-settings', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      await deleteAgentProviderSetting(db, workspace, user)
      return { ok: true }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/messages', async (request, reply) => {
    let runId: string | null = null
    let activeThread: Row<'agent_threads'> | null = null
    try {
      const body = request.body as { threadId?: string | null; message?: string; background?: boolean }
      const message = body.message?.trim()
      if (!message) throw unprocessable('Message is required')
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const thread = await getOrCreateThread(db, workspace, user, body.threadId)
      activeThread = thread
      runId = newId()
      const now = utcNow()
      await db
        .insertInto('agent_runs')
        .values({
          id: runId,
          thread_id: thread.id,
          user_id: user.id,
          status: 'running',
          input_message_id: null,
          input_message: message,
          planner_source: null,
          worker_id: null,
          lease_expires_at: null,
          heartbeat_at: null,
          created_at: now,
          completed_at: null,
        })
        .execute()
      const userMessage = await addMessage(db, thread.id, 'user', message)
      await db.updateTable('agent_runs').set({ input_message_id: userMessage.id }).where('id', '=', runId).execute()
      const queuedEvent = await addRunEvent(db, {
        threadId: thread.id,
        runId,
        type: 'run_queued',
        title: 'Run 已入队',
        message: body.background === true ? '用户指令已持久化，等待 Agent worker 认领执行。' : '用户指令已持久化，将在当前请求中同步执行。',
        status: 'queued',
        data: { background: body.background === true },
      })
      await rememberFromUserMessage({ db, workspace, user, threadId: thread.id, messageId: userMessage.id, message })

      if (body.background === true) {
        await touchThreadAfterRun(db, thread, message)
        agentThreadEvents.publish(thread.id, 'thread_started')
        scheduleAgentRunQueueDrain(db, settings)
        return {
          threadId: thread.id,
          runId,
          status: 'running' as const,
          planner: null,
          messages: [serializeMessage(userMessage)],
          navigationEvents: [] as AgentNavigationEvent[],
          runEvents: [serializeRunEvent(queuedEvent)],
          planSteps: [] as AgentPlanStep[],
          actionRequests: [] as AgentActionRequest[],
        }
      }

      const controller = createAgentRunController(runId)
      const completed = await completeAgentRun({ db, settings, user, workspace, thread, threadId: thread.id, runId, message, abortSignal: controller.signal })
      if (!completed) return buildThreadState(db, workspace, user, thread.id)
      return {
        threadId: thread.id,
        runId,
        status: 'completed' as const,
        planner: completed.plannerSource,
        messages: [serializeMessage(userMessage), serializeMessage(completed.assistantMessage)],
        navigationEvents: completed.navigationEvents,
        runEvents: await listSerializedRunEvents(db, runId),
        planSteps: completed.planRows.map(serializePlanStep),
        actionRequests: completed.actionRows.map(serializeAction),
      }
    } catch (error) {
      if (runId && activeThread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
        await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', activeThread.id).execute().catch(() => undefined)
        agentThreadEvents.publish(activeThread.id, 'run_failed')
      }
      return reply.send(error)
    }
  })

  app.post('/api/v1/agent/runs/:runId/cancel', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { runId } = request.params as { runId: string }
      const run = await db.selectFrom('agent_runs').selectAll().where('id', '=', runId).executeTakeFirst()
      if (!run) throw notFound('Agent run not found')
      if (run.user_id !== user.id) throw forbidden()
      const thread = await getThreadForUser(db, workspace, user, run.thread_id)
      if (run.status === 'running') {
        await cancelRunningAgentRun(db, thread, run.id, '已取消当前 Agent 运行。', true)
        await recordAudit(db, {
          workspaceId: workspace.id,
          actorId: user.id,
          action: 'agent.run_cancelled',
          entityType: 'agent_run',
          entityId: run.id,
          meta: { provider: settings.llmProvider },
        })
      }
      return buildThreadState(db, workspace, user, thread.id)
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/memories', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const memories = await listAgentMemories(db, workspace, user)
      return { memories: memories.map(serializeMemory) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/agent/memories/:memoryId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { memoryId } = request.params as { memoryId: string }
      await archiveAgentMemory(db, workspace, user, memoryId)
      return { ok: true }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/confirm', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await confirmAgentActionRequest(db, settings, user, actionRequestId)
      agentThreadEvents.publish(result.threadId, 'action_executed')
      return {
        actionRequest: serializeAction(result.actionRequest),
        result: result.result,
        messages: result.messages.map(serializeMessage),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/cancel', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await cancelAgentActionRequest(db, workspace, user, actionRequestId)
      agentThreadEvents.publish(result.threadId, 'action_cancelled')
      return {
        actionRequest: serializeAction(result.actionRequest),
        messages: result.messages.map(serializeMessage),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.patch('/api/v1/agent/action-requests/:actionRequestId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await updateAgentActionRequest(db, workspace, user, actionRequestId, request.body as AgentActionUpdatePayload)
      agentThreadEvents.publish(result.threadId, 'action_updated')
      return {
        actionRequest: serializeAction(result.actionRequest),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  const stopAgentRunQueueWorker = startAgentRunQueueWorker(db, settings)
  app.addHook('onClose', async () => stopAgentRunQueueWorker())
}
