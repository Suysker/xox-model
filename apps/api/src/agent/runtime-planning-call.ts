import { buildAgentContext } from './context-engine/index.js'
import { redactSecretLikeContent } from './memory.js'
import type { PlannerContext } from './planning-context.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import {
  retryRuntimeInput,
  retryRuntimeMessage,
  shouldRetryRuntimePlan,
} from './runtime/provider-failover-policy.js'
import type { RuntimeChatMessage, RuntimePlanningInput, RuntimePlanResult } from './runtime/runtime-adapter.js'
import type { Settings } from '../core/settings.js'
import {
  HIGH_VOLUME_STRUCTURED_MAX_TOKENS,
  HIGH_VOLUME_STRUCTURED_TIMEOUT_MS,
  HIGH_VOLUME_STRUCTURED_TOOL_NAME,
  hasHighVolumeStructuredTool,
} from './runtime/high-volume-tool-policy.js'
import { addRunEvent } from './run-events.js'
import { plannerSystemPrompt } from './prompt-registry.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'
import { materializedToolInventorySnapshot, provideRuntimeToolCatalog } from './tool-gateway.js'
import {
  contextWithoutThreadConversationLog,
  runtimeMessagesFromThreadConversationLog,
  threadConversationLogFromContext,
} from './runtime-conversation-log.js'
import type { RuntimeToolCatalogProjection } from './tool-gateway.js'
import { providerToolObservationReplayMessages } from './runtime/provider-transcript-replay.js'

function plannerTokenBudget(message: string) {
  const structuredLineCount = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  return message.length >= 600 || structuredLineCount >= 8 ? 6000 : 1600
}

function isHighVolumeStructuredPlanning(input: {
  message: string
  tools: RuntimePlanningInput['tools']
}) {
  const structuredLineCount = input.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  return hasHighVolumeStructuredTool(input.tools) &&
    (input.message.length >= 600 || structuredLineCount >= 8)
}

function runtimeMaxTokens(input: {
  message: string
  tools: RuntimePlanningInput['tools']
}) {
  return isHighVolumeStructuredPlanning(input) ? HIGH_VOLUME_STRUCTURED_MAX_TOKENS : plannerTokenBudget(input.message)
}

function plannerRequestTimeoutMs(input: {
  baseTimeoutMs: number
  maxTokens: number
  message: string
  toolCount: number
}) {
  const structuredLineCount = input.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  const isComplexPlanning =
    input.maxTokens >= 6000 ||
    input.toolCount >= 20 ||
    input.message.length >= 1200 ||
    structuredLineCount >= 12
  return isComplexPlanning ? Math.max(input.baseTimeoutMs, 240_000) : input.baseTimeoutMs
}

function runtimeRequestTimeoutMs(input: {
  baseTimeoutMs: number
  maxTokens: number
  message: string
  toolCount: number
  stableLongToolMode: boolean
}) {
  if (input.stableLongToolMode) return Math.max(input.baseTimeoutMs, HIGH_VOLUME_STRUCTURED_TIMEOUT_MS)
  return plannerRequestTimeoutMs(input)
}

function plannerRuntimeMessages(input: {
  settings: Settings
  context: unknown
  message: string
  priorObservations?: AgentToolObservation[] | undefined
}): RuntimeChatMessage[] {
  const messages: RuntimeChatMessage[] = [
    { role: 'system', content: plannerSystemPrompt() },
    ...runtimeMessagesFromThreadConversationLog(threadConversationLogFromContext(input.context)),
    {
      role: 'user',
      content: `上下文：${JSON.stringify(contextWithoutThreadConversationLog(input.context))}\n用户指令：${input.message}`,
    },
  ]
  messages.push(...providerToolObservationReplayMessages({
    settings: input.settings,
    observations: input.priorObservations ?? [],
    suffix: 'planning_observation',
    maxObservations: 12,
  }))
  return messages
}

async function addNonStreamPlanningPreface(ctx: PlannerContext, result: RuntimePlanResult | null) {
  if (!result || result.steps.length === 0) return
  const text = result?.assistantText?.trim()
  if (!text) return
  await addRuntimeStreamRunEvent({ ...ctx, phase: 'planning' }, {
    kind: 'content_delta',
    delta: text,
    preview: text,
  })
}

function attachToolInventory(result: RuntimePlanResult | null, toolCatalog: RuntimeToolCatalogProjection): RuntimePlanResult | null {
  return result ? { ...result, toolInventorySnapshot: toolCatalog.inventorySnapshot } : result
}

function attachMaterializedToolInventory(
  result: RuntimePlanResult | null,
  toolCatalog: RuntimeToolCatalogProjection,
  tools: RuntimePlanningInput['tools'],
): RuntimePlanResult | null {
  if (!result) return result
  return {
    ...result,
    toolInventorySnapshot: materializedToolInventorySnapshot(
      toolCatalog,
      tools.map((tool) => tool.function.name),
    ),
  }
}

function deferredToolNamesFromBoundary(result: RuntimePlanResult | null | undefined) {
  if (result?.error?.kind !== 'provider_response_error') return []
  if (result.error.toolCallBoundary?.code !== 'tool_call_registered_but_deferred') return []
  return result.error.toolCallBoundary.toolNames
}

