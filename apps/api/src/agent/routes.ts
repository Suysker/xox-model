import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { AgentActionUpdatePayload } from '@xox/contracts'
import type { Database } from '../db/schema.js'
import { forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { recordAudit } from '../modules/audit.js'
import { requireCurrentUser } from '../modules/auth.js'
import { getWorkspaceForUser } from '../modules/workspace.js'
import {
  archiveAgentMemory,
  listAgentMemories,
  serializeMemory,
} from './memory.js'
import { retrieveAgentMemories } from './memory-retriever.js'
import { agentThreadEvents } from './thread-events.js'
import {
  cancelAgentActionRequest,
  confirmAgentActionRequest,
  updateAgentActionRequest,
} from './approval-executor.js'
import {
  deleteAgentProviderSetting,
  getAgentProviderSetting,
  probeAgentProviderSetting,
  serializeAgentProviderSetting,
  upsertAgentProviderSetting,
} from './provider-settings.js'
import {
  buildThreadState,
  buildThreadSummary,
  getThreadForUser,
  serializeAction,
  serializeMessage,
  serializePlanStep,
} from './thread-store.js'
import {
  cancelRunningAgentRun,
  startAgentRunQueueWorker,
} from './run-worker.js'
import { openAgentThreadStateStream } from './thread-state-stream.js'
import { submitAgentMessageRun } from './run-submission.js'

const providerSettingSchema = z.object({
  provider: z.string().min(2).max(64),
  baseUrl: z.string().min(1).max(500),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(4096).optional(),
})
const providerProbeSchema = z.object({
  provider: z.string().min(2).max(64).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(128).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
})

function parseAgentBody<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw unprocessable(parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return parsed.data
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
      openAgentThreadStateStream({ request: request.raw, response: reply.raw, db, workspace, user, threadId })
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/threads/:threadId/ag-ui-events', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { threadId } = request.params as { threadId: string }
      const state = await buildThreadState(db, workspace, user, threadId)
      return { events: state.agUiEvents, transcriptItems: state.transcriptItems, timelineItems: state.timelineItems, transcriptNodes: state.transcriptNodes }
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

  app.post('/api/v1/agent/provider-settings/probe', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const body = parseAgentBody(providerProbeSchema, request.body ?? {})
      const probe = await probeAgentProviderSetting(db, settings, workspace, user, body)
      return { probe }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/messages', async (request, reply) => {
    try {
      const body = request.body as { threadId?: string | null; message?: string; background?: boolean; automationLevel?: 'manual' | 'low' | 'medium' | 'high' }
      const message = body.message?.trim()
      if (!message) throw unprocessable('Message is required')
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      return submitAgentMessageRun({ db, settings, user, workspace, threadId: body.threadId, message, background: body.background, automationLevel: body.automationLevel })
    } catch (error) {
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
      const query = request.query as { query?: string; q?: string }
      const search = (query.query ?? query.q ?? '').trim()
      const memories = search
        ? (await retrieveAgentMemories({ db, workspace, user, query: search, limit: 30, includeCandidates: true })).map((result) => result.memory)
        : await listAgentMemories(db, workspace, user)
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
