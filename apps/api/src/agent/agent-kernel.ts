import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { executeAgentRun } from './agent-run-engine.js'

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
  return executeAgentRun(ctx, options)
}
