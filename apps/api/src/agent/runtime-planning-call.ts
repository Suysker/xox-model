import { buildAgentContextPack } from './context-pack.js'
import { redactSecretLikeContent } from './memory.js'
import type { PlannerContext } from './planning-context.js'
import { addRuntimeStreamRunEvent } from './runtime-trace-events.js'
import { planWithRuntimeAdapter, type RuntimeChatMessage, type RuntimePlanningInput, type RuntimePlanError, type RuntimePlanResult } from './runtime/runtime-adapter.js'
import type { Settings } from '../core/settings.js'
import { addRunEvent } from './run-events.js'
import { plannerSystemPrompt } from './prompt-registry.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'
import { materializedToolInventorySnapshot, provideRuntimeToolCatalog } from './tool-gateway.js'
import {
  contextWithoutRuntimeConversationLog,
  runtimeConversationLogFromContext,
  runtimeMessagesFromConversationLog,
} from '@agentic-os/core'
import type { RuntimeToolCatalogProjection } from './tool-gateway.js'
import {
  applyProviderRuntimeRetryPatch,
  buildProviderRuntimeRetryPatch,
  buildProviderToolObservationTurnMessages,
  isRecoverableProviderHttpRuntimeError,
  resolveProviderRuntimeProfile,
  shouldRetryProviderRuntimeResult,
} from '@agentic-os/runtime-openai-compatible'

const PLANNING_USER_CONTENT_MAX_CHARS = 64_000
const XOX_HIGH_VOLUME_STRUCTURED_TOOL_NAMES = [
  'workspace_configure_operating_model',
  'sandbox_run_code',
] as const
const XOX_HIGH_VOLUME_STRUCTURED_MAX_TOKENS = 48_000
const XOX_HIGH_VOLUME_STRUCTURED_TIMEOUT_MS = 360_000

function plannerTokenBudget(message: string) {
  const structuredLineCount = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  return message.length >= 600 || structuredLineCount >= 8 ? 6000 : 1600
}

function highVolumeStructuredToolName(tools: RuntimePlanningInput['tools']) {
  const toolNames = new Set(tools.map((tool) => tool.function.name))
  return XOX_HIGH_VOLUME_STRUCTURED_TOOL_NAMES.find((name) => toolNames.has(name)) ?? null
}

function hasHighVolumeStructuredTool(tools: RuntimePlanningInput['tools']) {
  return highVolumeStructuredToolName(tools) !== null
}

function hasRuntimeTool(tools: RuntimePlanningInput['tools'], toolName: string) {
  return tools.some((tool) => tool.function.name === toolName)
}

function activeRequiredToolNames(loopObligationPlan: PlannerContext['loopObligationPlan'] | undefined) {
  return loopObligationPlan?.requiredToolNames ?? []
}

function isSandboxCalculationPlanning(input: {
  tools: RuntimePlanningInput['tools']
  loopObligationPlan?: PlannerContext['loopObligationPlan']
}) {
  const required = activeRequiredToolNames(input.loopObligationPlan)
  if (!required.includes('sandbox_run_code')) return false
  if (required.some((toolName) => toolName !== 'sandbox_run_code')) return false
  return hasRuntimeTool(input.tools, 'sandbox_run_code')
}

function isSandboxPinnedCatalogPlanning(input: {
  tools: RuntimePlanningInput['tools']
  priorObservationCount: number
  loopObligationPlan?: PlannerContext['loopObligationPlan']
}) {
  const required = activeRequiredToolNames(input.loopObligationPlan)
  if (required.some((toolName) => toolName !== 'sandbox_run_code')) return false
  return input.priorObservationCount > 0 &&
    hasRuntimeTool(input.tools, 'sandbox_run_code')
}

function stableStructuredToolName(input: {
  tools: RuntimePlanningInput['tools']
  priorObservationCount: number
  loopObligationPlan?: PlannerContext['loopObligationPlan']
}) {
  if (isSandboxCalculationPlanning(input)) return 'sandbox_run_code'
  if (isSandboxPinnedCatalogPlanning(input)) return 'sandbox_run_code'
  return highVolumeStructuredToolName(input.tools)
}

