import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig } from '@xox/domain'
import type {
  AgentActionAuditRecord,
  AgentActionExecutionInput,
  AgentActionExecutionResult,
  AgentActionRequest,
  AgentActionStatus,
  JsonObject,
  JsonValue,
} from '@agentic-os/contracts'
import {
  createAgentServerSaaSBusinessToolRuntime,
  createAgentServerSaaSTenantMemoryToolRuntime,
} from '@agentic-os/server'
import type { AgentServerTenantMemoryToolItem } from '@agentic-os/server'
import { createAgenticSandboxAggregateActionExecutor } from '@agentic-os/sandbox'
import { isAgentHostToolActionDraft, type HostObservationBridge } from '@agentic-os/core'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { recordAudit } from '../modules/audit.js'
import {
  deleteVersion,
  getWorkspaceForUser,
  getWorkspaceDraft,
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
import {
  captureTenantMemory,
  getTenantMemory,
  redactSecretLikeContent,
  searchTenantMemory,
} from './memory.js'
import { assertActionExecutionAllowed } from './tool-policy.js'
import {
  xoxNavigationFromTabs,
} from './host-profile/xox-planned-items.js'
import type {
  AgentActionDraft,
  ActionDraftBuilderHandlers,
  AgentToolObservation,
  PlannedItem,
  PlannerContext,
  ReadDraft,
  RuntimePlannerStep,
} from './host-profile/xox-planned-items.js'
import {
  planGenericLedgerCreateFromStep,
  planLedgerCreateFromFields,
  planLedgerRestoreFromStep,
  planLedgerUpdateFromStep,
  planLedgerVoidFromStep,
  planPeriodLockFromStep,
  planPlannedMemberIncomeBatch,
  planPlannedRelatedExpenseBatch,
} from './ledger-action-drafts.js'
import {
  buildPublishReleaseDraft,
  planDeleteVersionAction,
  planPromoteVersionAction,
  planResetDraftAction,
  planRollbackVersionAction,
  planSaveSnapshotAction,
  planShareAction,
} from './version-action-drafts.js'
import {
  planAddCostItemFromStep,
  planAddEmployeeFromStep,
  planAddShareholderFromStep,
  planAddStageCostTypeFromStep,
  planAddTeamMemberFromStep,
  planDeleteCostItemFromStep,
  planDeleteEmployeeFromStep,
  planDeleteShareholderFromStep,
  planDeleteStageCostTypeFromStep,
  planDeleteTeamMemberFromStep,
} from './model-structure-action-drafts.js'
import {
  planExportBundleRead,
  planImportBundleFromValue,
  planOnlineFactorFromFields,
  planOperatingModelFromStep,
  planWorkspaceDataQueryRead,
  planWorkspacePatchFromStep,
  planWorkspaceRename,
} from './workspace-action-drafts.js'
import { planSandboxPeripheralRead } from './sandbox-service.js'
import {
  actionExecutionObservation,
  actionFailureObservation,
} from './agentic-os/xox-action-graph-adapter.js'

function numericAlias(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'number') continue
    if (Number.isFinite(value)) return value
  }
  return null
}

const memoryToolRuntime = createAgentServerSaaSTenantMemoryToolRuntime<
  PlannerContext,
  RuntimePlannerStep,
  AgentServerTenantMemoryToolItem,
  Row<'agent_memories'>,
  ReadDraft
>({
  contextMessage: (ctx) => ctx.message,
  search: ({ ctx, query, maxResults, includeDailyNotes, includeDurable }) => searchTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    query,
    maxResults,
    includeDailyNotes,
    includeDurable,
  }),
  get: ({ ctx, memoryId }) => getTenantMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    memoryId,
  }),
  locale: 'zh-CN',
  remember: {
    capture: ({ ctx, memory }) => captureTenantMemory({
      db: ctx.db,
      workspace: ctx.workspace,
      user: ctx.user,
      threadId: ctx.threadId,
      ...memory,
    }),
    memoryValue: (memory) => memory.value,
  },
})

const sandboxAggregateActionExecutor = createAgenticSandboxAggregateActionExecutor<unknown, Row<'agent_action_requests'>>()

