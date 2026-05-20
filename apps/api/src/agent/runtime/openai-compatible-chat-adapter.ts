import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'
import type { AgentToolCallStep } from '../tool-catalog.js'
import { classifyProviderHttpError, providerRejectsToolChoice, safeProviderErrorMessage } from './provider-error-classifier.js'
import { shapeOpenAICompatibleChatRequest } from './provider-request-shaper.js'
import {
  ProviderToolCallParseError,
} from './tool-call-repair.js'
import type { ProviderModelProfile } from './provider-model-profile.js'
import { ToolCallStreamAssembler, type StreamingToolCall } from './tool-call-stream-assembler.js'
import { validateProviderToolCallsForExecution } from './tool-call-validator.js'

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

function safeProviderStreamText(value: string, maxLength: number) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .slice(0, maxLength)
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

function jsonPlanResult(
  body: any,
  input: RuntimePlanningInput,
  profile: ProviderModelProfile,
): RuntimePlanResult {
  const message = body?.choices?.[0]?.message
  const toolSteps = validateProviderToolCallsForExecution({
    toolCalls: message?.tool_calls,
    allowedToolNames: allowedToolNames(input),
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
  if (toolSteps.length > 0) return { source: SOURCE, steps: toolSteps }
  const assistantText = textContentFromMessage(message)
  return assistantText
    ? { source: SOURCE, steps: [], assistantText }
    : { source: SOURCE, steps: [] }
}

function sseDataFromRecord(record: string) {
  const data = record
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return data.trim().length > 0 ? data : null
}

async function readProviderStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Provider stream timed out after ${timeoutMs}ms without completing`)), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export class OpenAICompatibleChatAdapter implements RuntimeAdapter {
  readonly name = 'openai-compatible-chat'

  private async planFromStream(
    response: Response,
    input: RuntimePlanningInput,
    profile: ProviderModelProfile,
  ): Promise<RuntimePlanResult> {
    const reader = response.body?.getReader()
    if (!reader) return jsonPlanResult(await response.json(), input, profile)

    await input.onStreamEvent?.({
      kind: 'stream_started',
      provider: input.settings.openaiCompatibleProvider,
      model: input.settings.openaiCompatibleModel,
      source: SOURCE,
      requestTimeoutMs: effectiveProviderRequestTimeoutMs(input),
    })

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolAssembler = new ToolCallStreamAssembler()
    const toolTraceState = new Map<number, { argumentLength: number; flushedAt: number; emittedName: boolean }>()
    let contentTraceLength = 0
    let contentTraceFlushedAt = 0
    const requestTimeoutMs = effectiveProviderRequestTimeoutMs(input)
    const deadline = Date.now() + requestTimeoutMs

    const emitContentTrace = async (force = false) => {
      const delta = content.slice(contentTraceLength)
      if (delta.length <= 0) return
      const now = Date.now()
      if (
        !force &&
        delta.length < CONTENT_TRACE_FLUSH_CHARS &&
        now - contentTraceFlushedAt < STREAM_TRACE_FLUSH_INTERVAL_MS
      ) {
        return
      }
      contentTraceLength = content.length
      contentTraceFlushedAt = now
      await input.onStreamEvent?.({
        kind: 'content_delta',
        delta: safeProviderStreamText(delta, STREAM_DELTA_LIMIT),
        preview: safeProviderStreamText(content, STREAM_PREVIEW_LIMIT),
      })
    }

    const emitToolTrace = async (index: number, toolCall: StreamingToolCall, force = false) => {
      const previous = toolTraceState.get(index) ?? { argumentLength: 0, flushedAt: 0, emittedName: false }
      const argumentDelta = toolCall.arguments.slice(previous.argumentLength)
      const now = Date.now()
      const shouldEmitName = Boolean(toolCall.name) && !previous.emittedName
      if (
        !force &&
        !shouldEmitName &&
        argumentDelta.length < TOOL_TRACE_FLUSH_CHARS &&
        now - previous.flushedAt < STREAM_TRACE_FLUSH_INTERVAL_MS
      ) {
        return
      }
      toolTraceState.set(index, {
        argumentLength: toolCall.arguments.length,
        flushedAt: now,
        emittedName: previous.emittedName || Boolean(toolCall.name),
      })
      await input.onStreamEvent?.({
        kind: 'tool_call_delta',
        toolCallIndex: index,
        ...(toolCall.name ? { toolName: toolCall.name } : {}),
        ...(argumentDelta.length > 0 ? { argumentsDelta: safeProviderStreamText(argumentDelta, STREAM_DELTA_LIMIT) } : {}),
        ...(toolCall.arguments.length > 0
          ? { argumentsPreview: safeProviderStreamText(toolCall.arguments, STREAM_PREVIEW_LIMIT) }
          : {}),
      })
    }

    const handleRecord = async (record: string) => {
      const data = sseDataFromRecord(record)
      if (!data || data === '[DONE]') return
      const parsed = JSON.parse(data) as any
      const choices = Array.isArray(parsed?.choices) ? parsed.choices : []
      for (const choice of choices) {
        const delta = choice?.delta
        if (!delta || typeof delta !== 'object') continue
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content
          await emitContentTrace()
        }

        if (!Array.isArray(delta.tool_calls)) continue
        for (const toolDelta of delta.tool_calls) {
          const { index, toolCall } = toolAssembler.append(toolDelta)
          await emitToolTrace(index, toolCall)
        }
      }
    }

    while (true) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new ProviderTimeoutError(`Provider stream timed out after ${requestTimeoutMs}ms`, toolAssembler.toolNames())
      let chunk: Awaited<ReturnType<typeof readProviderStreamChunk>>
      try {
        chunk = await readProviderStreamChunk(reader, remainingMs)
      } catch (error) {
        if (error instanceof Error && error.message.includes('timed out')) {
          throw new ProviderTimeoutError(`Provider stream timed out after ${requestTimeoutMs}ms`, toolAssembler.toolNames())
        }
        throw error
      }
      const { done, value } = chunk
      if (value) buffer += decoder.decode(value, { stream: true })
      if (done) {
        buffer += decoder.decode()
        break
      }
      const records = buffer.split(/\r?\n\r?\n/)
      buffer = records.pop() ?? ''
      for (const record of records) await handleRecord(record)
    }

    const trailing = buffer.trim()
    if (trailing.length > 0) await handleRecord(trailing)
    await emitContentTrace(true)
    for (const [index, toolCall] of toolAssembler.entries()) await emitToolTrace(index, toolCall, true)

    await input.onStreamEvent?.({
      kind: 'stream_completed',
      contentLength: content.length,
      toolCallCount: toolAssembler.count(),
    })

    const normalizedToolCalls = toolAssembler.toProviderToolCalls()
    let toolSteps: AgentToolCallStep[]
    try {
      toolSteps = validateProviderToolCallsForExecution({
        toolCalls: normalizedToolCalls,
        allowedToolNames: allowedToolNames(input),
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
      if (error instanceof ProviderToolCallParseError) throw error
      const toolNames = normalizedToolCalls
        .map((toolCall) => toolCall.function?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      throw new ProviderToolCallParseError(
        error instanceof Error ? error.message : String(error),
        [...new Set(toolNames)],
      )
    }
    if (toolSteps.length > 0) return { source: SOURCE, steps: toolSteps }
    const assistantText = content.trim()
    return assistantText
      ? { source: SOURCE, steps: [], assistantText }
      : { source: SOURCE, steps: [] }
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
      const shape = (omitToolChoice = false) => shapeOpenAICompatibleChatRequest(input, { omitToolChoice })
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
        },
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (input.abortSignal) input.abortSignal.removeEventListener('abort', forwardAbort)
    }
  }
}
