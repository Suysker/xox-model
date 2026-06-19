import type { Kysely } from 'kysely'
import type { AgentNavigationEvent, AgentPlannerSource, AgentPlanStepStatus } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { isActionDraft, type PlannedItem } from './action-draft-builder.js'
import {
  addAgentActionRequest,
  autoExecuteAgentActionRequest,
  type AgentActionDraft,
} from './approval-executor.js'
import { addRunEvent } from './run-events.js'
import { assertAgentRunLease } from './run-lease.js'
import { agentThreadEvents } from './thread-events.js'
import {
  actionFailureObservation,
  actionExecutionObservation,
  actionPreviewObservation,
  type AgentToolObservation,
} from './tool-observation-continuation.js'
import { resolveActionAuthority, type AgentAutomationLevel } from './tool-policy.js'
import { classifyToolObservation } from './tool-observation-outcome.js'

type ActionGraphContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  automationLevel: AgentAutomationLevel
}

export type StoredActionGraph = {
  assistantText: string | null
  observations: AgentToolObservation[]
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  plannerSource: AgentPlannerSource
}

type StoredActionResult = {
  action: Row<'agent_action_requests'>
  observation: AgentToolObservation
}

function toolNameForRead(item: PlannedItem, sequence: number) {
  if (!('toolName' in item) || !item.toolName) return `read_observation_${sequence}`
  return item.toolName
}

function observationFromRead(item: PlannedItem, sequence: number): AgentToolObservation | null {
  if (!('readKind' in item) || item.readKind !== 'tool_observation') return null
  const toolName = toolNameForRead(item, sequence)
  const displayPreview = item.displayPreview ?? item.message
  const lane = item.observationLane ?? 'provider_tool'
  const status = item.observationStatus ??
    (item.status === 'failed' ? 'failed' : item.status === 'cancelled' ? 'cancelled' : 'completed')
  const observation = {
    title: item.title,
    toolName,
    toolCallId: item.toolCallId ?? `call_observation_${sequence}_${toolName}`,
    toolArguments: item.toolArguments ?? {},
    displayPreview,
    modelContent: item.modelContent ?? displayPreview,
    status,
    lane,
    ...(item.syntheticObservation ? { synthetic: true } : {}),
  }
  return {
    ...observation,
    outcome: item.observationOutcome ?? classifyToolObservation(observation),
  }
}

function isRunnerOwnedObservationLane(lane: unknown) {
  return lane === 'runner_evidence' || lane === 'runner_obligation'
}

type AddAgentPlanStepInput = {
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  actionRequestId?: string | null
  navigation?: AgentNavigationEvent | null
  toolName?: string | null
  toolCallId?: string | null
  toolArguments?: Record<string, unknown> | null
}

async function addAgentPlanStep(ctx: ActionGraphContext, input: AddAgentPlanStepInput) {
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
      tool_name: input.toolName ?? null,
      tool_call_id: input.toolCallId ?? null,
      tool_arguments_json: input.toolArguments ? jsonString(input.toolArguments) : null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function getPlanStep(ctx: ActionGraphContext, id: string) {
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function settleStoredAction(
  ctx: ActionGraphContext,
  input: {
    draft: AgentActionDraft
    action: Row<'agent_action_requests'>
  },
): Promise<StoredActionResult> {
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
        ? actionFailureObservation({ action: executed.actionRequest, reason: authority.reason, error: executed.error })
        : actionExecutionObservation({ action: executed.actionRequest, result: executed.result }),
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
      observation: actionFailureObservation({ action, reason: authority.reason }),
    }
  }

  return {
    action: input.action,
    observation: actionPreviewObservation({ action: input.action }),
  }
}

export async function storePlannedActionGraph(
  ctx: ActionGraphContext,
  input: { items: PlannedItem[]; plannerSource: AgentPlannerSource; emitPlanReady?: boolean },
): Promise<StoredActionGraph> {
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const assistantTexts: string[] = []
  const observations: AgentToolObservation[] = []

  await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
  const existing = await ctx.db
    .selectFrom('agent_plan_steps')
    .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
    .where('run_id', '=', ctx.runId)
    .executeTakeFirst()
  const sequenceOffset = Number(existing?.maxSequence ?? 0)
  for (const [index, item] of input.items.entries()) {
    const sequence = sequenceOffset + index + 1
    await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
    if (isActionDraft(item)) {
      let action = await addAgentActionRequest(ctx, item)
      let step = await addAgentPlanStep(ctx, {
        sequence,
        title: item.title,
        description: item.summary,
        status: 'ready',
        actionRequestId: action.id,
        navigation: item.navigation,
      })
      const settled = await settleStoredAction(ctx, { draft: item, action })
      action = settled.action
      step = await getPlanStep(ctx, step.id)
      observations.push(settled.observation)
      actionRows.push(action)
      planRows.push(step)
      navigationEvents.push(item.navigation)
      continue
    }

    if (item.readKind === 'assistant_message') {
      assistantTexts.push(item.message)
      continue
    }

    if (item.readKind === 'tool_observation' && isRunnerOwnedObservationLane(item.observationLane)) {
      const observation = observationFromRead(item, sequence)
      if (observation) observations.push(observation)
      continue
    }

    if (item.navigation) navigationEvents.push(item.navigation)
    const step = await addAgentPlanStep(ctx, {
      sequence,
      title: item.title,
      description: item.message,
      status: item.status ?? 'info',
      navigation: item.navigation ?? null,
      toolName: item.toolName ?? null,
      toolCallId: item.toolCallId ?? null,
      toolArguments: item.toolArguments ?? null,
    })
    planRows.push(step)
    const observation = observationFromRead(item, sequence)
    if (observation) observations.push(observation)
  }

  const failedCount = planRows.filter((row) => row.status === 'failed').length
  const actionCount = actionRows.length
  const pendingActionCount = actionRows.filter((row) => row.status === 'pending').length
  const executedActionCount = actionRows.filter((row) => row.status === 'executed').length
  const actionSummary = actionCount > 0
    ? `，其中 ${pendingActionCount} 个写入动作需要确认，${executedActionCount} 个已按自动化策略执行。`
    : '。'
  if (input.emitPlanReady !== false) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'tool_plan_ready',
      title: failedCount > 0 ? '模型规划需要处理' : actionCount > 0 ? '模型工具调用已解析' : '模型回复已生成',
      message:
        planRows.length > 0 || assistantTexts.length > 0
          ? `模型规划生成 ${planRows.length + assistantTexts.length} 个步骤${actionSummary}`
          : '模型没有生成可执行步骤。',
      status: failedCount > 0 ? 'failed' : pendingActionCount > 0 ? 'blocked' : executedActionCount > 0 ? 'completed' : 'info',
      data: {
        plannerSource: input.plannerSource,
        stepCount: planRows.length + assistantTexts.length,
        actionCount,
        pendingActionCount,
        executedActionCount,
        failedCount,
        automationLevel: ctx.automationLevel,
      },
    })
  }
  if (pendingActionCount > 0 && input.emitPlanReady !== false) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'confirmation_ready',
      title: '确认卡已生成',
      message: `已生成 ${pendingActionCount} 张待确认动作卡，用户可编辑后执行。`,
      status: 'blocked',
      data: { actionCount: pendingActionCount, automationLevel: ctx.automationLevel },
    })
  }
  agentThreadEvents.publish(ctx.threadId, 'plan_ready')
  return {
    assistantText: assistantTexts.length > 0 ? assistantTexts.join('\n\n') : null,
    observations,
    navigationEvents,
    actionRows,
    planRows,
    plannerSource: input.plannerSource,
  }
}
