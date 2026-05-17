import type { Kysely } from 'kysely'
import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import type { CurrentUser } from '../modules/auth.js'
import { addAgentActionRequest, addAgentPlanStep } from './action-requests.js'
import { isActionDraft, type PlannedItem } from './action-draft-builder.js'
import { addRunEvent } from './run-events.js'
import { assertAgentRunLease } from './run-lease.js'
import { agentThreadEvents } from './thread-events.js'

type ActionGraphContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
}

export type StoredActionGraph = {
  assistant: string
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  plannerSource: AgentPlannerSource
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
  for (const [index, item] of input.items.entries()) {
    const sequence = index + 1
    await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
    if (isActionDraft(item)) {
      const action = await addAgentActionRequest(ctx, item)
      const step = await addAgentPlanStep(ctx, {
        sequence,
        title: item.title,
        description: item.summary,
        status: 'ready',
        actionRequestId: action.id,
        navigation: item.navigation,
      })
      actionRows.push(action)
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
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_plan_ready',
    title: failedCount > 0 ? '模型规划需要处理' : actionCount > 0 ? '模型工具调用已解析' : '模型回复已生成',
    message:
      input.items.length > 0
        ? `模型规划生成 ${input.items.length} 个步骤，其中 ${actionCount} 个写入动作需要确认。`
        : '模型没有生成可执行步骤。',
    status: failedCount > 0 ? 'failed' : actionCount > 0 ? 'blocked' : 'info',
    data: { plannerSource: input.plannerSource, stepCount: input.items.length, actionCount, failedCount },
  })
  if (actionCount > 0) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'confirmation_ready',
      title: '确认卡已生成',
      message: `已生成 ${actionCount} 张待确认动作卡，用户可编辑后执行。`,
      status: 'blocked',
      data: { actionCount },
    })
  }
  agentThreadEvents.publish(ctx.threadId, 'plan_ready')
  if (input.items.length > 0) {
    const assistant =
      actionCount > 0
        ? `我已拆成 ${input.items.length} 个步骤，其中 ${actionCount} 个写入动作需要你确认。你可以先编辑确认卡，再逐项执行。${messages.length > 0 ? ` ${messages.join(' ')}` : ''}`
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
