import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  AgentToolCall,
  JsonObject,
  RuntimeToolDescriptor,
} from '@agentic-os/contracts'
import {
  contextWithoutRuntimeConversationLog,
  createRuntimePlanRouter,
  inferToolAuthorityClass,
  runtimeConversationLogFromContext,
  runtimeMessagesFromConversationLog,
} from '@agentic-os/core'
import { agentServerRunLifecycleEvents } from '@agentic-os/server'
import {
  runOpenAIAgentsTurn,
  type OpenAIAgentsRuntimeEvent,
} from '@agentic-os/runtime-openai-agents'
import {
  ProviderToolCallBoundaryError,
  buildProviderToolObservationTurnMessages,
  isRecoverableProviderHttpRuntimeError,
  resolveProviderRuntimeProfile,
  runOpenAICompatibleRuntimeTurn,
  safeProviderErrorMessage,
  type NormalizedProviderToolCall,
  type OpenAICompatibleRuntimeTurnError,
  type OpenAICompatibleRuntimeTurnEvent,
  type ProviderRuntimeRetryError,
  type ProviderRuntimeToolCallBoundary,
  runOpenAICompatibleRuntimePlanningRecovery,
} from '@agentic-os/runtime-openai-compatible'
import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import { buildAgentContextPack } from '../host-profile/xox-context-pack.js'
import { redactSecretLikeContent } from '../memory.js'
import type { PlannerContext } from '../host-profile/xox-planned-items.js'
import { addRunEvent, addRuntimeStreamRunEvent } from './xox-run-event-store-adapter.js'
import type { AgentToolObservation } from './xox-tool-observation-adapter.js'
import {
  AGENT_TOOL_REGISTRY,
  materializedToolInventorySnapshot,
  provideRuntimeToolCatalog,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type ChatTool,
  type RuntimeToolCatalogProjection,
} from '../tool-catalog.js'

export type RuntimePlannerSource = Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'>

export type RuntimeProviderErrorClassification =
  | 'unsupported_parameter'
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'context_overflow'
  | 'server'
  | 'http'

export type ToolCallBoundaryViolationCode =
  | 'tool_call_registered_but_deferred'
  | 'tool_call_not_in_effective_inventory'
  | 'tool_call_without_registered_handler'
  | 'tool_call_arguments_truncated'
  | 'tool_call_arguments_invalid'
  | 'tool_call_stream_interrupted'

export type RuntimeToolCallBoundaryViolation = {
  code: ToolCallBoundaryViolationCode
  toolName?: string
  toolNames: string[]
  effectiveToolNames: string[]
}

export type RuntimePlanError = {
  kind: 'missing_api_key' | 'provider_http_error' | 'provider_network_error' | 'provider_response_error' | 'provider_timeout'
  statusCode?: number
  message?: string
  toolNames?: string[]
  classification?: RuntimeProviderErrorClassification
  toolCallBoundary?: RuntimeToolCallBoundaryViolation
}

export type RuntimePlanResult = {
  source: RuntimePlannerSource
  steps: AgentToolCallStep[]
  assistantText?: string
  providerAssistantMessage?: Extract<RuntimeChatMessage, { role: 'assistant' }>
  providerArtifact?: RuntimeProviderArtifact
  toolInventorySnapshot?: AgentToolInventorySnapshot
  error?: RuntimePlanError
}

export type RuntimeProviderArtifact = {
  family: string
  thinkingLevel?: string
  reasoningText?: string
}

export type RuntimeStreamEvent =
  | {
      kind: 'stream_started'
      provider: string
      model: string
      source: RuntimePlannerSource
      requestTimeoutMs?: number
    }
  | {
      kind: 'content_delta'
      delta: string
      preview: string
    }
  | {
      kind: 'tool_call_delta'
      toolCallIndex: number
      toolName?: string
      argumentsDelta?: string
      argumentsPreview?: string
    }
  | {
      kind: 'tool_call_repaired'
      toolName: string
      toolCallId?: string
      leadingChars: number
      trailingChars: number
    }
  | {
      kind: 'tool_call_damage'
      toolCallIndex: number
      toolName?: string
      boundaryCode: ToolCallBoundaryViolationCode
      message: string
      retryable: boolean
    }
  | {
      kind: 'stream_completed'
      contentLength: number
      toolCallCount: number
      source?: RuntimePlannerSource
    }