export const xoxBusinessToolHandlers: ActionDraftBuilderHandlers<PlannerContext> = {
  'ledger.create_member_income': (ctx, step) => {
    const memberName = typeof step.memberName === 'string' && step.memberName.trim()
      ? step.memberName.trim()
      : null
    return memberName
      ? planLedgerCreateFromFields(ctx, {
        monthLabel: typeof step.monthLabel === 'string' ? step.monthLabel : null,
        memberName,
        offlineUnits: step.offlineUnits ?? 0,
        onlineUnits: step.onlineUnits ?? 0,
        occurredAt: typeof step.occurredAt === 'string'
          ? step.occurredAt
          : typeof step.date === 'string'
            ? step.date
            : null,
      })
      : null
  },
  'ledger.create_entry': planGenericLedgerCreateFromStep,
  'ledger.create_planned_member_income_batch': planPlannedMemberIncomeBatch,
  'ledger.create_planned_related_expense_batch': planPlannedRelatedExpenseBatch,
  'ledger.set_period_lock': planPeriodLockFromStep,
  'ledger.update_entry': planLedgerUpdateFromStep,
  'ledger.restore_entry': planLedgerRestoreFromStep,
  'ledger.void_entry': planLedgerVoidFromStep,
  'workspace.update_online_factor': (ctx, step) => {
    const factor = numericAlias(step.onlineSalesFactor, step.newFactor, step.factor, step.onlineFactor)
    return step.monthLabel && factor !== null
      ? planOnlineFactorFromFields(ctx, {
          monthLabel: step.monthLabel,
          factor,
          mode: step.mode === 'forecast' ? 'forecast' : 'write',
        })
      : null
  },
  'team_member.add': planAddTeamMemberFromStep,
  'team_member.delete': planDeleteTeamMemberFromStep,
  'employee.add': planAddEmployeeFromStep,
  'employee.delete': planDeleteEmployeeFromStep,
  'shareholder.add': planAddShareholderFromStep,
  'shareholder.delete': planDeleteShareholderFromStep,
  'cost_item.add': planAddCostItemFromStep,
  'cost_item.delete': planDeleteCostItemFromStep,
  'stage_cost_type.add': planAddStageCostTypeFromStep,
  'stage_cost_type.delete': planDeleteStageCostTypeFromStep,
  'workspace.patch_config': planWorkspacePatchFromStep,
  'workspace.configure_operating_model': planOperatingModelFromStep,
  'workspace.rename': (ctx, step) => planWorkspaceRename(ctx, step.workspaceName),
  'workspace.save_snapshot': planSaveSnapshotAction,
  'workspace.publish_release': (ctx, step) => buildPublishReleaseDraft(ctx, Boolean(step.createShare)),
  'workspace.rollback_version': (ctx, step) => planRollbackVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.promote_version': (ctx, step) => planPromoteVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.delete_version': (ctx, step) => planDeleteVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.reset_draft': planResetDraftAction,
  'workspace.export_bundle': planExportBundleRead,
  'workspace.import_bundle': (ctx, step) => {
    const rawBundle = step.bundle && typeof step.bundle === 'object'
      ? step.bundle
      : ctx.providedWorkspaceBundle?.bundle
    return planImportBundleFromValue(ctx, rawBundle)
  },
  'share.create': (ctx, step) => planShareAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
    revoke: false,
  }),
  'share.revoke': (ctx, step) => planShareAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
    revoke: true,
  }),
  'memory.search': memoryToolRuntime.search,
  'memory.get': memoryToolRuntime.get,
  'memory.remember': memoryToolRuntime.remember,
  'data.query_workspace': planWorkspaceDataQueryRead,
  'sandbox.run_code': (ctx, step) => planSandboxPeripheralRead(ctx, step, xoxBusinessToolHandlers),
}

const xoxBusinessToolRuntime = createAgentServerSaaSBusinessToolRuntime<
  PlannerContext,
  RuntimePlannerStep,
  AgentActionDraft,
  ReadDraft,
  NonNullable<ReadDraft['navigation']>
>({
  handlers: xoxBusinessToolHandlers,
  isAction: (item): item is AgentActionDraft =>
    isAgentHostToolActionDraft<AgentActionDraft, ReadDraft>(item),
  locale: 'zh-CN',
  createNavigation: xoxNavigationFromTabs,
})

export async function executeXoxBusinessToolStep(
  ctx: PlannerContext,
  step: RuntimePlannerStep,
): Promise<PlannedItem[]> {
  return xoxBusinessToolRuntime.runTool(ctx, step)
}

export type XoxOsActionExecutionState = {
  actionRows: Row<'agent_action_requests'>[]
  xoxObservations: AgentToolObservation[]
  observationBridge: HostObservationBridge<AgentToolObservation>
  lastActionExecutionResult: unknown | null
}

function compactJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function actionPreview(row: Row<'agent_action_requests'>): JsonObject {
  return {
    payload: compactJsonValue(parseJson(row.payload_json, {})),
    navigation: compactJsonValue(parseJson(row.navigation_json, {})),
    details: compactJsonValue(parseJson(row.details_json, [])),
    targetLabel: row.target_label,
    riskLevel: row.risk_level,
  }
}

function osActionStatus(row: Row<'agent_action_requests'>): AgentActionStatus {
  if (row.status === 'pending') return 'pending'
  if (row.status === 'executed') return 'executed'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'cancelled') return 'rejected'
  return 'pending'
}

