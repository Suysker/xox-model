import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig } from '@xox/domain'
import { agentServerRunLifecycleEvents } from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
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
import { redactSecretLikeContent } from './memory.js'
import { assertActionExecutionAllowed } from './tool-policy.js'
import { addRunEvent } from './agentic-os/xox-run-event-store-adapter.js'

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

export async function autoExecuteAgentActionRequest(
  db: Kysely<Database>,
  settings: Settings,
  user: CurrentUser,
  action: Row<'agent_action_requests'>,
  reason: string,
) {
  try {
    const result = await executeAgentActionRequest(db, settings, user, action)
    const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
    await addRunEvent(db, agentServerRunLifecycleEvents.actionAutoExecuted({
      threadId: action.thread_id,
      runId: action.run_id,
      actionRequestId: action.id,
      actionKind: action.kind,
      actionTitle: action.title,
      reason,
      copy: {
        title: '动作已自动执行',
        message: `已自动执行：${action.title}`,
      },
    }))
    return { actionRequest: updated, result, error: null as string | null }
  } catch (executionError) {
    const message = safeAgentActionErrorMessage(executionError)
    await db.updateTable('agent_action_requests')
      .set({ status: 'failed', executed_at: null, error_message: message })
      .where('id', '=', action.id)
      .execute()
      .catch(() => undefined)
    await db.updateTable('agent_plan_steps')
      .set({ status: 'failed', updated_at: utcNow() })
      .where('action_request_id', '=', action.id)
      .execute()
      .catch(() => undefined)
    await addRunEvent(db, agentServerRunLifecycleEvents.actionAutoExecutionFailed({
      threadId: action.thread_id,
      runId: action.run_id,
      actionRequestId: action.id,
      actionKind: action.kind,
      actionTitle: action.title,
      reason,
      errorMessage: message,
      copy: {
        title: '自动执行失败',
        message: `${action.title}：${message}`,
      },
    })).catch(() => undefined)
    const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
    return { actionRequest: updated, result: null as unknown, error: message }
  }
}

export async function executeAgentTool(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  action: Row<'agent_action_requests'>,
) {
  const payload = parseJson<any>(action.payload_json, {})

  if (action.kind === 'sandbox.aggregate_tool_calls') {
    const nestedActions = Array.isArray(payload.nestedActions) ? payload.nestedActions : []
    if (nestedActions.length === 0) throw unprocessable('Sandbox aggregate action requires nestedActions')
    const results: unknown[] = []
    for (const [index, nested] of nestedActions.entries()) {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw unprocessable('Sandbox nested action is invalid')
      const nestedRecord = nested as Record<string, unknown>
      const kind = typeof nestedRecord.kind === 'string' ? nestedRecord.kind : ''
      if (!kind || kind === 'sandbox.aggregate_tool_calls') throw unprocessable('Sandbox nested action kind is invalid')
      const nestedAction = {
        ...action,
        kind,
        title: typeof nestedRecord.title === 'string' ? nestedRecord.title : kind,
        summary: typeof nestedRecord.summary === 'string' ? nestedRecord.summary : kind,
        target_label: typeof nestedRecord.targetLabel === 'string' ? nestedRecord.targetLabel : `Sandbox nested action ${index + 1}`,
        risk_level: typeof nestedRecord.riskLevel === 'string' ? nestedRecord.riskLevel : action.risk_level,
        payload_json: JSON.stringify(nestedRecord.payload ?? {}),
        navigation_json: JSON.stringify(nestedRecord.navigation ?? {}),
        details_json: JSON.stringify(nestedRecord.details ?? []),
      } as Row<'agent_action_requests'>
      const result = await executeAgentTool(db, workspace, user, nestedAction)
      await recordAudit(db, {
        workspaceId: workspace.id,
        actorId: user.id,
        action: 'agent.sandbox_nested_action_executed',
        entityType: 'agent_action_request',
        entityId: action.id,
        meta: { aggregateKind: action.kind, nestedKind: kind, nestedIndex: index },
      })
      results.push({ kind, result })
    }
    return { ok: true, results }
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