export type RuntimeChatMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
  | {
      role: 'tool'
      content: string
      tool_call_id: string
      name?: string
    }

export type RuntimePlanningInput = {
  settings: Settings
  message: string
  context: unknown
  tools: ChatTool[]
  materializableToolNames?: string[]
  messages?: RuntimeChatMessage[]
  systemPrompt?: string
  stream?: boolean
  thinkingLevel?: string
  maxTokens?: number
  requestTimeoutMs?: number
  abortSignal?: AbortSignal
  onStreamEvent?: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null>
}

const OPENAI_AGENTS_SOURCE = 'openai_agents' as const
const OPENAI_COMPATIBLE_SOURCE = 'openai_compatible_tool_calls' as const
const DEFAULT_RUNTIME_SYSTEM_PROMPT = 'You are an Agentic OS runtime adapter. Follow the supplied host instructions and tool schema.'
const toolRegistryByName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))
const TOOL_CALL_BOUNDARY_CODES = new Set<ToolCallBoundaryViolationCode>([
  'tool_call_registered_but_deferred',
  'tool_call_not_in_effective_inventory',
  'tool_call_without_registered_handler',
  'tool_call_arguments_truncated',
  'tool_call_arguments_invalid',
  'tool_call_stream_interrupted',
])
const PROVIDER_ERROR_CLASSIFICATIONS = new Set<RuntimeProviderErrorClassification>([
  'unsupported_parameter',
  'auth',
  'billing',
  'rate_limit',
  'context_overflow',
  'server',
  'http',
])

function xoxBoundaryCode(value: string | undefined): ToolCallBoundaryViolationCode | null {
  if (value === undefined) return null
  return TOOL_CALL_BOUNDARY_CODES.has(value as ToolCallBoundaryViolationCode)
    ? value as ToolCallBoundaryViolationCode
    : null
}

function xoxProviderErrorClassification(
  value: string | undefined,
): RuntimeProviderErrorClassification | undefined {
  if (value === undefined) return undefined
  return PROVIDER_ERROR_CLASSIFICATIONS.has(value as RuntimeProviderErrorClassification)
    ? value as RuntimeProviderErrorClassification
    : undefined
}

function effectiveProviderRequestTimeoutMs(input: RuntimePlanningInput) {
  return Math.max(100, input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs)
}

function allowedToolNames(input: RuntimePlanningInput) {
  return input.tools.map((tool) => tool.function.name)
}

function runtimeToolCallBoundaryViolation(
  boundary: ProviderRuntimeToolCallBoundary | undefined,
): RuntimeToolCallBoundaryViolation | undefined {
  if (!boundary) return undefined
  const code = xoxBoundaryCode(boundary.code)
  if (!code) return undefined
  return {
    code,
    ...(boundary.toolName ? { toolName: boundary.toolName } : {}),
    toolNames: [...(boundary.toolNames ?? [])],
    effectiveToolNames: [...(boundary.effectiveToolNames ?? [])],
  }
}

function toolNamesFromBoundaryError(error: ProviderToolCallBoundaryError) {
  return error.failedToolName
    ? [error.failedToolName, ...error.toolNames.filter((name) => name !== error.failedToolName)]
    : error.toolNames
}

function plannerStepsFromProviderToolCalls(
  toolCalls: readonly NormalizedProviderToolCall[],
  effectiveToolNames: readonly string[],
): AgentToolCallStep[] {
  const steps: AgentToolCallStep[] = []
  const observedNames: string[] = []
  for (const call of toolCalls) {
    const step = toolCallToPlannerStep(call.toolName, call.arguments)
    if (!step) {
      throw new ProviderToolCallBoundaryError(
        `Provider emitted tool call "${call.toolName}" but no planner handler is registered for it.`,
        [call.toolName, ...observedNames.filter((name) => name !== call.toolName)],
        call.toolName,
        'tool_call_without_registered_handler',
        effectiveToolNames,
      )
    }
    step.providerToolName = call.toolName
    step.providerToolArguments = call.arguments
    step.providerToolCallIndex = call.providerToolCallIndex
    if (call.providerToolCallId) step.providerToolCallId = call.providerToolCallId
    steps.push(step)
    observedNames.push(call.toolName)
  }
  return steps
}

