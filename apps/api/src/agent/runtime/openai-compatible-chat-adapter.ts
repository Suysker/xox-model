import type {
  RuntimeAdapter,
  RuntimePlanningInput,
  RuntimePlanResult,
  RuntimeToolCallBoundaryViolation,
  ToolCallBoundaryViolationCode,
} from './runtime-adapter.js'
import { toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import { plannerSystemPrompt } from '../prompt-registry.js'
import {
  normalizeProviderToolCallsForExecution,
  normalizeOpenAICompatibleJsonTurnResult,
  normalizeOpenAICompatibleStreamTurnResult,
  OpenAICompatibleChatTransportTimeoutError,
  OpenAICompatibleProviderStreamInterruptedError,
  OpenAICompatibleProviderStreamTimeoutError,
  parseOpenAICompatibleStreamResponse,
  ProviderToolCallBoundaryError,
  requestOpenAICompatibleChatCompletion,
  type OpenAICompatibleProviderStreamParseResult,
  type OpenAICompatibleProviderTurnResult,
  type ProviderModelProfile,
  resolveProviderRuntimeCapability,
  resolveRuntimeThinkingLevel,
  safeProviderErrorMessage,
  shapeOpenAICompatibleChatRequest as shapeProviderOpenAICompatibleChatRequest,
  type ToolArgumentRepairPolicy,
} from '@agentic-os/runtime-openai-compatible'

const SOURCE = 'openai_compatible_tool_calls' as const
const STREAM_DELTA_LIMIT = 240
const STREAM_PREVIEW_LIMIT = 700
const CONTENT_TRACE_FLUSH_CHARS = 80
const TOOL_TRACE_FLUSH_CHARS = 320
const STREAM_TRACE_FLUSH_INTERVAL_MS = 250

class ProviderTimeoutError extends Error {
  constructor(
    message: string,
    readonly toolNames: string[] = [],
  ) {
    super(message)
    this.name = 'ProviderTimeoutError'
  }
}

const TOOL_CALL_BOUNDARY_CODES = new Set<ToolCallBoundaryViolationCode>([
  'tool_call_registered_but_deferred',
  'tool_call_not_in_effective_inventory',
  'tool_call_without_registered_handler',
  'tool_call_arguments_truncated',
  'tool_call_arguments_invalid',
  'tool_call_stream_interrupted',
])

function xoxBoundaryCode(value: string): ToolCallBoundaryViolationCode | null {
  return TOOL_CALL_BOUNDARY_CODES.has(value as ToolCallBoundaryViolationCode)
    ? value as ToolCallBoundaryViolationCode
    : null
}

class ProviderToolCallParseError extends ProviderToolCallBoundaryError {
  constructor(
    message: string,
    toolNames: string[],
    failedToolName?: string,
    boundaryCode?: ToolCallBoundaryViolationCode,
    effectiveToolNames: readonly string[] = [],
  ) {
    super(message, toolNames, failedToolName, boundaryCode, effectiveToolNames)
    this.name = 'ProviderToolCallParseError'
  }

  static from(error: ProviderToolCallBoundaryError): ProviderToolCallParseError {
    const code = error.boundaryCode ? xoxBoundaryCode(error.boundaryCode) : null
    return new ProviderToolCallParseError(
      error.message,
      error.toolNames,
      error.failedToolName,
      code ?? undefined,
      error.effectiveToolNames,
    )
  }

  override boundaryViolation(): RuntimeToolCallBoundaryViolation | undefined {
    const boundary = super.boundaryViolation()
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
}

type ProviderToolCallParseOptions = {
  argumentRepair?: ToolArgumentRepairPolicy
  onArgumentRepaired?: (event: {
    toolName: string
    toolCallId?: string
    leadingChars: number
    trailingChars: number
  }) => void
}

function plannerStepsFromProviderToolCalls(input: {
  toolCalls: unknown
  allowedToolNames: readonly string[]
  materializableToolNames?: readonly string[]
  options?: ProviderToolCallParseOptions
}): AgentToolCallStep[] {
  let calls: ReturnType<typeof normalizeProviderToolCallsForExecution>
  try {
    calls = normalizeProviderToolCallsForExecution({
      toolCalls: input.toolCalls,
      allowedToolNames: input.allowedToolNames,
      materializableToolNames: input.materializableToolNames ?? [],
      ...(input.options?.argumentRepair ? { argumentRepair: input.options.argumentRepair } : {}),
      ...(input.options?.onArgumentRepaired ? { onArgumentRepaired: input.options.onArgumentRepaired } : {}),
    })
  } catch (error) {
    if (error instanceof ProviderToolCallBoundaryError) throw ProviderToolCallParseError.from(error)
    throw error
  }

  const steps: AgentToolCallStep[] = []
  const observedNames: string[] = []
  for (const call of calls) {
    const step = toolCallToPlannerStep(call.toolName, call.arguments)
    if (!step) {
      throw new ProviderToolCallParseError(
        `Provider emitted tool call "${call.toolName}" but no planner handler is registered for it.`,
        [call.toolName, ...observedNames.filter((name) => name !== call.toolName)],
        call.toolName,
        'tool_call_without_registered_handler',
        input.allowedToolNames,
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

function isProviderResponseParseError(error: unknown) {
  return error instanceof SyntaxError || error instanceof ProviderToolCallParseError
}

function providerToolNamesFromError(error: unknown) {
  if (error instanceof ProviderToolCallParseError) {
    return error.failedToolName
      ? [error.failedToolName, ...error.toolNames.filter((name) => name !== error.failedToolName)]
      : error.toolNames
  }
  return error instanceof ProviderTimeoutError ? error.toolNames : undefined
}

function isProviderTimeoutError(error: unknown) {
  return error instanceof ProviderTimeoutError || error instanceof OpenAICompatibleChatTransportTimeoutError
}

function effectiveProviderRequestTimeoutMs(input: RuntimePlanningInput) {
  return Math.max(100, input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs)
}

function allowedToolNames(input: RuntimePlanningInput) {
  return input.tools.map((tool) => tool.function.name)
}

function shapeOpenAICompatibleRuntimeRequest(
  input: RuntimePlanningInput,
  options: {
    omitToolChoice?: boolean
    thinkingLevel?: string
  } = {},
) {
  const requestedThinkingLevel = options.thinkingLevel ?? input.thinkingLevel
  return shapeProviderOpenAICompatibleChatRequest({
    provider: input.settings.openaiCompatibleProvider,
    model: input.settings.openaiCompatibleModel,
    systemPrompt: input.systemPrompt ?? plannerSystemPrompt(),
    userContent: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
    tools: input.tools,
    stream: input.stream ?? true,
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(requestedThinkingLevel !== undefined ? { thinkingLevel: requestedThinkingLevel } : {}),
    ...(options.omitToolChoice !== undefined ? { omitToolChoice: options.omitToolChoice } : {}),
  })
}

function argumentRepairPolicy(profile: ProviderModelProfile) {
  return {
    enabled: profile.streamArgumentRepair === 'bounded-balanced-json',
  }
}

function providerRuntimeContext(input: RuntimePlanningInput, profile: ProviderModelProfile) {
  const capability = resolveProviderRuntimeCapability(profile)
  const thinkingLevel = resolveRuntimeThinkingLevel({
    capability,
    requested: input.thinkingLevel,
  })
  return { capability, thinkingLevel }
}

function withProviderState(
  base: Omit<RuntimePlanResult, 'providerAssistantMessage' | 'providerArtifact'>,
  assistantMessage: RuntimePlanResult['providerAssistantMessage'] | undefined,
  artifact: NonNullable<RuntimePlanResult['providerArtifact']>,
): RuntimePlanResult {
  return {
    ...base,
    ...(assistantMessage ? { providerAssistantMessage: assistantMessage } : {}),
    providerArtifact: artifact,
  }
}

function providerTurnResult(input: () => OpenAICompatibleProviderTurnResult) {
  try {
    return input()
  } catch (error) {
    if (error instanceof ProviderToolCallBoundaryError) throw ProviderToolCallParseError.from(error)
    throw error
  }
}

function planResultFromProviderTurn(
  turn: OpenAICompatibleProviderTurnResult,
  input: RuntimePlanningInput,
  profile: ProviderModelProfile,
): RuntimePlanResult {
  const toolSteps = plannerStepsFromProviderToolCalls({
    toolCalls: turn.toolCalls,
    allowedToolNames: allowedToolNames(input),
    materializableToolNames: input.materializableToolNames ?? [],
    options: {
      argumentRepair: argumentRepairPolicy(profile),
      onArgumentRepaired: (event) => {
        void input.onStreamEvent?.({
          kind: 'tool_call_repaired',
          toolName: event.toolName,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          leadingChars: event.leadingChars,
          trailingChars: event.trailingChars,
        })
      },
    },
  })
  const assistantMessage = turn.providerAssistantMessage as RuntimePlanResult['providerAssistantMessage'] | undefined
  const artifact = turn.providerArtifact as NonNullable<RuntimePlanResult['providerArtifact']>
  if (toolSteps.length > 0) {
    return turn.assistantText
      ? withProviderState({ source: SOURCE, steps: toolSteps, assistantText: turn.assistantText }, assistantMessage, artifact)
      : withProviderState({ source: SOURCE, steps: toolSteps }, assistantMessage, artifact)
  }
  return turn.assistantText
    ? withProviderState({ source: SOURCE, steps: [], assistantText: turn.assistantText }, assistantMessage, artifact)
    : withProviderState({ source: SOURCE, steps: [] }, assistantMessage, artifact)
}

function jsonPlanResult(
  body: any,
  input: RuntimePlanningInput,
  profile: ProviderModelProfile,
): RuntimePlanResult {
  const turn = providerTurnResult(() => normalizeOpenAICompatibleJsonTurnResult({
    body,
    profile,
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    allowedToolNames: allowedToolNames(input),
  }))
  return planResultFromProviderTurn(turn, input, profile)
}

export class OpenAICompatibleChatAdapter implements RuntimeAdapter {
  readonly name = 'openai-compatible-chat'

  private async planFromStream(
    response: Response,
    input: RuntimePlanningInput,
    profile: ProviderModelProfile,
  ): Promise<RuntimePlanResult> {
    if (!response.body) return jsonPlanResult(await response.json(), input, profile)
    const requestTimeoutMs = effectiveProviderRequestTimeoutMs(input)

    await input.onStreamEvent?.({
      kind: 'stream_started',
      provider: input.settings.openaiCompatibleProvider,
      model: input.settings.openaiCompatibleModel,
      source: SOURCE,
      requestTimeoutMs,
    })

    const { thinkingLevel } = providerRuntimeContext(input, profile)
    let parsed: OpenAICompatibleProviderStreamParseResult

    const emitToolFrameDamage = async (
      error: ProviderToolCallParseError,
      parsedResult: OpenAICompatibleProviderStreamParseResult,
    ) => {
      const boundary = error.boundaryViolation()
      if (!boundary) return
      const toolNameSet = new Set(error.toolNames)
      for (const frame of parsedResult.frames) {
        const frameToolName = frame.name ?? frame.providerCallId ?? frame.id
        if (toolNameSet.size > 0 && !toolNameSet.has(frameToolName)) continue
        await input.onStreamEvent?.({
          kind: 'tool_call_damage',
          toolCallIndex: frame.index,
          ...(frame.name ? { toolName: frame.name } : {}),
          boundaryCode: boundary.code,
          message: error.message,
          retryable:
            boundary.code === 'tool_call_arguments_truncated' ||
            boundary.code === 'tool_call_arguments_invalid' ||
            boundary.code === 'tool_call_stream_interrupted',
        })
      }
    }

    const providerToolCallParseError = (inputError: {
      message: string
      boundaryCode: ToolCallBoundaryViolationCode
      toolName?: string
      toolNames?: string[]
    }) => {
      const toolNames = inputError.toolName
        ? [inputError.toolName]
        : inputError.toolNames ?? []
      return new ProviderToolCallParseError(
        inputError.message,
        toolNames,
        inputError.toolName ?? toolNames[0],
        inputError.boundaryCode,
        allowedToolNames(input),
      )
    }

    try {
      parsed = await parseOpenAICompatibleStreamResponse({
        stream: response.body,
        provider: input.settings.openaiCompatibleProvider,
        model: input.settings.openaiCompatibleModel,
        profile,
        thinkingLevel,
        timeoutMs: requestTimeoutMs,
        deltaLimit: STREAM_DELTA_LIMIT,
        previewLimit: STREAM_PREVIEW_LIMIT,
        contentFlushChars: CONTENT_TRACE_FLUSH_CHARS,
        toolFlushChars: TOOL_TRACE_FLUSH_CHARS,
        flushIntervalMs: STREAM_TRACE_FLUSH_INTERVAL_MS,
        onEvent: (event) => input.onStreamEvent?.(event),
      })
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderStreamTimeoutError) {
        throw new ProviderTimeoutError(error.message, error.toolNames)
      }
      if (error instanceof OpenAICompatibleProviderStreamInterruptedError) {
        throw providerToolCallParseError({
          message: error.message,
          boundaryCode: error.boundaryCode,
          toolNames: error.toolNames,
        })
      }
      throw error
    }

    const damagedFrame = parsed.frames.find((frame) => frame.damage)
    if (damagedFrame?.damage) {
      const frameError = providerToolCallParseError({
        message: damagedFrame.damage.message,
        boundaryCode: damagedFrame.damage.kind,
        ...(damagedFrame.name ? { toolName: damagedFrame.name } : {}),
      })
      throw frameError
    }

    const turn = providerTurnResult(() => normalizeOpenAICompatibleStreamTurnResult({
      streamResult: parsed,
      profile,
      thinkingLevel,
      allowedToolNames: allowedToolNames(input),
    }))
    let toolSteps: AgentToolCallStep[]
    try {
      toolSteps = plannerStepsFromProviderToolCalls({
        toolCalls: turn.toolCalls,
        allowedToolNames: allowedToolNames(input),
        materializableToolNames: input.materializableToolNames ?? [],
        options: {
          argumentRepair: argumentRepairPolicy(profile),
          onArgumentRepaired: (event) => {
            void input.onStreamEvent?.({
              kind: 'tool_call_repaired',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
              leadingChars: event.leadingChars,
              trailingChars: event.trailingChars,
            })
          },
        },
      })
    } catch (error) {
      if (error instanceof ProviderToolCallParseError) {
        await emitToolFrameDamage(error, parsed)
        throw error
      }
      const toolNames = turn.toolCalls
        .map((toolCall) => toolCall.function?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      const wrapped = new ProviderToolCallParseError(
        error instanceof Error ? error.message : String(error),
        [...new Set(toolNames)],
      )
      await emitToolFrameDamage(wrapped, parsed)
      throw wrapped
    }
    const assistantMessage = turn.providerAssistantMessage as RuntimePlanResult['providerAssistantMessage'] | undefined
    const artifact = turn.providerArtifact as NonNullable<RuntimePlanResult['providerArtifact']>
    if (toolSteps.length > 0) return withProviderState({ source: SOURCE, steps: toolSteps }, assistantMessage, artifact)
    return turn.assistantText
      ? withProviderState({ source: SOURCE, steps: [], assistantText: turn.assistantText }, assistantMessage, artifact)
      : withProviderState({ source: SOURCE, steps: [] }, assistantMessage, artifact)
  }

  async plan(input: RuntimePlanningInput): Promise<RuntimePlanResult | null> {
    if (!input.settings.openaiCompatibleApiKey) {
      return {
        source: SOURCE,
        steps: [],
        error: { kind: 'missing_api_key' },
      }
    }

    try {
      const requestTimeoutMs = effectiveProviderRequestTimeoutMs(input)
      const transport = await requestOpenAICompatibleChatCompletion({
        baseUrl: input.settings.openaiCompatibleBaseUrl,
        apiKey: input.settings.openaiCompatibleApiKey,
        timeoutMs: requestTimeoutMs,
        abortGraceMs: 1_000,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
        shapeRequest: ({ omitToolChoice }) => shapeOpenAICompatibleRuntimeRequest(input, {
          ...(omitToolChoice !== undefined ? { omitToolChoice } : {}),
          ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
        }),
      })
      if (transport.kind === 'http_error') {
        return {
          source: SOURCE,
          steps: [],
          error: transport.error,
        }
      }
      if (transport.contentType.toLowerCase().includes('text/event-stream')) {
        return await this.planFromStream(transport.response as unknown as Response, input, transport.requestShape.profile)
      }
      return jsonPlanResult(await transport.response.json(), input, transport.requestShape.profile)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const toolNames = providerToolNamesFromError(error)
      const toolCallBoundary = error instanceof ProviderToolCallParseError ? error.boundaryViolation() : undefined
      return {
        source: SOURCE,
        steps: [],
        error: {
          kind: isProviderTimeoutError(error)
            ? 'provider_timeout'
            : isProviderResponseParseError(error)
              ? 'provider_response_error'
              : 'provider_network_error',
          message: safeProviderErrorMessage(message),
          ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
          ...(toolCallBoundary ? { toolCallBoundary } : {}),
        },
      }
    }
  }
}
