import type { Kysely } from 'kysely'
import type { AgentNavigationEvent, AgentPlannerSource, AgentPlanStepStatus } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { addAgentActionRequest, executeAgentActionRequest } from './approval-executor.js'
import { isActionDraft, type PlannedItem } from './action-draft-builder.js'
import { addRunEvent } from './run-events.js'
import { assertAgentRunLease } from './run-lease.js'
import { agentThreadEvents } from './thread-events.js'
import { canAutoExecuteRisk } from './tool-policy.js'
import type { AgentAutomationLevel } from './tool-policy.js'
import { redactSecretLikeContent } from './memory.js'

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
  assistant: string
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  plannerSource: AgentPlannerSource
}

type AddAgentPlanStepInput = {
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  actionRequestId?: string | null
  navigation?: AgentNavigationEvent | null
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
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

function safeAutoExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || '自动执行失败'
}

async function autoExecuteActionIfAllowed(
  ctx: ActionGraphContext,
  action: Row<'agent_action_requests'>,
): Promise<Row<'agent_action_requests'>> {
  if (!canAutoExecuteRisk(action.risk_level, ctx.automationLevel)) return action

  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'action_auto_execution_started',
    title: '自动执行确认卡',
    message: `自动化策略 ${ctx.automationLevel} 允许执行 ${action.risk_level} 风险动作：${action.title}`,
    status: 'running',
    data: { actionRequestId: action.id, actionKind: action.kind, riskLevel: action.risk_level, automationLevel: ctx.automationLevel },
  })

  try {
    await executeAgentActionRequest(ctx.db, ctx.settings, ctx.user, action)
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'action_auto_executed',
      title: '确认卡已自动执行',
      message: `已自动执行：${action.title}`,
      status: 'completed',
      data: { actionRequestId: action.id, actionKind: action.kind, riskLevel: action.risk_level, automationLevel: ctx.automationLevel },
    })
  } catch (error) {
    const message = safeAutoExecutionError(error)
    await ctx.db
      .updateTable('agent_action_requests')
      .set({ status: 'failed', error_message: message })
      .where('id', '=', action.id)
      .execute()
    await ctx.db
      .updateTable('agent_plan_steps')
      .set({ status: 'failed', updated_at: utcNow() })
      .where('action_request_id', '=', action.id)
      .execute()
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'action_auto_execution_failed',
      title: '确认卡自动执行失败',
      message: `${action.title}：${message}`,
      status: 'failed',
      data: { actionRequestId: action.id, actionKind: action.kind, riskLevel: action.risk_level, automationLevel: ctx.automationLevel },
    })
  }

  return ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
}

export async function storePlannedActionGraph(
  ctx: ActionGraphContext,
  input: { items: PlannedItem[]; plannerSource: AgentPlannerSource },
): Promise<StoredActionGraph> {
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const messages: string[] = []

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
      const action = await addAgentActionRequest(ctx, item)
      let step = await addAgentPlanStep(ctx, {
        sequence,
        title: item.title,
        description: item.summary,
        status: 'ready',
        actionRequestId: action.id,
        navigation: item.navigation,
      })
      const updatedAction = await autoExecuteActionIfAllowed(ctx, action)
      if (updatedAction.status !== action.status) {
        step = await ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', step.id).executeTakeFirstOrThrow()
      }
      actionRows.push(updatedAction)
      planRows.push(step)
      navigationEvents.push(item.navigation)
      continue
    }

    if (item.navigation) navigationEvents.push(item.navigation)
    const step = await addAgentPlanStep(ctx, {
      sequence,
      title: item.title,
      description: item.message,
      status: item.status ?? 'info',
      navigation: item.navigation ?? null,
    })
    planRows.push(step)
    messages.push(item.message)
  }

  const failedCount = planRows.filter((row) => row.status === 'failed').length
  const actionCount = actionRows.length
  const pendingActionCount = actionRows.filter((row) => row.status === 'pending').length
  const executedActionCount = actionRows.filter((row) => row.status === 'executed').length
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_plan_ready',
    title: failedCount > 0 ? '模型规划需要处理' : actionCount > 0 ? '模型工具调用已解析' : '模型回复已生成',
    message:
      input.items.length > 0
        ? `模型规划生成 ${input.items.length} 个步骤，其中 ${pendingActionCount} 个写入动作需要确认，${executedActionCount} 个已按自动化策略执行。`
        : '模型没有生成可执行步骤。',
    status: failedCount > 0 ? 'failed' : pendingActionCount > 0 ? 'blocked' : executedActionCount > 0 ? 'completed' : 'info',
    data: { plannerSource: input.plannerSource, stepCount: input.items.length, actionCount, pendingActionCount, executedActionCount, failedCount, automationLevel: ctx.automationLevel },
  })
  if (pendingActionCount > 0) {
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
  if (input.items.length > 0) {
    const assistant =
      pendingActionCount > 0
        ? `我已拆成 ${input.items.length} 个步骤，其中 ${pendingActionCount} 个写入动作需要你确认，${executedActionCount} 个已按自动化策略执行。你可以先编辑未执行确认卡，再逐项执行。${messages.length > 0 ? ` ${messages.join(' ')}` : ''}`
        : executedActionCount > 0
          ? `我已拆成 ${input.items.length} 个步骤，并按自动化策略执行了 ${executedActionCount} 个写入动作。${messages.length > 0 ? ` ${messages.join(' ')}` : ''}`
        : messages.join(' ')
    return { assistant, navigationEvents, actionRows, planRows, plannerSource: input.plannerSource }
  }

  return {
    assistant: '我可以操作测算、调模型、记实际、看偏差、版本发布/恢复、分享和锁账。请告诉我要执行的业务动作；写入前我会先给确认卡。',
    navigationEvents,
    actionRows,
    planRows,
    plannerSource: input.plannerSource,
  }
}