function runtimePlanErrorFromProviderError(error: OpenAICompatibleRuntimeTurnError): RuntimePlanError {
  const classification = xoxProviderErrorClassification(error.classification)
  const toolCallBoundary = runtimeToolCallBoundaryViolation(error.toolCallBoundary)
  return {
    kind: error.kind,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(error.message !== undefined ? { message: error.message } : {}),
    ...(error.toolNames !== undefined ? { toolNames: [...error.toolNames] } : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(toolCallBoundary !== undefined ? { toolCallBoundary } : {}),
  }
}

function runtimePlanErrorFromCaught(error: unknown): RuntimePlanError {
  if (error instanceof ProviderToolCallBoundaryError) {
    const toolCallBoundary = runtimeToolCallBoundaryViolation(error.boundaryViolation())
    const toolNames = toolNamesFromBoundaryError(error)
    return {
      kind: 'provider_response_error',
      message: safeProviderErrorMessage(error.message),
      ...(toolNames.length > 0 ? { toolNames } : {}),
      ...(toolCallBoundary ? { toolCallBoundary } : {}),
    }
  }
  return {
    kind: 'provider_network_error',
    message: safeProviderErrorMessage(error),
  }
}

function xoxAssistantReplayMessage(
  value: unknown,
): Extract<RuntimeChatMessage, { role: 'assistant' }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return record.role === 'assistant'
    ? value as Extract<RuntimeChatMessage, { role: 'assistant' }>
    : undefined
}

function xoxProviderArtifact(value: unknown): RuntimeProviderArtifact | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.family !== 'string') return undefined
  return {
    family: record.family,
    ...(typeof record.thinkingLevel === 'string' ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(typeof record.reasoningText === 'string' ? { reasoningText: record.reasoningText } : {}),
  }
}

function openAICompatibleRuntimePlanResult(input: {
  steps: AgentToolCallStep[]
  assistantText?: string
  providerAssistantMessage?: unknown
  providerArtifact?: unknown
}): RuntimePlanResult {
  const assistant = xoxAssistantReplayMessage(input.providerAssistantMessage)
  const artifact = xoxProviderArtifact(input.providerArtifact)
  return {
    source: OPENAI_COMPATIBLE_SOURCE,
    steps: input.steps,
    ...(input.assistantText ? { assistantText: input.assistantText } : {}),
    ...(assistant ? { providerAssistantMessage: assistant } : {}),
    ...(artifact ? { providerArtifact: artifact } : {}),
  }
}

async function emitOpenAICompatibleRuntimeTurnEvent(
  input: RuntimePlanningInput,
  event: OpenAICompatibleRuntimeTurnEvent,
) {
  if (!input.onStreamEvent) return
  if (event.kind === 'stream_started') {
    await input.onStreamEvent({
      ...event,
      source: OPENAI_COMPATIBLE_SOURCE,
    })
    return
  }
  if (event.kind === 'stream_completed') {
    await input.onStreamEvent({
      ...event,
      source: OPENAI_COMPATIBLE_SOURCE,
    })
    return
  }
  if (event.kind === 'tool_call_damage') {
    const boundaryCode = xoxBoundaryCode(event.boundaryCode)
    if (!boundaryCode) return
    const runtimeEvent: RuntimeStreamEvent = {
      ...event,
      boundaryCode,
    }
    await input.onStreamEvent(runtimeEvent)
    return
  }
  await input.onStreamEvent(event)
}

