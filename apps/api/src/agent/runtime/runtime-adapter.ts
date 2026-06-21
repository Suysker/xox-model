import type {
  AgentToolCall,
  JsonObject,
  RuntimeToolDescriptor,
} from '@agentic-os/contracts'
import { createRuntimePlanRouter, inferToolAuthorityClass } from '@agentic-os/core'
import {
  runOpenAIAgentsTurn,
  type OpenAIAgentsRuntimeEvent,
} from '@agentic-os/runtime-openai-agents'
import {
  ProviderToolCallBoundaryError,
  runOpenAICompatibleRuntimeTurn,
  safeProviderErrorMessage,
  type NormalizedProviderToolCall,
  type OpenAICompatibleRuntimeTurnError,
  type OpenAICompatibleRuntimeTurnEvent,
  type ProviderRuntimeToolCallBoundary,
} from '@agentic-os/runtime-openai-compatible'
import type { AgentPlannerSource, AgentToolInventorySnapshot } from '@xox/contracts'
import type { Settings } from '../../core/settings.js'
import {
  AGENT_TOOL_REGISTRY,
  isHarnessManagedObservationToolName,
  isManualBoundaryNoticeToolName,
  toolCallToPlannerStep,
  type AgentToolCallStep,
  type ChatTool,
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
