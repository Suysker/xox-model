import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { executeAgentGoalRun } from './goal-run-engine.js'

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
  return executeAgentGoalRun(ctx, options)
}