async function planWithOpenAICompatibleRuntime(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
  const output = await runOpenAICompatibleRuntimeTurn({
    provider: input.settings.openaiCompatibleProvider,
    model: input.settings.openaiCompatibleModel,
    baseUrl: input.settings.openaiCompatibleBaseUrl,
    apiKey: input.settings.openaiCompatibleApiKey,
    systemPrompt: input.systemPrompt ?? DEFAULT_RUNTIME_SYSTEM_PROMPT,
    userContent: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
    tools: input.tools,
    stream: input.stream ?? true,
    requestTimeoutMs: effectiveProviderRequestTimeoutMs(input),
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    ...(input.materializableToolNames !== undefined ? { materializableToolNames: input.materializableToolNames } : {}),
    ...(input.onStreamEvent !== undefined ? { onEvent: (event) => emitOpenAICompatibleRuntimeTurnEvent(input, event) } : {}),
  })

  if (output.error) {
    return {
      source: OPENAI_COMPATIBLE_SOURCE,
      steps: [],
      error: runtimePlanErrorFromProviderError(output.error),
    }
  }

  try {
    const steps = plannerStepsFromProviderToolCalls(output.toolCalls, allowedToolNames(input))
    return openAICompatibleRuntimePlanResult({
      steps,
      ...(output.assistantText !== undefined ? { assistantText: output.assistantText } : {}),
      ...(output.providerAssistantMessage !== undefined
        ? { providerAssistantMessage: output.providerAssistantMessage }
        : {}),
      ...(output.providerArtifact !== undefined ? { providerArtifact: output.providerArtifact } : {}),
    })
  } catch (error) {
    return {
      source: OPENAI_COMPATIBLE_SOURCE,
      steps: [],
      error: runtimePlanErrorFromCaught(error),
    }
  }
}

function promptFromOpenAIAgentsMessages(input: RuntimePlanningInput) {
  if (!input.messages || input.messages.length === 0) {
    return `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`
  }
  return input.messages
    .map((message) => {
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        return `assistant tool_calls: ${JSON.stringify(message.tool_calls)}`
      }
      if (message.role === 'tool') return `tool ${message.name ?? message.tool_call_id}: ${message.content}`
      return `${message.role}: ${message.content ?? ''}`
    })
    .join('\n')
}

function openAIAgentsRuntimeToolDescriptor(tool: ChatTool): RuntimeToolDescriptor {
  const name = tool.function.name
  const metadata = toolRegistryByName.get(name)
  const riskLevel = metadata?.riskLevel ?? 'read'
  const confirmationMode = metadata?.confirmationMode ?? 'never'
  const capability = metadata?.capability ?? 'tooling'
  return {
    name,
    title: name,
    description: tool.function.description,
    inputJsonSchema: toJsonObject(tool.function.parameters),
    capability,
    riskLevel,
    confirmationMode,
    authorityClass: inferToolAuthorityClass({
      capability,
      riskLevel,
      confirmationMode,
      manualBoundaryNotice: isManualBoundaryNoticeToolName(name),
      harnessManagedObservation: isHarnessManagedObservationToolName(name),
    }),
    navigationTarget: metadata?.navigationTarget ?? null,
  }
}

function plannerStepsFromOpenAIAgentsToolCalls(toolCalls: AgentToolCall[] | undefined): AgentToolCallStep[] {
  const steps: AgentToolCallStep[] = []
  for (const [index, call] of (toolCalls ?? []).entries()) {
    const step = toolCallToPlannerStep(call.name, call.input)
    if (!step) continue
    step.providerToolName = call.name
    step.providerToolArguments = call.input
    step.providerToolCallIndex = index
    step.providerToolCallId = call.toolCallId
    steps.push(step)
  }
  return steps
}

async function emitOpenAIAgentsRuntimeEvent(input: RuntimePlanningInput, event: OpenAIAgentsRuntimeEvent) {
  if (!input.onStreamEvent) return
  if (event.kind === 'run_started') {
    await input.onStreamEvent({
      kind: 'stream_started',
      provider: event.provider,
      model: event.model,
      source: OPENAI_AGENTS_SOURCE,
    })
    return
  }
  if (event.kind === 'tool_call') {
    await input.onStreamEvent({
      kind: 'tool_call_delta',
      toolCallIndex: event.toolCallIndex,
      toolName: event.toolName,
      argumentsPreview: event.argumentsPreview,
    })
    return
  }
  await input.onStreamEvent({
    kind: 'stream_completed',
    contentLength: event.contentLength,
    toolCallCount: event.toolCallCount,
    source: OPENAI_AGENTS_SOURCE,
  })
}

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function safeOpenAIAgentsRuntimeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .slice(0, 300)
}

