import type { Kysely } from 'kysely'
import type {
  AgentActionKind,
  AgentActionUpdatePayload,
  AgentNavigationEvent,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from '../modules/audit.js'
import type { CurrentUser } from '../modules/auth.js'
import { getWorkspaceForUser } from '../modules/workspace.js'
import { addRunEvent, listSerializedRunEvents } from './run-events.js'
import { addMessage } from './thread-store.js'
import { redactSecretLikeContent } from './memory.js'
import { executeAgentTool } from './tool-executor.js'
import { evaluateAgentGoal } from './completion-evaluator.js'
import { getGoalForRun, serializeEvaluation } from './goal-contract.js'
import { memoryCandidatesFromExecutedActions } from './memory-candidate-detector.js'
import { storeMemoryCandidates } from './memory-consolidator.js'
import {
  assertActionDraftAllowed,
  assertActionExecutionAllowed,
  assertActionUpdateAllowed,
  coerceAgentActionKind,
} from './tool-policy.js'

type RiskLevel = 'low' | 'medium' | 'high'

export type AgentActionDraft = {
  kind: AgentActionKind
  title: string
  summary: string
  targetLabel: string
  riskLevel: RiskLevel
  details: Array<{ label: string; value: string }>
  navigation: AgentNavigationEvent
  payload: unknown
}

export type AgentPlanContext = {
  db: Kysely<Database>
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
}

function safeActionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent action failed'
}

async function getActionRequest(db: Kysely<Database>, actionRequestId: string) {
  const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
  if (!action) throw notFound('Agent action request not found')
  return action
}

async function listPlanStepsForRun(db: Kysely<Database>, runId: string) {
  return db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
}

async function nextEvaluationIteration(db: Kysely<Database>, runId: string) {
  const row = await db
    .selectFrom('agent_evaluations')
    .select(({ fn }) => fn.max<number>('iteration_no').as('maxIteration'))
    .where('run_id', '=', runId)
    .executeTakeFirst()
  return Number(row?.maxIteration ?? 0) + 1
}

function assertActionOwnedByWorkspace(action: Row<'agent_action_requests'>, workspace: Row<'workspaces'>, user: CurrentUser) {
  if (action.workspace_id !== workspace.id || action.user_id !== user.id) throw forbidden()
}

export async function addAgentActionRequest(ctx: AgentPlanContext, draft: AgentActionDraft) {
  assertActionDraftAllowed(draft)
  const id = newId()
  const now = utcNow()
  await ctx.db
    .insertInto('agent_action_requests')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      workspace_id: ctx.workspace.id,
      user_id: ctx.user.id,
      kind: draft.kind,
      status: 'pending',
      title: draft.title,
      summary: draft.summary,
      target_label: draft.targetLabel,
      risk_level: draft.riskLevel,
      details_json: jsonString(draft.details),
      navigation_json: jsonString(draft.navigation),
      payload_json: jsonString(draft.payload),
      created_at: now,
      executed_at: null,
      error_message: null,
    })
    .execute()
  return ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function executeAgentActionRequest(db: Kysely<Database>, settings: Settings, user: CurrentUser, action: Row<'agent_action_requests'>) {
  const workspace = await getWorkspaceForUser(db, user)
  await assertActionExecutionAllowed(db, workspace, user, action)
  const result = await executeAgentTool(db, workspace, user, action)

  await db
    .updateTable('agent_action_requests')
    .set({ status: 'executed', executed_at: utcNow(), error_message: null })
    .where('id', '=', action.id)
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'executed', updated_at: utcNow() })
    .where('action_request_id', '=', action.id)
    .execute()
  await recordAudit(db, {
    workspaceId: workspace.id,
    actorId: user.id,
    action: 'agent.action_executed',
    entityType: 'agent_action_request',
    entityId: action.id,
    meta: { kind: action.kind, provider: settings.llmProvider },
  })
  return result
}

