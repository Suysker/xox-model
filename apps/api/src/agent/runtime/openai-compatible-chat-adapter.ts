import type {
  NormalizedProviderToolCall,
  OpenAICompatibleRuntimeTurnError,
  OpenAICompatibleRuntimeTurnEvent,
  ProviderRuntimeToolCallBoundary,
} from '@agentic-os/runtime-openai-compatible'
import {
  ProviderToolCallBoundaryError,
  runOpenAICompatibleRuntimeTurn,
  safeProviderErrorMessage,
} from '@agentic-os/runtime-openai-compatible'
import { plannerSystemPrompt } from '../prompt-registry.js'
import {
  toolCallToPlannerStep,
  type AgentToolCallStep,
} from '../tool-catalog.js'
import type {
  RuntimeAdapter,
  RuntimeChatMessage,
  RuntimePlanError,
  RuntimePlanResult,
  RuntimePlannerSource,
  RuntimePlanningInput,
  RuntimeProviderArtifact,
  RuntimeProviderErrorClassification,
  RuntimeStreamEvent,
  RuntimeToolCallBoundaryViolation,
  ToolCallBoundaryViolationCode,
} from './runtime-adapter.js'

const SOURCE = 'openai_compatible_tool_calls' as const satisfies RuntimePlannerSource

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

function runtimePlanResult(input: {
  steps: AgentToolCallStep[]
  assistantText?: string
  providerAssistantMessage?: unknown
  providerArtifact?: unknown
}): RuntimePlanResult {
  const assistant = xoxAssistantReplayMessage(input.providerAssistantMessage)
  const artifact = xoxProviderArtifact(input.providerArtifact)
  return {
    source: SOURCE,
    steps: input.steps,
    ...(input.assistantText ? { assistantText: input.assistantText } : {}),
    ...(assistant ? { providerAssistantMessage: assistant } : {}),
    ...(artifact ? { providerArtifact: artifact } : {}),
  }
}

async function emitRuntimeTurnEvent(
  input: RuntimePlanningInput,
  event: OpenAICompatibleRuntimeTurnEvent,
) {
  if (!input.onStreamEvent) return
  if (event.kind === 'stream_started') {
    await input.onStreamEvent({
      ...event,
      source: SOURCE,
    })
    return
  }
  if (event.kind === 'stream_completed') {
    await input.onStreamEvent({
      ...event,
      source: SOURCE,
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

export class OpenAICompatibleChatAdapter implements RuntimeAdapter {
  readonly name = 'openai-compatible-chat'

  async plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
    const output = await runOpenAICompatibleRuntimeTurn({
      provider: input.settings.openaiCompatibleProvider,
      model: input.settings.openaiCompatibleModel,
      baseUrl: input.settings.openaiCompatibleBaseUrl,
      apiKey: input.settings.openaiCompatibleApiKey,
      systemPrompt: input.systemPrompt ?? plannerSystemPrompt(),
      userContent: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
      tools: input.tools,
      stream: input.stream ?? true,
      requestTimeoutMs: effectiveProviderRequestTimeoutMs(input),
      ...(input.messages !== undefined ? { messages: input.messages } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.materializableToolNames !== undefined ? { materializableToolNames: input.materializableToolNames } : {}),
      ...(input.onStreamEvent !== undefined ? { onEvent: (event) => emitRuntimeTurnEvent(input, event) } : {}),
    })

    if (output.error) {
      return {
        source: SOURCE,
        steps: [],
        error: runtimePlanErrorFromProviderError(output.error),
      }
    }

    try {
      const steps = plannerStepsFromProviderToolCalls(output.toolCalls, allowedToolNames(input))
      return runtimePlanResult({
        steps,
        ...(output.assistantText !== undefined ? { assistantText: output.assistantText } : {}),
        ...(output.providerAssistantMessage !== undefined
          ? { providerAssistantMessage: output.providerAssistantMessage }
          : {}),
        ...(output.providerArtifact !== undefined ? { providerArtifact: output.providerArtifact } : {}),
      })
    } catch (error) {
      return {
        source: SOURCE,
        steps: [],
        error: runtimePlanErrorFromCaught(error),
      }
    }
  }
}