async function planWithOpenAIAgentsRuntime(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
  if (!input.settings.openaiApiKey) {
    return {
      source: OPENAI_AGENTS_SOURCE,
      steps: [],
      error: { kind: 'missing_api_key' },
    }
  }

  try {
    const output = await runOpenAIAgentsTurn({
      userMessage: input.message,
      context: input.context,
      tools: input.tools.map(openAIAgentsRuntimeToolDescriptor),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    }, {
      apiKey: input.settings.openaiApiKey,
      ...(input.settings.openaiBaseUrl ? { baseURL: input.settings.openaiBaseUrl } : {}),
      model: input.settings.openaiModel,
      agentName: 'XOX Agent Planner',
      instructions: input.systemPrompt ?? DEFAULT_RUNTIME_SYSTEM_PROMPT,
      buildPrompt: () => promptFromOpenAIAgentsMessages(input),
      onEvent: (event) => emitOpenAIAgentsRuntimeEvent(input, event),
    })
    if (output.error) {
      return {
        source: OPENAI_AGENTS_SOURCE,
        steps: [],
        error: {
          kind: 'provider_network_error',
          message: safeOpenAIAgentsRuntimeErrorMessage(output.error),
        },
      }
    }

    const steps = plannerStepsFromOpenAIAgentsToolCalls(output.toolCalls)

    return steps.length > 0
      ? { source: OPENAI_AGENTS_SOURCE, steps }
      : output.assistantText?.trim()
        ? { source: OPENAI_AGENTS_SOURCE, steps: [], assistantText: output.assistantText.trim() }
        : { source: OPENAI_AGENTS_SOURCE, steps: [] }
  } catch (error) {
    return {
      source: OPENAI_AGENTS_SOURCE,
      steps: [],
      error: {
        kind: 'provider_network_error',
        message: safeOpenAIAgentsRuntimeErrorMessage(error),
      },
    }
  }
}

const PLANNING_USER_CONTENT_MAX_CHARS = 64_000
const XOX_HIGH_VOLUME_STRUCTURED_TOOL_NAMES = [
  'workspace_configure_operating_model',
  'sandbox_run_code',
] as const
const XOX_HIGH_VOLUME_STRUCTURED_MAX_TOKENS = 48_000
const XOX_HIGH_VOLUME_STRUCTURED_TIMEOUT_MS = 360_000
const XOX_PLANNING_POLICY_PROMPT = readFileSync(
  fileURLToPath(new URL('../host-profile/prompts/xox-planning-policy.md', import.meta.url)),
  'utf8',
).trim()

function plannerSystemPrompt() {
  return XOX_PLANNING_POLICY_PROMPT
}

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