function isHighVolumeStructuredPlanning(input: {
  message: string
  tools: RuntimePlanningInput['tools']
  priorObservationCount: number
  loopObligationPlan?: PlannerContext['loopObligationPlan']
}) {
  const structuredLineCount = input.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
  if (isSandboxCalculationPlanning(input)) return true
  if (isSandboxPinnedCatalogPlanning(input)) return true
  return hasHighVolumeStructuredTool(input.tools) &&
    (input.message.length >= 600 || structuredLineCount >= 8)
}

function runtimeMaxTokens(input: {
  message: string
  tools: RuntimePlanningInput['tools']
  priorObservationCount: number
  loopObligationPlan?: PlannerContext['loopObligationPlan']
}) {
  return isHighVolumeStructuredPlanning(input) ? XOX_HIGH_VOLUME_STRUCTURED_MAX_TOKENS : plannerTokenBudget(input.message)
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
  if (input.stableLongToolMode) return Math.max(input.baseTimeoutMs, XOX_HIGH_VOLUME_STRUCTURED_TIMEOUT_MS)
  return plannerRequestTimeoutMs(input)
}

function plannerRuntimeMessages(input: {
  settings: Settings
  context: unknown
  message: string
  priorObservations?: AgentToolObservation[] | undefined
}): RuntimeChatMessage[] {
  const providerRuntime = resolveProviderRuntimeProfile({
    provider: input.settings.openaiCompatibleProvider,
    model: input.settings.openaiCompatibleModel,
  })
  return buildProviderToolObservationTurnMessages({
    profile: providerRuntime.profile,
    capability: providerRuntime.capability,
    thinkingLevel: providerRuntime.thinkingLevel,
    systemPrompt: plannerSystemPrompt(),
    priorMessages: runtimeMessagesFromConversationLog(runtimeConversationLogFromContext(input.context)),
    userContent: `上下文：${JSON.stringify(contextWithoutRuntimeConversationLog(input.context))}\n用户指令：${input.message}`,
    observations: input.priorObservations ?? [],
    suffix: 'planning_observation',
    maxObservations: 12,
    maxUserContentChars: PLANNING_USER_CONTENT_MAX_CHARS,
    redact: redactSecretLikeContent,
  }) as RuntimeChatMessage[]
}

