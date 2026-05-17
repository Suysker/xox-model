import type { AgentPlannerSource } from '@xox/contracts'
import type { PlannerContext } from './planning-context.js'
import { storePlannedActionGraph } from './action-graph-store.js'
import { configuredRuntimePlannerSource } from './runtime-plan-reader.js'
import { runPlanningSession } from './planning-session.js'
import { runtimeIntentHandlers } from './runtime-intent-handlers.js'
import { callRuntimePlanner } from './runtime-planning-call.js'

export async function planResponse(ctx: PlannerContext) {
  const modelPlan = await runPlanningSession(ctx, {
    handlers: runtimeIntentHandlers,
    callRuntimePlanner,
  })
  const items = modelPlan?.items ?? []
  const plannerSource: AgentPlannerSource = modelPlan?.source ?? configuredRuntimePlannerSource(ctx.settings) ?? 'rules'
  return storePlannedActionGraph(ctx, { items, plannerSource })
}
