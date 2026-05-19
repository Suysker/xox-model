import { buildAgentContextPack } from './context-pack.js'
import { redactSecretLikeContent } from './memory.js'
import type { PlannerContext } from './planning-context.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { RuntimePlanningInput, RuntimePlanResult } from './runtime/runtime-adapter.js'
import { addRunEvent } from './run-events.js'
import { provideRuntimeToolCatalog } from './tool-gateway.js'

function plannerTokenBudget(message: string) {
  const structuredLineCount = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  return message.length >= 600 || structuredLineCount >= 8 ? 6000 : 1600
}

export async function callRuntimePlanner(ctx: PlannerContext): Promise<RuntimePlanResult | null> {
  const context = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    ...(ctx.providedWorkspaceBundle ? { providedWorkspaceBundle: ctx.providedWorkspaceBundle } : {}),
  })

  const toolCatalog = await provideRuntimeToolCatalog({
    db: ctx.db,
    threadId: ctx.threadId,
    runId: ctx.runId,
    settings: ctx.settings,
    message: ctx.message,
    context,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })

  const runtimeInput: RuntimePlanningInput = {
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools: toolCatalog.tools,
    maxTokens: plannerTokenBudget(ctx.message),
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addRuntimeStreamRunEvent(ctx, event),
  }

  const first = await planWithRuntimeAdapter(runtimeInput)
  if (first?.error?.kind === 'provider_network_error' && !ctx.abortSignal?.aborted) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_retrying',
      title: '模型服务请求重试',
      message: '模型服务连接中断，正在对同一轮规划重试一次。',
      status: 'running',
      data: { provider: ctx.settings.openaiCompatibleProvider, errorKind: first.error.kind },
    })
    return planWithRuntimeAdapter(runtimeInput)
  }
  return first
}