function contextWithLoopObligationPlan(context: unknown, ctx: PlannerContext) {
  if (!ctx.loopObligationPlan) return context
  return {
    ...(context && typeof context === 'object' && !Array.isArray(context) ? context as Record<string, unknown> : { context }),
    runnerObligationPlan: ctx.loopObligationPlan.modelContext,
  }
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

function providerRetryEventMessage(error?: RuntimePlanError) {
  if (error?.kind === 'provider_response_error') {
    if (error.toolCallBoundary?.code === 'tool_call_arguments_truncated') {
      return '模型服务返回的流式工具调用参数不完整，正在改用非流式请求对同一轮规划重试一次。'
    }
    if (error.toolCallBoundary?.code === 'tool_call_stream_interrupted') {
      return '模型服务的工具调用流中断，正在改用非流式请求对同一轮规划重试一次。'
    }
    return '模型服务返回的流式工具调用不可解析，正在改用非流式请求对同一轮规划重试一次。'
  }
  if (error?.kind === 'provider_timeout') {
    return '模型服务响应超时，正在用更稳的同轮规划请求重试一次。'
  }
  if (isRecoverableProviderHttpRuntimeError(error)) {
    return '模型服务返回临时服务错误，正在对同一轮规划重试一次。'
  }
  return '模型服务连接中断，正在对同一轮规划重试一次。'
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

function observedToolNames(result: RuntimePlanResult | null | undefined) {
  return new Set(
    (result?.steps ?? [])
      .map((step) => step.providerToolName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  )
}

function missingObservationToolNames(
  first: RuntimePlanResult | null | undefined,
  retry: RuntimePlanResult | null | undefined,
) {
  const attempted = [...new Set(first?.error?.toolNames ?? [])]
  if (attempted.length === 0) return []
  const observed = observedToolNames(retry)
  return attempted.filter((name) => !observed.has(name))
}

function missingObservationBoundaryResult(
  first: RuntimePlanResult | null | undefined,
  retry: RuntimePlanResult | null | undefined,
): RuntimePlanResult | null {
  if (first?.error?.kind !== 'provider_response_error') return null
  if (missingObservationToolNames(first, retry).length === 0) return null
  return {
    source: first.source,
    steps: [],
    error: first.error,
    ...(first.providerArtifact ? { providerArtifact: first.providerArtifact } : {}),
    ...(first.providerAssistantMessage ? { providerAssistantMessage: first.providerAssistantMessage } : {}),
  }
}

function requiredFactsForToolEvidence(toolNames: readonly string[]) {
  return {
    ...(toolNames.includes('sandbox_run_code') ? { requiresSandboxComputation: true } : {}),
  }
}

async function addToolEvidenceRequirement(
  ctx: PlannerContext,
  first: RuntimePlanResult | null | undefined,
  retry: RuntimePlanResult | null | undefined,
) {
  const toolNames = missingObservationToolNames(first, retry)
  if (toolNames.length === 0) return
  const requiredGoalFacts = requiredFactsForToolEvidence(toolNames)
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'runtime_evidence_required',
    title: '需要补齐工具证据',
    message: 'Provider 已产生工具调用意图，但重试后没有形成对应工具 observation；最终回答前必须补齐对应 evidence 或失败关闭。',
    status: 'running',
    data: {
      toolNames,
      reason: 'provider_tool_call_without_observation_after_retry',
      requiredGoalFacts,
    },
  })
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
  const baseContext = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    runId: ctx.runId,
    message: ctx.message,
    ...(ctx.providedWorkspaceBundle ? { providedWorkspaceBundle: ctx.providedWorkspaceBundle } : {}),
  })
  const context = contextWithLoopObligationPlan(baseContext, ctx)

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
    ...(ctx.goalFacts ? { goalFacts: ctx.goalFacts } : {}),
    ...(ctx.loopObligationPlan ? { loopObligationPlan: ctx.loopObligationPlan } : {}),
    ...(ctx.priorObservations ? { priorObservations: ctx.priorObservations } : {}),
  })

  const priorObservationCount = ctx.priorObservations?.length ?? 0
  const maxTokens = runtimeMaxTokens({
    message: ctx.message,
    tools: toolCatalog.tools,
    priorObservationCount,
    loopObligationPlan: ctx.loopObligationPlan,
  })
  const stableLongToolMode = isHighVolumeStructuredPlanning({
    message: ctx.message,
    tools: toolCatalog.tools,
    priorObservationCount,
    loopObligationPlan: ctx.loopObligationPlan,
  })
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
    const stableToolName = stableStructuredToolName({
      tools: toolCatalog.tools,
      priorObservationCount,
      loopObligationPlan: ctx.loopObligationPlan,
    })
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stable_long_tool_mode',
      title: '长参数工具稳定模式',
      message: '本轮包含大型结构化工具参数，已跳过易截断的流式 arguments，改用非流式长预算规划。',
      status: 'running',
      data: {
        provider: ctx.settings.openaiCompatibleProvider,
        toolName: stableToolName,
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
  if (shouldRetryProviderRuntimeResult(first) && !ctx.abortSignal?.aborted) {
    const retryPatch = buildProviderRuntimeRetryPatch({
      availableToolNames: runtimeInput.tools.map((tool) => tool.function.name),
      baselineMaxTokens: runtimeInput.maxTokens ?? 1600,
      baselineRequestTimeoutMs: runtimeInput.requestTimeoutMs ?? runtimeInput.settings.agentProviderRequestTimeoutMs,
      highVolumeToolNames: XOX_HIGH_VOLUME_STRUCTURED_TOOL_NAMES,
      highVolumeRetryMaxTokens: XOX_HIGH_VOLUME_STRUCTURED_MAX_TOKENS,
      highVolumeRetryTimeoutMs: XOX_HIGH_VOLUME_STRUCTURED_TIMEOUT_MS,
      ...(first?.error ? { error: first.error } : {}),
    })
    const retryInput = applyProviderRuntimeRetryPatch(
      runtimeInput,
      retryPatch,
      { getToolName: (tool) => tool.function.name },
    )
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_retrying',
      title: '模型服务请求重试',
      message: providerRetryEventMessage(first?.error),
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
    await addToolEvidenceRequirement(ctx, first, retry)
    const boundaryResult = missingObservationBoundaryResult(first, retry)
    if (boundaryResult) {
      return attachToolInventory(boundaryResult, toolCatalog)
    }
    await addNonStreamPlanningPreface(ctx, retry)
    return retry
  }
  const result = attachToolInventory(first, toolCatalog)
  await addNonStreamPlanningPreface(ctx, result)
  return result
}
