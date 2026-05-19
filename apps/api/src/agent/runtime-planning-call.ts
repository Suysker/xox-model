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

function shouldRetryRuntimePlan(result: RuntimePlanResult | null | undefined) {
  return result?.error?.kind === 'provider_network_error' || result?.error?.kind === 'provider_response_error'
}

function retryRuntimeInput(input: RuntimePlanningInput, result: RuntimePlanResult | null | undefined): RuntimePlanningInput {
  if (result?.error?.kind !== 'provider_response_error') return input
  const selectedToolName = result.error.toolNames?.find((name) =>
    input.tools.some((tool) => tool.function.name === name),
  )
  if (!selectedToolName) return { ...input, stream: false }
  const selectedTool = input.tools.find((tool) => tool.function.name === selectedToolName)
  return {
    ...input,
    stream: false,
    tools: selectedTool ? [selectedTool] : input.tools,
    toolChoice: { type: 'function', function: { name: selectedToolName } },
    maxTokens: Math.max(input.maxTokens ?? 1600, 12000),
  }
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
  if (shouldRetryRuntimePlan(first) && !ctx.abortSignal?.aborted) {
    const retryInput = retryRuntimeInput(runtimeInput, first)
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_retrying',
      title: '模型服务请求重试',
      message: first?.error?.kind === 'provider_response_error'
        ? '模型服务返回的流式工具调用不可解析，正在改用非流式请求对同一轮规划重试一次。'
        : '模型服务连接中断，正在对同一轮规划重试一次。',
      status: 'running',
      data: {
        provider: ctx.settings.openaiCompatibleProvider,
        errorKind: first?.error?.kind,
        retryStream: retryInput.stream ?? true,
        retryTool: retryInput.toolChoice && typeof retryInput.toolChoice === 'object'
          ? retryInput.toolChoice.function.name
          : null,
      },
    })
    return planWithRuntimeAdapter(retryInput)
  }
  return first
}
