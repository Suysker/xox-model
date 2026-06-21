import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { AgentActionUpdatePayload, AgentNavigationEvent } from '@xox/contracts'
import { agentServerRunLifecycleEvents } from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from '../modules/audit.js'
import type { CurrentUser } from '../modules/auth.js'
import { requireCurrentUser } from '../modules/auth.js'
import { getWorkspaceForUser } from '../modules/workspace.js'
import {
  archiveAgentMemory,
  promoteAgentMemory,
  redactSecretLikeContent,
  serializeMemory,
} from './memory.js'
import { buildTenantMemoryCenterState } from './memory/memory-center.js'
import { agentThreadEvents } from './agentic-os/xox-thread-signal-adapter.js'
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
} from './agentic-os/xox-thread-store-adapter.js'
import {
  cancelRunningAgentRun,
  startAgentRunQueueWorker,
} from './agentic-os/xox-run-worker-adapter.js'
import { openAgentThreadStateStream } from './agentic-os/xox-thread-state-stream-adapter.js'
import { submitAgentMessageRun } from './agentic-os/xox-run-submission-adapter.js'
import { addRunEvent, listSerializedRunEvents } from './agentic-os/xox-run-event-store-adapter.js'
import { addMessage } from './agentic-os/xox-thread-store-adapter.js'
import { resumeXoxAgenticOsRunAfterActionConfirmation } from './agentic-os/xox-agentic-os-host-kit.js'
import { consolidateAgentMemoryCandidates } from './memory-consolidator.js'
import {
  memoryCandidateFromCancelledAction,
  memoryCandidateFromEditedAction,
} from './memory-candidate-detector.js'
import {
  assertActionUpdateAllowed,
  coerceAgentActionKind,
} from './tool-policy.js'

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

type RiskLevel = 'low' | 'medium' | 'high'

function previewValue(value: unknown) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return redactSecretLikeContent((raw ?? '').slice(0, 260))
}

function changedField(label: string, before: unknown, after: unknown) {
  const beforePreview = previewValue(before)
  const afterPreview = previewValue(after)
  if (beforePreview === afterPreview) return null
  return { label, value: `${beforePreview || '空'} -> ${afterPreview || '空'}` }
}

function actionUpdateChanges(before: Row<'agent_action_requests'>, after: Row<'agent_action_requests'>) {
  const beforeDetails = parseJson<unknown>(before.details_json, null)
  const afterDetails = parseJson<unknown>(after.details_json, null)
  const beforePayload = parseJson<unknown>(before.payload_json, null)
  const afterPayload = parseJson<unknown>(after.payload_json, null)
  return [
    changedField('标题', before.title, after.title),
    changedField('摘要', before.summary, after.summary),
    changedField('目标', before.target_label, after.target_label),
    changedField('风险', before.risk_level, after.risk_level),
    changedField('明细', beforeDetails, afterDetails),
    changedField('执行载荷', beforePayload, afterPayload),
  ].filter((item): item is { label: string; value: string } => Boolean(item))
}

async function getActionRequest(db: Kysely<Database>, actionRequestId: string) {
  const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
  if (!action) throw notFound('Agent action request not found')
  return action
}

async function listPlanStepsForRun(db: Kysely<Database>, runId: string) {
  return db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
}

function assertActionOwnedByWorkspace(action: Row<'agent_action_requests'>, workspace: Row<'workspaces'>, user: CurrentUser) {
  if (action.workspace_id !== workspace.id || action.user_id !== user.id) throw forbidden()
}

function safeActionRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent action failed'
}

async function confirmAgentActionRequest(db: Kysely<Database>, settings: Settings, user: CurrentUser, actionRequestId: string) {
  const action = await getActionRequest(db, actionRequestId)
  const workspace = await getWorkspaceForUser(db, user)
  assertActionOwnedByWorkspace(action, workspace, user)
  const resumed = await resumeXoxAgenticOsRunAfterActionConfirmation({
    db,
    settings,
    user,
    workspace,
    action,
  }).catch(async (executionError) => {
    const message = safeActionRouteErrorMessage(executionError)
    const latestAction = await db
      .selectFrom('agent_action_requests')
      .select(['status'])
      .where('id', '=', action.id)
      .executeTakeFirst()
    await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute().catch(() => undefined)
    if (latestAction?.status !== 'executed') {
      await addRunEvent(db, agentServerRunLifecycleEvents.actionExecutionFailed({
        threadId: action.thread_id,
        runId: action.run_id,
        actionRequestId: action.id,
        actionKind: action.kind,
        actionTitle: action.title,
        errorMessage: message,
        copy: {
          title: '确认卡执行失败',
          message: `${action.title}：${message}`,
        },
      })).catch(() => undefined)
    }
    throw executionError
  })

  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
  return {
    actionRequest: resumed.actionRequest,
    result: resumed.actionResult,
    messages: resumed.runResult?.assistantMessage ? [resumed.runResult.assistantMessage] : [],
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps: await listPlanStepsForRun(db, action.run_id),
    threadId: action.thread_id,
  }
}

