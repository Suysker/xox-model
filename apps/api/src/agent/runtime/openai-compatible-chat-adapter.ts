import type {
  RuntimeAdapter,
  RuntimePlanningInput,
  RuntimePlanResult,
  ToolCallBoundaryViolationCode,
} from './runtime-adapter.js'
import type { AgentToolCallStep } from '../tool-catalog.js'
import { shapeOpenAICompatibleChatRequest } from './provider-request-shaper.js'
import {
  ProviderToolCallParseError,
} from './tool-call-repair.js'
import { validateProviderToolCallsForExecution } from './tool-call-validator.js'
import {
  classifyProviderHttpError,
  detectProviderPlainTextToolCallArtifact,
  OpenAICompatibleProviderStreamInterruptedError,
  OpenAICompatibleProviderStreamTimeoutError,
  parseOpenAICompatibleStreamResponse,
  providerRejectsToolChoice,
  recoverProviderPlainTextToolCalls,
  type OpenAICompatibleProviderStreamParseResult,
  type ProviderModelProfile,
  resolveProviderRuntimeCapability,
  resolveRuntimeThinkingLevel,
  safeProviderErrorMessage,
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
  return error instanceof ProviderTimeoutError
}

function effectiveProviderRequestTimeoutMs(input: RuntimePlanningInput) {
  return Math.max(100, input.requestTimeoutMs ?? input.settings.agentProviderRequestTimeoutMs)
}

function textContentFromMessage(message: any) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
    .trim()
}

