import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type {
  AgentActionRequest,
  AgentActionUpdatePayload,
  AgentNavigationEvent,
  AgentPlannerSource,
  AgentPlanStep,
  AgentThreadEvent,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import { requireCurrentUser, type CurrentUser } from './auth.js'
import { getWorkspaceForUser } from './workspace.js'
import {
  archiveAgentMemory,
  compactThreadContextIfNeeded,
  listAgentMemories,
  rememberFromUserMessage,
  redactSecretLikeContent,
  serializeMemory,
} from '../agent/memory.js'
import {
  AgentRunLeaseLostError,
  claimAgentRunLease,
  claimRecoverableAgentRuns,
  refreshAgentRunLease,
  startAgentRunLeaseHeartbeat,
} from '../agent/run-lease.js'
import { agentThreadEvents, type AgentThreadEventSignal } from '../agent/thread-events.js'
import { addRunEvent, listSerializedRunEvents, serializeRunEvent } from '../agent/run-events.js'
import {
  cancelAgentActionRequest,
  confirmAgentActionRequest,
  updateAgentActionRequest,
} from '../agent/action-requests.js'
import { planResponse, type PlannerContext } from '../agent/planner.js'
import {
  deleteAgentProviderSetting,
  getAgentProviderSetting,
  resolveAgentRuntimeSettings,
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

const activeRunControllers = new Map<string, AbortController>()

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

type AgentRunQueueState = {
  draining: boolean
  scheduled: boolean
  stopped: boolean
  interval: NodeJS.Timeout | null
}

const agentRunQueueStates = new WeakMap<Kysely<Database>, AgentRunQueueState>()

function getAgentRunQueueState(db: Kysely<Database>) {
  let state = agentRunQueueStates.get(db)
  if (!state) {
    state = { draining: false, scheduled: false, stopped: false, interval: null }
    agentRunQueueStates.set(db, state)
  }
  return state
}

type CompletedAgentRun = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'>
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
}

function safeRunErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent run failed'
}

async function failAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  error: unknown,
) {
  const message = safeRunErrorMessage(error)
  await addMessage(db, thread.id, 'assistant', `运行失败：${message}`).catch(() => undefined)
  await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_failed',
    title: '运行失败',
    message,
    status: 'failed',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_failed')
}

async function failInterruptedAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'failed', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await failAgentRun(db, thread, runId, new Error(message))
}

async function cancelRunArtifacts(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
  addAssistantMessage: boolean,
) {
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'cancelled', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await db
    .updateTable('agent_runs')
    .set({ status: 'cancelled', completed_at: now, lease_expires_at: null })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .execute()
  if (addAssistantMessage) await addMessage(db, thread.id, 'assistant', message)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute()
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_cancelled',
    title: '运行已取消',
    message,
    status: 'cancelled',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_cancelled')
}

async function completeAgentRun(ctx: PlannerContext & { thread: Row<'agent_threads'> }): Promise<CompletedAgentRun | null> {
  let stopHeartbeat: (() => void) | null = null
  let runtimeSettings = ctx.settings
  try {
    runtimeSettings = await resolveAgentRuntimeSettings(ctx.db, ctx.settings, ctx.workspace, ctx.user)
    const runtimeCtx: PlannerContext & { thread: Row<'agent_threads'> } = { ...ctx, settings: runtimeSettings }
    const claimed = await claimAgentRunLease(ctx.db, runtimeSettings, ctx.runId)
    if (!claimed) return null
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'worker_claimed',
      title: 'Worker 已认领',
      message: '后台 worker 已取得 run lease，开始执行。同步调用也会经过同一套 lease guard。',
      status: 'running',
    })
    stopHeartbeat = startAgentRunLeaseHeartbeat(ctx.db, runtimeSettings, ctx.runId)
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'model_planning',
      title: '模型规划中',
      message: '正在调用配置的模型，并等待 provider-native tool calls。',
      status: 'running',
      data: { provider: runtimeSettings.llmProvider },
    })
    const planned = await planResponse(runtimeCtx)
    if (!(await refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId))) return null
    const assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', planned.assistant)
    await compactThreadContextIfNeeded({ db: ctx.db, workspace: ctx.workspace, user: ctx.user, threadId: ctx.thread.id })
    if (!(await refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId))) return null
    await ctx.db
      .updateTable('agent_runs')
      .set({ status: 'completed', planner_source: planned.plannerSource, completed_at: utcNow(), lease_expires_at: null })
      .where('id', '=', ctx.runId)
      .where('status', '=', 'running')
      .where('worker_id', '=', runtimeSettings.agentWorkerId)
      .execute()
    await touchThreadAfterRun(ctx.db, ctx.thread, ctx.message)
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'run_completed',
      title: '运行完成',
      message: planned.actionRows.length > 0 ? '模型规划已完成，等待用户处理确认卡。' : '模型规划和只读回答已完成。',
      status: 'completed',
      data: { actionCount: planned.actionRows.length, planStepCount: planned.planRows.length },
    })
    agentThreadEvents.publish(ctx.thread.id, 'run_completed')
    return {
      plannerSource: planned.plannerSource,
      assistantMessage,
      navigationEvents: planned.navigationEvents,
      actionRows: planned.actionRows,
      planRows: planned.planRows,
    }
  } catch (error) {
    if (error instanceof AgentRunLeaseLostError) return null
    if (!(await refreshAgentRunLease(ctx.db, runtimeSettings, ctx.runId).catch(() => false))) {
      return null
    }
    await failAgentRun(ctx.db, ctx.thread, ctx.runId, error)
    throw error
  } finally {
    stopHeartbeat?.()
    activeRunControllers.delete(ctx.runId)
  }
}

