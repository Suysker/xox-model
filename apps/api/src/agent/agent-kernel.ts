import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { compactThreadContextIfNeeded } from './memory.js'
import { planResponse } from './planner.js'
import { addRunEvent } from './run-events.js'
import { addMessage } from './thread-store.js'

export type AgentKernelRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'>
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
}

export async function executeAgentKernelRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgentKernelRunResult | null> {
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'model_planning',
    title: '模型规划中',
    message: '正在调用配置的模型，并等待 provider-native tool calls。',
    status: 'running',
    data: { provider: ctx.settings.llmProvider },
  })
  const planned = await planResponse(ctx)
  if (!(await options.beforeStateWrite())) return null
  const assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', planned.assistant)
  await compactThreadContextIfNeeded({ db: ctx.db, workspace: ctx.workspace, user: ctx.user, threadId: ctx.thread.id })
  if (!(await options.beforeStateWrite())) return null
  return {
    plannerSource: planned.plannerSource,
    assistantMessage,
    navigationEvents: planned.navigationEvents,
    actionRows: planned.actionRows,
    planRows: planned.planRows,
  }
}