function runtimeInputWithMaterializedTools(
  input: RuntimePlanningInput,
  toolCatalog: RuntimeToolCatalogProjection,
  toolNames: readonly string[],
): RuntimePlanningInput | null {
  const existing = new Set(input.tools.map((tool) => tool.function.name))
  const requested = new Set(toolNames)
  const deferredTools = toolCatalog.deferredCatalog
    .filter((manifest) => requested.has(manifest.name) && !existing.has(manifest.name))
    .map((manifest) => manifest.providerSchema)
  if (deferredTools.length === 0) return null
  const materializedNames = new Set(deferredTools.map((tool) => tool.function.name))
  return {
    ...input,
    stream: false,
    tools: [...input.tools, ...deferredTools],
    materializableToolNames: (input.materializableToolNames ?? []).filter((name) => !materializedNames.has(name)),
    requestTimeoutMs: Math.max(input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs, 240_000),
  }
}

export async function callRuntimePlanner(ctx: PlannerContext): Promise<RuntimePlanResult | null> {
  const context = await buildAgentContext({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    runId: ctx.runId,
    message: ctx.message,
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
    userId: ctx.user.id,
    workspaceId: ctx.workspace.id,
    automationLevel: ctx.automationLevel,
  })

  const maxTokens = runtimeMaxTokens({ message: ctx.message, tools: toolCatalog.tools })
  const stableLongToolMode = isHighVolumeStructuredPlanning({ message: ctx.message, tools: toolCatalog.tools })
  const runtimeInput: RuntimePlanningInput = {
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools: toolCatalog.tools,
    materializableToolNames: toolCatalog.materializableToolNames,
    messages: plannerRuntimeMessages({
      settings: ctx.settings,
      context,
      message: redactSecretLikeContent(ctx.message),
      priorObservations: ctx.priorObservations,
    }),
    maxTokens,
    ...(stableLongToolMode ? { stream: false } : {}),
    requestTimeoutMs: runtimeRequestTimeoutMs({
      baseTimeoutMs: ctx.settings.agentProviderRequestTimeoutMs,
      maxTokens,
      message: ctx.message,
      toolCount: toolCatalog.toolCount,
      stableLongToolMode,
    }),
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addRuntimeStreamRunEvent({ ...ctx, phase: 'planning' }, event),
  }

  if (stableLongToolMode) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stable_long_tool_mode',
      title: '长参数工具稳定模式',
      message: '本轮包含大型结构化工具参数，已跳过易截断的流式 arguments，改用非流式长预算规划。',
      status: 'running',
      data: {
        provider: ctx.settings.openaiCompatibleProvider,
        toolName: HIGH_VOLUME_STRUCTURED_TOOL_NAME,
        stream: false,
        maxTokens,
        requestTimeoutMs: runtimeInput.requestTimeoutMs,
      },
    })
  }

  const first = await planWithRuntimeAdapter(runtimeInput)
  const deferredToolNames = deferredToolNamesFromBoundary(first)
  if (deferredToolNames.length > 0 && !ctx.abortSignal?.aborted) {
    const materializedInput = runtimeInputWithMaterializedTools(runtimeInput, toolCatalog, deferredToolNames)
    if (materializedInput) {
      await addRunEvent(ctx.db, {
        threadId: ctx.threadId,
        runId: ctx.runId,
        type: 'tool_catalog_materializing',
        title: '工具目录扩展',
        message: '模型选择了已注册但尚未物化的工具，正在扩展本轮工具目录并重新规划。',
        status: 'running',
        data: {
          toolNames: deferredToolNames,
          previousVisibleToolNames: toolCatalog.visibleToolNames,
          nextVisibleToolNames: materializedInput.tools.map((tool) => tool.function.name),
        },
      })
      const materialized = attachMaterializedToolInventory(
        await planWithRuntimeAdapter(materializedInput),
        toolCatalog,
        materializedInput.tools,
      )
      await addNonStreamPlanningPreface(ctx, materialized)
      return materialized
    }
  }
  if (shouldRetryRuntimePlan(first) && !ctx.abortSignal?.aborted) {
    const retryInput = retryRuntimeInput(runtimeInput, first)
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_retrying',
      title: '模型服务请求重试',
      message: retryRuntimeMessage(first?.error),
      status: 'running',
      data: {
        provider: ctx.settings.openaiCompatibleProvider,
        errorKind: first?.error?.kind,
        retryStream: retryInput.stream ?? true,
        retryTool: retryInput.tools.length === 1 ? retryInput.tools[0]?.function.name ?? null : null,
        requestTimeoutMs: retryInput.requestTimeoutMs ?? ctx.settings.agentProviderRequestTimeoutMs,
      },
    })
    const retry = attachToolInventory(await planWithRuntimeAdapter(retryInput), toolCatalog)
    await addNonStreamPlanningPreface(ctx, retry)
    return retry
  }
  const result = attachToolInventory(first, toolCatalog)
  await addNonStreamPlanningPreface(ctx, result)
  return result
}
