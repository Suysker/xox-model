import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { executeXoxAgenticOsRun } from './agentic-os/xox-agentic-os-host-kit.js'
import { executeXoxDirectAnswerLane } from './agentic-os/xox-direct-answer-adapter.js'
import { resolveXoxAgentTurnIntake } from './agentic-os/xox-turn-intake-adapter.js'
import { sanitizeAgentGoalFacts } from './runtime-goal-facts.js'

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
  const resolution = await resolveXoxAgentTurnIntake(ctx)
  if (resolution.lane === 'direct_answer') {
    return executeXoxDirectAnswerLane(ctx, {
      resolution,
      beforeStateWrite: options.beforeStateWrite,
    })
  }
  return executeXoxAgenticOsRun({
    ...ctx,
    ...(resolution.goalFacts ? { initialGoalFacts: sanitizeAgentGoalFacts(resolution.goalFacts) } : {}),
  }, options)
}
