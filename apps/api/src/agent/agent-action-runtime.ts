import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import {
  addAgentActionRequest,
  autoExecuteAgentActionRequest,
  type AgentActionDraft,
} from './approval-executor.js'
import { addRunEvent } from './run-events.js'
import {
  actionExecutionObservation,
  actionPreviewObservation,
  type AgentToolObservation,
} from './tool-observation-continuation.js'
import { resolveActionAuthority, type AgentAutomationLevel } from './tool-policy.js'

export type AgentActionRuntimeContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  automationLevel: AgentAutomationLevel
}

export type AgentActionRuntimeResult = {
  action: Row<'agent_action_requests'>
  observation: AgentToolObservation
  mode: 'pending_confirmation' | 'auto_executed' | 'auto_execution_failed' | 'forbidden'
}

function failedActionObservation(input: {
  action: Row<'agent_action_requests'>
  reason: string
  error?: string | null
}): AgentToolObservation {
  const displayPreview = input.error
    ? `自动执行失败：${input.action.title}：${input.error}`
    : `动作被策略阻止：${input.action.title}`
  return {
    title: input.action.title,
    toolName: input.action.kind,
    toolCallId: `action_${input.action.id}`,
    toolArguments: {},
    displayPreview,
    modelContent: JSON.stringify({
      displayPreview,
      actionRequestId: input.action.id,
      actionKind: input.action.kind,
      title: input.action.title,
      status: input.action.status,
      reason: input.reason,
      error: input.error ?? null,
    }),
    status: 'failed',
  }
}

export async function createAgentActionRuntimeRequest(
  ctx: AgentActionRuntimeContext,
  draft: AgentActionDraft,
) {
  return addAgentActionRequest(ctx, draft)
}

export async function settleAgentActionRuntimeRequest(
  ctx: AgentActionRuntimeContext,
  input: {
    draft: AgentActionDraft
    action: Row<'agent_action_requests'>
  },
): Promise<AgentActionRuntimeResult> {
  const authority = resolveActionAuthority({
    automationLevel: ctx.automationLevel,
    kind: input.draft.kind,
    riskLevel: input.draft.riskLevel,
  })

  if (authority.mode === 'auto_execute') {
    const executed = await autoExecuteAgentActionRequest(ctx.db, ctx.settings, ctx.user, input.action, authority.reason)
    return {
      action: executed.actionRequest,
      observation: executed.error
        ? failedActionObservation({ action: executed.actionRequest, reason: authority.reason, error: executed.error })
        : actionExecutionObservation({ action: executed.actionRequest, result: executed.result }),
      mode: executed.error ? 'auto_execution_failed' : 'auto_executed',
    }
  }

  if (authority.mode === 'forbidden') {
    await ctx.db.updateTable('agent_action_requests')
      .set({ status: 'failed', error_message: authority.reason })
      .where('id', '=', input.action.id)
      .execute()
    await ctx.db.updateTable('agent_plan_steps')
      .set({ status: 'failed', updated_at: utcNow() })
      .where('action_request_id', '=', input.action.id)
      .execute()
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'action_auto_execution_failed',
      title: '动作被策略阻止',
      message: `${input.draft.title}：${authority.reason}`,
      status: 'failed',
      data: { actionRequestId: input.action.id, actionKind: input.action.kind, reason: authority.reason },
    })
    const action = await ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', input.action.id).executeTakeFirstOrThrow()
    return {
      action,
      observation: failedActionObservation({ action, reason: authority.reason }),
      mode: 'forbidden',
    }
  }

  return {
    action: input.action,
    observation: actionPreviewObservation({ action: input.action }),
    mode: 'pending_confirmation',
  }
}
