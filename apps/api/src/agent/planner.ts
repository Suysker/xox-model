import type { AgentPlannerSource } from '@xox/contracts'
import { redactSecretLikeContent } from './memory.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { RuntimePlanResult } from './runtime/runtime-adapter.js'
import type { PlannerContext } from './planning-context.js'
import { buildAgentContextPack } from './context-pack.js'
import { provideRuntimeToolCatalog } from './tool-gateway.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { storePlannedActionGraph } from './action-graph-store.js'
import { configuredRuntimePlannerSource } from './runtime-plan-reader.js'
import { runPlanningSession } from './planning-session.js'
import { runtimeIntentHandlers } from './runtime-intent-handlers.js'

async function callRuntimePlanner(ctx: PlannerContext): Promise<RuntimePlanResult | null> {
  const context = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    ...(ctx.providedWorkspaceBundle ? { providedWorkspaceBundle: ctx.providedWorkspaceBundle } : {}),
  })

  const toolCatalog = await provideRuntimeToolCatalog(ctx)

  return planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools: toolCatalog.tools,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addRuntimeStreamRunEvent(ctx, event),
  })
}

export async function planResponse(ctx: PlannerContext) {
  const modelPlan = await runPlanningSession(ctx, {
    handlers: runtimeIntentHandlers,
    callRuntimePlanner,
  })
  const items = modelPlan?.items ?? []
  const plannerSource: AgentPlannerSource = modelPlan?.source ?? configuredRuntimePlannerSource(ctx.settings) ?? 'rules'
  return storePlannedActionGraph(ctx, { items, plannerSource })
}