export async function confirmAgentActionRequest(db: Kysely<Database>, settings: Settings, user: CurrentUser, actionRequestId: string) {
  const action = await getActionRequest(db, actionRequestId)
  const workspace = await getWorkspaceForUser(db, user)
  assertActionOwnedByWorkspace(action, workspace, user)
  let result: unknown
  try {
    result = await executeAgentActionRequest(db, settings, user, action)
  } catch (executionError) {
    const message = safeActionErrorMessage(executionError)
    await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute().catch(() => undefined)
    await addRunEvent(db, {
      threadId: action.thread_id,
      runId: action.run_id,
      type: 'action_execution_failed',
      title: '确认卡执行失败',
      message: `${action.title}：${message}`,
      status: 'failed',
      data: { actionKind: action.kind },
    }).catch(() => undefined)
    throw executionError
  }

  const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
  const goal = await getGoalForRun(db, action.run_id)
  if (goal) {
    const iteration = await nextEvaluationIteration(db, action.run_id)
    const evaluationRow = await evaluateAgentGoal({ db, workspace, goal, iteration })
    const evaluation = serializeEvaluation(evaluationRow)
    await addRunEvent(db, {
      threadId: action.thread_id,
      runId: action.run_id,
      type: 'goal_evaluated',
      title: 'Completion Evaluator 已复核',
      message: evaluation.status === 'pass'
        ? '确认卡执行后，Completion Evaluator 已确认目标满足验收条件。'
        : `确认卡执行后仍需处理：${evaluation.unsatisfiedCriteria.map((item) => item.message).join('；') || evaluation.status}`,
      status: evaluation.status === 'pass' ? 'completed' : evaluation.status === 'needs_confirmation' ? 'blocked' : evaluation.status === 'failed' || evaluation.status === 'blocked' ? 'failed' : 'info',
      data: { goalId: goal.id, iteration, evaluationStatus: evaluation.status },
    })
  }
  const storedMemories = await storeMemoryCandidates({
    db,
    workspace,
    user,
    threadId: action.thread_id,
    runId: action.run_id,
    candidates: memoryCandidatesFromExecutedActions({ runId: action.run_id, actionRows: [updated] }),
  })
  if (storedMemories.length > 0) {
    await addRunEvent(db, {
      threadId: action.thread_id,
      runId: action.run_id,
      type: 'memory_consolidated',
      title: '主动记忆已沉淀',
      message: `已从确认卡执行结果沉淀 ${storedMemories.length} 条记忆候选。`,
      status: 'info',
      data: { memoryCount: storedMemories.length },
    })
  }
  const planSteps = await listPlanStepsForRun(db, action.run_id)
  const assistant = await addMessage(db, action.thread_id, 'assistant', `已执行：${action.title}`)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
  await addRunEvent(db, {
    threadId: action.thread_id,
    runId: action.run_id,
    type: 'action_executed',
    title: '确认卡已执行',
    message: `已执行：${action.title}`,
    status: 'completed',
    data: { actionKind: action.kind },
  })
  return {
    actionRequest: updated,
    result,
    messages: [assistant],
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps,
    threadId: action.thread_id,
  }
}

export async function cancelAgentActionRequest(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, actionRequestId: string) {
  const action = await getActionRequest(db, actionRequestId)
  assertActionOwnedByWorkspace(action, workspace, user)
  if (action.status !== 'pending') throw conflict('Agent action is not pending')

  await db.updateTable('agent_action_requests').set({ status: 'cancelled' }).where('id', '=', action.id).execute()
  await db.updateTable('agent_plan_steps').set({ status: 'cancelled', updated_at: utcNow() }).where('action_request_id', '=', action.id).execute()
  const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
  const planSteps = await listPlanStepsForRun(db, action.run_id)
  const assistant = await addMessage(db, action.thread_id, 'assistant', `已取消：${action.title}`)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
  await addRunEvent(db, {
    threadId: action.thread_id,
    runId: action.run_id,
    type: 'action_cancelled',
    title: '确认卡已取消',
    message: `已取消：${action.title}`,
    status: 'cancelled',
    data: { actionKind: action.kind },
  })
  return {
    actionRequest: updated,
    messages: [assistant],
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps,
    threadId: action.thread_id,
  }
}

export async function updateAgentActionRequest(
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
  await addRunEvent(db, {
    threadId: action.thread_id,
    runId: action.run_id,
    type: 'action_updated',
    title: '确认卡已编辑',
    message: `确认卡已编辑：${updated.title}`,
    status: 'info',
    data: { actionKind: action.kind },
  })
  return {
    actionRequest: updated,
    runEvents: await listSerializedRunEvents(db, action.run_id),
    planSteps,
    threadId: action.thread_id,
  }
}