function allowedToolNames(input: RuntimePlanningInput) {
  return input.tools.map((tool) => tool.function.name)
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

function reasoningTextFromObject(value: Record<string, unknown> | null | undefined, keys: readonly string[]) {
  if (!value) return ''
  return keys
    .map((key) => value[key])
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('')
}

function providerArtifact(input: RuntimePlanningInput, profile: ProviderModelProfile, reasoningText: string) {
  const { capability, thinkingLevel } = providerRuntimeContext(input, profile)
  return {
    family: capability.family,
    thinkingLevel,
    ...(reasoningText ? { reasoningText } : {}),
  }
}

function providerAssistantMessage(input: RuntimePlanningInput, profile: ProviderModelProfile, message: any) {
  if (!message || typeof message !== 'object') return undefined
  const { capability, thinkingLevel } = providerRuntimeContext(input, profile)
  const replayPolicy = capability.buildReplayPolicy({ profile, thinkingLevel })
  const assistant: Record<string, unknown> = {
    role: 'assistant',
    content: message.content ?? null,
  }
  if (Array.isArray(message.tool_calls)) assistant.tool_calls = message.tool_calls
  for (const key of replayPolicy.preservedAssistantMessageKeys) {
    if (message[key] !== undefined) assistant[key] = message[key]
  }
  for (const item of replayPolicy.assistantMessageBackfill) {
    if (assistant[item.key] === undefined) assistant[item.key] = item.value
  }
  return assistant as RuntimePlanResult['providerAssistantMessage']
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

function validatePromotedPlainTextToolCalls(input: {
  text: string
  runtimeInput: RuntimePlanningInput
  profile: ProviderModelProfile
  artifact: NonNullable<RuntimePlanResult['providerArtifact']>
  message?: Record<string, unknown> | null
}) {
  const allowed = allowedToolNames(input.runtimeInput)
  const artifact = detectProviderPlainTextToolCallArtifact(input.text)
  if (allowed.length === 0) {
    if (!artifact) return null
    const failedToolName = artifact.toolNames[0]
    throw new ProviderToolCallParseError(
      failedToolName
        ? `Provider emitted plain-text tool call "${failedToolName}" after the tool inventory was closed.`
        : 'Provider emitted a plain-text tool call artifact after the tool inventory was closed.',
      artifact.toolNames,
      failedToolName,
      failedToolName ? 'tool_call_not_in_effective_inventory' : 'tool_call_arguments_invalid',
      allowed,
    )
  }
  const recovered = recoverProviderPlainTextToolCalls({
    text: input.text,
    allowedToolNames: allowed,
  })
  if (!recovered) {
    if (!artifact) return null
    const failedToolName = artifact.toolNames[0]
    throw new ProviderToolCallParseError(
      failedToolName
        ? `Provider emitted plain-text tool call "${failedToolName}" outside the current structured tool inventory.`
        : 'Provider emitted a plain-text tool call artifact that could not be converted into structured tool_calls.',
      artifact.toolNames,
      failedToolName,
      failedToolName ? 'tool_call_not_in_effective_inventory' : 'tool_call_arguments_invalid',
      allowed,
    )
  }
  const toolSteps = validateProviderToolCallsForExecution({
    toolCalls: recovered.openAiToolCalls,
    allowedToolNames: allowed,
    materializableToolNames: input.runtimeInput.materializableToolNames ?? [],
    options: {
      argumentRepair: argumentRepairPolicy(input.profile),
      onArgumentRepaired: (event) => {
        void input.runtimeInput.onStreamEvent?.({
          kind: 'tool_call_repaired',
          toolName: event.toolName,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          leadingChars: event.leadingChars,
          trailingChars: event.trailingChars,
        })
      },
    },
  })
  const providerMessage = providerAssistantMessage(input.runtimeInput, input.profile, {
    ...(input.message ?? {}),
    role: 'assistant',
    content: recovered.visibleText || null,
    tool_calls: recovered.openAiToolCalls,
  })
  return recovered.visibleText
    ? withProviderState({ source: SOURCE, steps: toolSteps, assistantText: recovered.visibleText }, providerMessage, input.artifact)
    : withProviderState({ source: SOURCE, steps: toolSteps }, providerMessage, input.artifact)
}

function jsonPlanResult(
  body: any,
  input: RuntimePlanningInput,
  profile: ProviderModelProfile,
): RuntimePlanResult {
  const message = body?.choices?.[0]?.message
  const { capability } = providerRuntimeContext(input, profile)
  const reasoningText = reasoningTextFromObject(message, capability.reasoningDeltaKeys)
  const assistantMessage = providerAssistantMessage(input, profile, message)
  const artifact = providerArtifact(input, profile, reasoningText)
  const toolSteps = validateProviderToolCallsForExecution({
    toolCalls: message?.tool_calls,
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
  const assistantText = textContentFromMessage(message)
  if (toolSteps.length > 0) {
    return assistantText
      ? withProviderState({ source: SOURCE, steps: toolSteps, assistantText }, assistantMessage, artifact)
      : withProviderState({ source: SOURCE, steps: toolSteps }, assistantMessage, artifact)
  }
  const promoted = assistantText
    ? validatePromotedPlainTextToolCalls({
      text: assistantText,
      runtimeInput: input,
      profile,
      artifact,
      message,
    })
    : null
  if (promoted) return promoted
  return assistantText
    ? withProviderState({ source: SOURCE, steps: [], assistantText }, assistantMessage, artifact)
    : withProviderState({ source: SOURCE, steps: [] }, assistantMessage, artifact)
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

    const { capability, thinkingLevel } = providerRuntimeContext(input, profile)
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

    const normalizedToolCalls = parsed.toolCalls
    const assistantMessage = providerAssistantMessage(input, profile, {
      role: 'assistant',
      content: parsed.content.trim() || null,
      tool_calls: normalizedToolCalls,
      ...(parsed.reasoningText ? Object.fromEntries(capability.reasoningDeltaKeys.slice(0, 1).map((key) => [key, parsed.reasoningText])) : {}),
    })
    const artifact = providerArtifact(input, profile, parsed.reasoningText)
    let toolSteps: AgentToolCallStep[]
    try {
      toolSteps = validateProviderToolCallsForExecution({
        toolCalls: normalizedToolCalls,
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
      const toolNames = normalizedToolCalls
        .map((toolCall) => toolCall.function?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      const wrapped = new ProviderToolCallParseError(
        error instanceof Error ? error.message : String(error),
        [...new Set(toolNames)],
      )
      await emitToolFrameDamage(wrapped, parsed)
      throw wrapped
    }
    if (toolSteps.length > 0) return withProviderState({ source: SOURCE, steps: toolSteps }, assistantMessage, artifact)
    const assistantText = parsed.content.trim()
    const promoted = assistantText
      ? validatePromotedPlainTextToolCalls({
        text: assistantText,
        runtimeInput: input,
        profile,
        artifact,
        message: {
          role: 'assistant',
          ...(parsed.reasoningText ? Object.fromEntries(capability.reasoningDeltaKeys.slice(0, 1).map((key) => [key, parsed.reasoningText])) : {}),
        },
      })
      : null
    if (promoted) return promoted
    return assistantText
      ? withProviderState({ source: SOURCE, steps: [], assistantText }, assistantMessage, artifact)
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

    let providerTimedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const abortController = new AbortController()
    const forwardAbort = () => abortController.abort(input.abortSignal?.reason)
    if (input.abortSignal?.aborted) {
      forwardAbort()
    } else if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', forwardAbort, { once: true })
    }

    try {
      const requestTimeoutMs = effectiveProviderRequestTimeoutMs(input)
      timeout = setTimeout(() => {
        providerTimedOut = true
        abortController.abort(new Error(`Provider request timed out after ${requestTimeoutMs}ms`))
      }, requestTimeoutMs + 1_000)
      timeout.unref?.()
      const endpoint = `${input.settings.openaiCompatibleBaseUrl.replace(/\/$/, '')}/chat/completions`
      const shape = (omitToolChoice = false) => shapeOpenAICompatibleChatRequest(input, {
        omitToolChoice,
        ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      })
      const init = (omitToolChoice = false): RequestInit => {
        const requestShape = shape(omitToolChoice)
        return {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.settings.openaiCompatibleApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestShape.body),
          signal: abortController.signal,
        }
      }
      let requestShape = shape(false)
      let response = await fetch(endpoint, init(false))

      if (!response.ok) {
        let providerMessage = await response.text().catch(() => '')
        if (providerRejectsToolChoice(response.status, providerMessage) && input.tools.length > 0 && !abortController.signal.aborted) {
          requestShape = shape(true)
          response = await fetch(endpoint, init(true))
          if (response.ok) {
            const contentType = response.headers.get('content-type') ?? ''
            if (contentType.toLowerCase().includes('text/event-stream')) return await this.planFromStream(response, input, requestShape.profile)
            return jsonPlanResult(await response.json(), input, requestShape.profile)
          }
          providerMessage = await response.text().catch(() => '')
        }
        const classified = classifyProviderHttpError(response.status, providerMessage || response.statusText)
        return {
          source: SOURCE,
          steps: [],
          error: classified,
        }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.toLowerCase().includes('text/event-stream')) return await this.planFromStream(response, input, requestShape.profile)
      return jsonPlanResult(await response.json(), input, requestShape.profile)
    } catch (error) {
      const requestTimeoutMs = effectiveProviderRequestTimeoutMs(input)
      const message = providerTimedOut
        ? `Provider request timed out after ${requestTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error)
      const toolNames = providerToolNamesFromError(error)
      const toolCallBoundary = error instanceof ProviderToolCallParseError ? error.boundaryViolation() : undefined
      return {
        source: SOURCE,
        steps: [],
        error: {
          kind: providerTimedOut || isProviderTimeoutError(error)
            ? 'provider_timeout'
            : isProviderResponseParseError(error)
              ? 'provider_response_error'
              : 'provider_network_error',
          message: safeProviderErrorMessage(message),
          ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
          ...(toolCallBoundary ? { toolCallBoundary } : {}),
        },
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (input.abortSignal) input.abortSignal.removeEventListener('abort', forwardAbort)
    }
  }
}
