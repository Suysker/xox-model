import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { executeAgentRun } from './agent-run-engine.js'
import { executeDirectAnswerRun } from './direct-answer-runtime.js'
import { resolveTurnIntake } from './turn-intake-resolver.js'

export type AgentKernelRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus | null
}

export async function executeAgentKernelRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgentKernelRunResult | null> {
  const resolution = await resolveTurnIntake({
    db: ctx.db,
    settings: ctx.settings,
    workspace: ctx.workspace,
    user: ctx.user,
    thread: ctx.thread,
    message: ctx.message,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })
  if (resolution.lane === 'direct_answer') {
    return executeDirectAnswerRun(ctx, {
      resolution,
      beforeStateWrite: options.beforeStateWrite,
    })
  }
  return executeAgentRun(ctx, options)
}