async function cancelAgentActionRequest(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, actionRequestId: string) {
  const action = await getActionRequest(db, actionRequestId)
  assertActionOwnedByWorkspace(action, workspace, user)
  if (action.status !== 'pending') throw conflict('Agent action is not pending')

  await db.updateTable('agent_action_requests').set({ status: 'cancelled' }).where('id', '=', action.id).execute()
  await db.updateTable('agent_plan_steps').set({ status: 'cancelled', updated_at: utcNow() }).where('action_request_id', '=', action.id).execute()
  const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
  const planSteps = await listPlanStepsForRun(db, action.run_id)
  const assistant = await addMessage(db, action.thread_id, 'assistant', `已取消：${action.title}`)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
  await addRunEvent(db, agentServerRunLifecycleEvents.actionCancelled({
    threadId: action.thread_id,
    runId: action.run_id,
    actionRequestId: action.id,
    actionKind: action.kind,
    actionTitle: action.title,
    copy: {
      title: '确认卡已取消',
      message: `已取消：${action.title}`,
    },
  }))
  await consolidateAgentMemoryCandidates({
    db,
    workspace,
    user,
    threadId: action.thread_id,
    runId: action.run_id,
    candidates: [memoryCandidateFromCancelledAction({ runId: action.run_id, action: updated })],
    title: '取消动作已进入记忆候选',
    message: '用户取消确认卡的事实已作为带证据的纠错记忆候选保存。',
  })
  return {
    actionRequest: updated,
    messages: [assistant],
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps,
    threadId: action.thread_id,
  }
}

async function updateAgentActionRequest(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  actionRequestId: string,
  body: AgentActionUpdatePayload,
) {
  const action = await getActionRequest(db, actionRequestId)
  assertActionOwnedByWorkspace(action, workspace, user)
  if (action.status !== 'pending') throw conflict('Agent action is not pending')

  const update: Partial<Row<'agent_action_requests'>> = {}
  if (typeof body.title === 'string') update.title = body.title.slice(0, 180)
  if (typeof body.summary === 'string') update.summary = body.summary
  if (typeof body.targetLabel === 'string') update.target_label = body.targetLabel.slice(0, 180)
  if (body.riskLevel && ['low', 'medium', 'high'].includes(body.riskLevel)) update.risk_level = body.riskLevel
  if (Array.isArray(body.details)) update.details_json = jsonString(body.details)
  if (body.navigation) update.navigation_json = jsonString(body.navigation)
  if ('payload' in body) update.payload_json = jsonString(body.payload)
  if (Object.keys(update).length === 0) throw unprocessable('No editable fields provided')

  const policyUpdate: { riskLevel?: RiskLevel; navigation?: AgentNavigationEvent } = {}
  if (update.risk_level) policyUpdate.riskLevel = update.risk_level as RiskLevel
  if (body.navigation) policyUpdate.navigation = body.navigation
  assertActionUpdateAllowed(coerceAgentActionKind(action.kind), policyUpdate)

  await db.updateTable('agent_action_requests').set(update).where('id', '=', action.id).execute()
  const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
  const changes = actionUpdateChanges(action, updated)
  await db
    .updateTable('agent_plan_steps')
    .set({
      title: updated.title,
      description: updated.summary,
      navigation_json: updated.navigation_json,
      updated_at: utcNow(),
    })
    .where('action_request_id', '=', action.id)
    .execute()
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
  const planSteps = await listPlanStepsForRun(db, action.run_id)
  await addRunEvent(db, agentServerRunLifecycleEvents.actionUpdated({
    threadId: action.thread_id,
    runId: action.run_id,
    actionRequestId: action.id,
    actionKind: action.kind,
    actionTitle: updated.title,
    changes,
    copy: {
      title: '确认卡已编辑',
      message: `确认卡已编辑：${updated.title}`,
    },
  }))
  await consolidateAgentMemoryCandidates({
    db,
    workspace,
    user,
    threadId: action.thread_id,
    runId: action.run_id,
    candidates: [memoryCandidateFromEditedAction({ runId: action.run_id, action: updated })],
    title: '编辑动作已进入记忆候选',
    message: '用户编辑确认卡的事实已作为带证据的纠错记忆候选保存。',
  })
  return {
    actionRequest: updated,
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps,
    threadId: action.thread_id,
  }
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
      const query = request.query as { query?: string; q?: string; lane?: string; status?: string }
      const search = (query.query ?? query.q ?? '').trim()
      return buildTenantMemoryCenterState({
        db,
        workspace,
        user,
        query: search,
        ...(query.lane ? { lane: query.lane } : {}),
        ...(query.status ? { status: query.status } : {}),
      })
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/memories/:memoryId/promote', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { memoryId } = request.params as { memoryId: string }
      const memory = await promoteAgentMemory(db, workspace, user, memoryId)
      return { memory: serializeMemory(memory) }
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