export function xoxOsActionRequest(
  row: Row<'agent_action_requests'>,
): AgentActionRequest {
  if (!row.tool_call_id) throw new Error('Stored action request is missing canonical tool-call identity.')
  return {
    actionRequestId: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    toolName: row.kind,
    status: osActionStatus(row),
    title: row.title,
    description: row.summary,
    preview: actionPreview(row),
  }
}

export function xoxOsActionAudit(input: {
  runId: string
  threadId: string
  actionRequestId: string
  toolCallId: string
  toolName: string
  actorId: string
  outcome: AgentActionAuditRecord['outcome']
  reason?: string
}): AgentActionAuditRecord {
  const audit: AgentActionAuditRecord = {
    auditId: newId(),
    runId: input.runId,
    threadId: input.threadId,
    actionRequestId: input.actionRequestId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    actorId: input.actorId,
    outcome: input.outcome,
    createdAt: utcNow(),
  }
  if (input.reason !== undefined) audit.reason = input.reason
  return audit
}

function replaceActionRow(state: XoxOsActionExecutionState, action: Row<'agent_action_requests'>): void {
  const index = state.actionRows.findIndex((row) => row.id === action.id)
  if (index >= 0) state.actionRows[index] = action
  else state.actionRows.push(action)
}

export async function executeXoxConfirmedBusinessActionForOs(input: {
  ctx: PlannerContext
  state: XoxOsActionExecutionState
  actionInput: AgentActionExecutionInput
}): Promise<AgentActionExecutionResult> {
  const action = await input.ctx.db
    .selectFrom('agent_action_requests')
    .selectAll()
    .where('id', '=', input.actionInput.actionRequest.actionRequestId)
    .executeTakeFirstOrThrow()

  let result: unknown
  try {
    result = await executeAgentActionRequest(input.ctx.db, input.ctx.settings, input.ctx.user, action)
  } catch (executionError) {
    if (input.actionInput.reason === undefined) {
      throw executionError
    }
    const message = safeAgentActionErrorMessage(executionError)
    await input.ctx.db.updateTable('agent_action_requests')
      .set({ status: 'failed', executed_at: null, error_message: message })
      .where('id', '=', action.id)
      .execute()
      .catch(() => undefined)
    await input.ctx.db.updateTable('agent_plan_steps')
      .set({ status: 'failed', updated_at: utcNow() })
      .where('action_request_id', '=', action.id)
      .execute()
      .catch(() => undefined)
    const failed = await input.ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
    input.state.lastActionExecutionResult = null
    replaceActionRow(input.state, failed)
    const xoxObservation = actionFailureObservation({
      action: failed,
      toolCallId: input.actionInput.actionRequest.toolCallId,
      reason: input.actionInput.reason ?? 'Action execution failed.',
      error: message,
    })
    input.state.xoxObservations.push(xoxObservation)
    const observation = input.state.observationBridge.toCanonical(xoxObservation, input.state.xoxObservations.length - 1)
    return {
      actionRequest: xoxOsActionRequest(failed),
      observation,
      audit: xoxOsActionAudit({
        runId: failed.run_id,
        threadId: failed.thread_id,
        actionRequestId: failed.id,
        toolCallId: input.actionInput.actionRequest.toolCallId,
        toolName: failed.kind,
        actorId: input.actionInput.actorId,
        outcome: 'failed',
        reason: message,
      }),
    }
  }

  const updated = await input.ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
  input.state.lastActionExecutionResult = result
  replaceActionRow(input.state, updated)
  const xoxObservation = actionExecutionObservation({
    action: updated,
    toolCallId: input.actionInput.actionRequest.toolCallId,
    result,
  })
  input.state.xoxObservations.push(xoxObservation)
  const observation = input.state.observationBridge.toCanonical(xoxObservation, input.state.xoxObservations.length - 1)
  return {
    actionRequest: xoxOsActionRequest(updated),
    observation,
    audit: xoxOsActionAudit({
      runId: updated.run_id,
      threadId: updated.thread_id,
      actionRequestId: updated.id,
      toolCallId: input.actionInput.actionRequest.toolCallId,
      toolName: updated.kind,
      actorId: input.actionInput.actorId,
      outcome: 'executed',
      ...(input.actionInput.reason !== undefined ? { reason: input.actionInput.reason } : {}),
    }),
  }
}

export function safeAgentActionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent action failed'
}

