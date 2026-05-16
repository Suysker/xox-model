import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig } from '@xox/domain'
import type {
  AgentActionKind,
  AgentActionUpdatePayload,
  AgentNavigationEvent,
  AgentPlanStepStatus,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from '../modules/audit.js'
import type { CurrentUser } from '../modules/auth.js'
import {
  deleteVersion,
  getWorkspaceDraft,
  getWorkspaceForUser,
  importWorkspaceBundle,
  publishVersion,
  rollbackToVersion,
  saveDraft,
} from '../modules/workspace.js'
import {
  createActualEntry,
  restoreEntry,
  setPeriodStatus,
  updateActualEntry,
  voidEntry,
} from '../modules/ledger.js'
import { createVersionShare, revokeVersionShare } from '../modules/share.js'
import { addRunEvent, listSerializedRunEvents } from './run-events.js'
import { addMessage } from './thread-store.js'
import { redactSecretLikeContent } from './memory.js'
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

export type AddAgentPlanStepInput = {
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  actionRequestId?: string | null
  navigation?: AgentNavigationEvent | null
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

export async function addAgentPlanStep(ctx: AgentPlanContext, input: AddAgentPlanStepInput) {
  const id = newId()
  const now = utcNow()
  await ctx.db
    .insertInto('agent_plan_steps')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      action_request_id: input.actionRequestId ?? null,
      sequence_no: input.sequence,
      title: input.title,
      description: input.description,
      status: input.status,
      navigation_json: input.navigation ? jsonString(input.navigation) : null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function executeAgentActionRequest(db: Kysely<Database>, settings: Settings, user: CurrentUser, action: Row<'agent_action_requests'>) {
  const workspace = await getWorkspaceForUser(db, user)
  await assertActionExecutionAllowed(db, workspace, user, action)
  const payload = parseJson<any>(action.payload_json, {})
  let result: unknown = null

  if (action.kind === 'ledger.create_entry') {
    result = await createActualEntry(db, { workspace, actor: user, ...payload })
  } else if (action.kind === 'ledger.update_entry') {
    result = await updateActualEntry(db, { workspace, actor: user, entryId: payload.entryId, ...payload })
  } else if (action.kind === 'ledger.void_entry') {
    await voidEntry(db, workspace, payload.entryId, user.id)
    result = { ok: true }
  } else if (action.kind === 'ledger.restore_entry') {
    await restoreEntry(db, workspace, payload.entryId, user.id)
    result = { ok: true }
  } else if (action.kind === 'workspace.update_draft') {
    result = await saveDraft(db, { workspace, actor: user, revision: payload.revision, workspaceName: payload.workspaceName, config: hydrateModelConfig(payload.config) })
  } else if (action.kind === 'workspace.save_snapshot') {
    result = await publishVersion(db, { workspace, actor: user, kind: 'snapshot' })
  } else if (action.kind === 'workspace.publish_release') {
    const version = await publishVersion(db, { workspace, actor: user, kind: 'release' })
    result = { version }
    if (payload.createShare) {
      result = { version, share: await createVersionShare(db, { workspace: { ...workspace, active_version_id: version.id }, actor: user, versionId: version.id }) }
    }
  } else if (action.kind === 'workspace.rollback_version') {
    result = await rollbackToVersion(db, { workspace, actor: user, versionId: payload.versionId })
  } else if (action.kind === 'workspace.delete_version') {
    await deleteVersion(db, workspace, payload.versionId)
    result = { ok: true }
  } else if (action.kind === 'workspace.reset_draft') {
    const draft = await getWorkspaceDraft(db, workspace)
    result = await saveDraft(db, { workspace, actor: user, revision: draft.revision, workspaceName: '默认工作区', config: createProductDefaultModel() })
  } else if (action.kind === 'workspace.import_bundle') {
    result = await importWorkspaceBundle(db, { workspace, actor: user, bundle: payload.bundle })
  } else if (action.kind === 'ledger.lock_period') {
    result = await setPeriodStatus(db, workspace, payload.periodId, user.id, 'locked')
  } else if (action.kind === 'ledger.unlock_period') {
    result = await setPeriodStatus(db, workspace, payload.periodId, user.id, 'open')
  } else if (action.kind === 'share.create') {
    result = await createVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
  } else if (action.kind === 'share.revoke') {
    await revokeVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
    result = { ok: true }
  } else {
    throw unprocessable(`Unsupported agent action: ${action.kind}`)
  }

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