async function countRunRows(db: Kysely<Database>, table: 'agent_plan_steps' | 'agent_action_requests', runId: string) {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function recoverRunMessage(db: Kysely<Database>, run: Row<'agent_runs'>) {
  const stored = run.input_message?.trim()
  if (stored) return stored
  if (run.input_message_id) {
    const message = await db
      .selectFrom('agent_messages')
      .select('content')
      .where('id', '=', run.input_message_id)
      .where('role', '=', 'user')
      .executeTakeFirst()
    if (message?.content.trim()) return message.content.trim()
  }
  const fallback = await db
    .selectFrom('agent_messages')
    .select('content')
    .where('thread_id', '=', run.thread_id)
    .where('role', '=', 'user')
    .where('created_at', '<=', run.created_at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return fallback?.content.trim() ?? null
}

export async function recoverRunningAgentRuns(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  if (queueState.draining || queueState.stopped) return 0
  queueState.draining = true
  let started = 0
  try {
    const runs = await claimRecoverableAgentRuns(db, settings)

    for (const run of runs) {
      if (activeRunControllers.has(run.id)) continue
      const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', run.thread_id).executeTakeFirst()
      if (!thread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', run.id).execute()
        continue
      }
      const [workspace, user, planStepCount, actionCount] = await Promise.all([
        db.selectFrom('workspaces').selectAll().where('id', '=', thread.workspace_id).executeTakeFirst(),
        db.selectFrom('users').selectAll().where('id', '=', run.user_id).executeTakeFirst(),
        countRunRows(db, 'agent_plan_steps', run.id),
        countRunRows(db, 'agent_action_requests', run.id),
      ])
      if (!workspace || !user || thread.user_id !== run.user_id) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：用户或工作区已不存在。')
        continue
      }
      if (planStepCount > 0 || actionCount > 0) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 在服务重启时已有部分运行产物，系统已取消未执行确认卡以避免重复执行。请重新发送这条指令。')
        continue
      }
      const message = await recoverRunMessage(db, run)
      if (!message) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：缺少原始用户指令。请重新发送这条指令。')
        continue
      }
      agentThreadEvents.publish(thread.id, 'thread_restored')
      const controller = new AbortController()
      activeRunControllers.set(run.id, controller)
      void completeAgentRun({
        db,
        settings,
        user,
        workspace,
        thread,
        threadId: thread.id,
        runId: run.id,
        message,
        abortSignal: controller.signal,
      }).catch(() => undefined)
      started += 1
    }
    return started
  } finally {
    queueState.draining = false
  }
}

function scheduleAgentRunQueueDrain(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  if (queueState.scheduled || queueState.stopped) return
  queueState.scheduled = true
  const timer = setTimeout(() => {
    queueState.scheduled = false
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, 0)
  timer.unref?.()
}

function startAgentRunQueueWorker(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  queueState.stopped = false
  if (queueState.interval) return () => undefined

  scheduleAgentRunQueueDrain(db, settings)
  queueState.interval = setInterval(() => {
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, settings.agentRunWorkerPollMs)
  queueState.interval.unref?.()

  return () => {
    queueState.stopped = true
    queueState.scheduled = false
    if (queueState.interval) clearInterval(queueState.interval)
    queueState.interval = null
  }
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

      const claimed = await claimAgentRunLease(db, settings, runId)
      if (!claimed) throw conflict('Agent run could not be claimed by this worker')
      const controller = new AbortController()
      activeRunControllers.set(runId, controller)
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
        activeRunControllers.get(run.id)?.abort()
        await cancelRunArtifacts(db, thread, run.id, '已取消当前 Agent 运行。', true)
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