export async function executeAgentActionRequest(
  db: Kysely<Database>,
  settings: Settings,
  user: CurrentUser,
  action: Row<'agent_action_requests'>,
) {
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

export async function executeAgentTool(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  action: Row<'agent_action_requests'>,
): Promise<unknown> {
  const payload = parseJson<any>(action.payload_json, {})

  if (action.kind === 'sandbox.aggregate_tool_calls') {
    return sandboxAggregateActionExecutor.execute({
      aggregateAction: action,
      payload,
      aggregateKind: 'sandbox.aggregate_tool_calls',
      invalid: unprocessable,
      actionKind: (nestedAction) => nestedAction.kind,
      createNestedAction: ({ aggregateAction, nested, kind, index }) => ({
        ...aggregateAction,
        kind,
        title: typeof nested.title === 'string' ? nested.title : kind,
        summary: typeof nested.summary === 'string' ? nested.summary : kind,
        target_label: typeof nested.targetLabel === 'string' ? nested.targetLabel : `Sandbox nested action ${index + 1}`,
        risk_level: typeof nested.riskLevel === 'string' ? nested.riskLevel : aggregateAction.risk_level,
        payload_json: JSON.stringify(nested.payload ?? {}),
        navigation_json: JSON.stringify(nested.navigation ?? {}),
        details_json: JSON.stringify(nested.details ?? []),
      }) as Row<'agent_action_requests'>,
      executeNestedAction: async (nestedAction): Promise<unknown> => {
        await assertActionExecutionAllowed(db, workspace, user, nestedAction)
        return executeAgentTool(db, workspace, user, nestedAction)
      },
      onNestedActionExecuted: async ({ kind, index }) => {
        await recordAudit(db, {
        workspaceId: workspace.id,
        actorId: user.id,
        action: 'agent.sandbox_nested_action_executed',
        entityType: 'agent_action_request',
        entityId: action.id,
        meta: { aggregateKind: action.kind, nestedKind: kind, nestedIndex: index },
        })
      },
    })
  }

  if (action.kind === 'ledger.create_entry') {
    return createActualEntry(db, { workspace, actor: user, ...payload })
  }
  if (action.kind === 'ledger.update_entry') {
    return updateActualEntry(db, { workspace, actor: user, entryId: payload.entryId, ...payload })
  }
  if (action.kind === 'ledger.void_entry') {
    await voidEntry(db, workspace, payload.entryId, user.id)
    return { ok: true }
  }
  if (action.kind === 'ledger.restore_entry') {
    await restoreEntry(db, workspace, payload.entryId, user.id)
    return { ok: true }
  }
  if (action.kind === 'ledger.lock_period') {
    return setPeriodStatus(db, workspace, payload.periodId, user.id, 'locked')
  }
  if (action.kind === 'ledger.unlock_period') {
    return setPeriodStatus(db, workspace, payload.periodId, user.id, 'open')
  }
  if (action.kind === 'workspace.update_draft') {
    return saveDraft(db, { workspace, actor: user, revision: payload.revision, workspaceName: payload.workspaceName, config: hydrateModelConfig(payload.config) })
  }
  if (action.kind === 'workspace.rename') {
    const draft = await getWorkspaceDraft(db, workspace)
    return saveDraft(db, { workspace, actor: user, revision: draft.revision, workspaceName: payload.workspaceName, config: hydrateModelConfig(parseJson(draft.config_json, {})) })
  }
  if (action.kind === 'workspace.save_snapshot') {
    return publishVersion(db, { workspace, actor: user, kind: 'snapshot' })
  }
  if (action.kind === 'workspace.publish_release') {
    const version = await publishVersion(db, { workspace, actor: user, kind: 'release' })
    if (!payload.createShare) return { version }
    return { version, share: await createVersionShare(db, { workspace: { ...workspace, active_version_id: version.id }, actor: user, versionId: version.id }) }
  }
  if (action.kind === 'workspace.rollback_version') {
    return rollbackToVersion(db, { workspace, actor: user, versionId: payload.versionId })
  }
  if (action.kind === 'workspace.promote_version') {
    const draft = await rollbackToVersion(db, { workspace, actor: user, versionId: payload.versionId })
    const version = await publishVersion(db, { workspace, actor: user, kind: 'release' })
    return { draft, version }
  }
  if (action.kind === 'workspace.delete_version') {
    await deleteVersion(db, workspace, payload.versionId)
    return { ok: true }
  }
  if (action.kind === 'workspace.reset_draft') {
    const draft = await getWorkspaceDraft(db, workspace)
    return saveDraft(db, { workspace, actor: user, revision: draft.revision, workspaceName: '默认工作区', config: createProductDefaultModel() })
  }
  if (action.kind === 'workspace.import_bundle') {
    return importWorkspaceBundle(db, { workspace, actor: user, bundle: payload.bundle })
  }
  if (action.kind === 'share.create') {
    return createVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
  }
  if (action.kind === 'share.revoke') {
    await revokeVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
    return { ok: true }
  }

  throw unprocessable(`Unsupported agent action: ${action.kind}`)
}