function providerRetryEventMessage(error?: ProviderRuntimeRetryError) {
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

function runtimeObservedProviderToolNames(result: RuntimePlanResult | null | undefined) {
  return (result?.steps ?? [])
    .map((step) => step.providerToolName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function providerBoundaryResultForMissingObservation(
  first: RuntimePlanResult,
): RuntimePlanResult | null {
  if (first?.error?.kind !== 'provider_response_error') return null
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
  toolNames: readonly string[],
) {
  if (toolNames.length === 0) return
  const requiredGoalFacts = requiredFactsForToolEvidence(toolNames)
  await addRunEvent(ctx.db, agentServerRunLifecycleEvents.runtimeEvidenceRequired({
    threadId: ctx.threadId,
    runId: ctx.runId,
    toolNames,
    reason: 'provider_tool_call_without_observation_after_retry',
    requiredGoalFacts,
    copy: {
      title: '需要补齐工具证据',
      message: 'Provider 已产生工具调用意图，但重试后没有形成对应工具 observation；最终回答前必须补齐对应 evidence 或失败关闭。',
    },
  }))
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
    systemPrompt: plannerSystemPrompt(),
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
    await addRunEvent(ctx.db, agentServerRunLifecycleEvents.providerStableLongToolMode({
      threadId: ctx.threadId,
      runId: ctx.runId,
      provider: ctx.settings.openaiCompatibleProvider,
      toolName: stableToolName,
      stream: false,
      maxTokens,
      requestTimeoutMs: runtimeInput.requestTimeoutMs,
      copy: {
        title: '长参数工具稳定模式',
        message: '本轮包含大型结构化工具参数，已跳过易截断的流式 arguments，改用非流式长预算规划。',
      },
    }))
  }

  const result = await runOpenAICompatibleRuntimePlanningRecovery<RuntimePlanningInput, RuntimePlanResult>({
    input: runtimeInput,
    plan: (input) => planWithRuntimeAdapter(input),
    getToolName: (tool) => tool.function.name,
    baselineMaxTokens: runtimeInput.maxTokens ?? 1600,
    baselineRequestTimeoutMs: runtimeInput.requestTimeoutMs ?? runtimeInput.settings.agentProviderRequestTimeoutMs,
    highVolumeToolNames: XOX_HIGH_VOLUME_STRUCTURED_TOOL_NAMES,
    highVolumeRetryMaxTokens: XOX_HIGH_VOLUME_STRUCTURED_MAX_TOKENS,
    highVolumeRetryTimeoutMs: XOX_HIGH_VOLUME_STRUCTURED_TIMEOUT_MS,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    materializeDeferredTools: (input, toolNames) => runtimeInputWithMaterializedTools(input, toolCatalog, toolNames),
    observedToolNames: runtimeObservedProviderToolNames,
    boundaryResultForMissingObservation: ({ first }) => providerBoundaryResultForMissingObservation(first),
    decorateResult: (result, phase, input) => {
      if (phase === 'materialized') {
        return attachMaterializedToolInventory(result, toolCatalog, input.tools)
      }
      return attachToolInventory(result, toolCatalog)
    },
    onEvent: async (event) => {
      if (event.kind === 'deferred_tools_materializing') {
        await addRunEvent(ctx.db, agentServerRunLifecycleEvents.toolCatalogMaterializing({
          threadId: ctx.threadId,
          runId: ctx.runId,
          toolNames: event.toolNames,
          previousVisibleToolNames: toolCatalog.visibleToolNames,
          nextVisibleToolNames: event.nextInput.tools.map((tool) => tool.function.name),
          copy: {
            title: '工具目录扩展',
            message: '模型选择了已注册但尚未物化的工具，正在扩展本轮工具目录并重新规划。',
          },
        }))
        return
      }

      if (event.kind === 'provider_retrying') {
        await addRunEvent(ctx.db, agentServerRunLifecycleEvents.providerRetrying({
          threadId: ctx.threadId,
          runId: ctx.runId,
          provider: ctx.settings.openaiCompatibleProvider,
          errorKind: event.error?.kind,
          retryStream: event.retryInput.stream ?? true,
          retryTool: event.retryInput.tools.length === 1
            ? event.retryInput.tools[0]?.function.name ?? null
            : null,
          requestTimeoutMs: event.retryInput.requestTimeoutMs ?? ctx.settings.agentProviderRequestTimeoutMs,
          copy: {
            title: '模型服务请求重试',
            message: providerRetryEventMessage(event.error),
          },
        }))
        return
      }

      if (event.kind === 'runtime_evidence_required') {
        await addToolEvidenceRequirement(ctx, event.toolNames)
      }
    },
  })
  await addNonStreamPlanningPreface(ctx, result)
  return result
}

export function configuredRuntimePlannerSource(
  settings: Settings,
): Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'> | null {
  if (settings.llmProvider === 'rules') return null
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

export const planWithRuntimeAdapter = createRuntimePlanRouter<RuntimePlanningInput, RuntimePlanResult | null>({
  routes: [
    {
      routeId: 'rules',
      when: (input) => input.settings.llmProvider === 'rules',
      plan: () => null,
    },
    {
      routeId: 'openai',
      when: (input) => input.settings.llmProvider === 'openai',
      plan: (input) => planWithOpenAIAgentsRuntime(input),
    },
  ],
  fallback: (input) => planWithOpenAICompatibleRuntime(input),
})
