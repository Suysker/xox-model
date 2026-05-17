import { plannerSystemPrompt } from '../prompt-registry.js'
import { toolCallToPlannerStep, type AgentToolCallStep } from '../tool-catalog.js'
import type { RuntimeAdapter, RuntimePlanningInput, RuntimePlanResult } from './runtime-adapter.js'

const SOURCE = 'openai_compatible_tool_calls' as const
const STREAM_DELTA_LIMIT = 240
const STREAM_PREVIEW_LIMIT = 700

type StreamingToolCall = {
  id?: string
  type?: string
  name?: string
  arguments: string
}

function parseToolArguments(raw: unknown) {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

function safeProviderErrorMessage(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .slice(0, 300)
}

function safeProviderStreamText(value: string, maxLength: number) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .slice(0, maxLength)
}

function plannerStepsFromToolCalls(toolCalls: unknown): AgentToolCallStep[] {
  if (!Array.isArray(toolCalls)) return []
  const steps: AgentToolCallStep[] = []
  for (const toolCall of toolCalls) {
    const fn = (toolCall as any)?.function
    const name = fn?.name
    if (typeof name !== 'string') continue
    const args = parseToolArguments(fn?.arguments)
    const step = toolCallToPlannerStep(name, args)
    if (step) steps.push(step)
  }
  return steps
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

function jsonPlanResult(body: any): RuntimePlanResult {
  const message = body?.choices?.[0]?.message
  const toolSteps = plannerStepsFromToolCalls(message?.tool_calls)
  if (toolSteps.length > 0) return { source: SOURCE, steps: toolSteps }
  const assistantText = textContentFromMessage(message)
  return assistantText
    ? { source: SOURCE, steps: [], assistantText }
    : { source: SOURCE, steps: [] }
}

function normalizeStreamingToolCalls(toolCalls: Map<number, StreamingToolCall>) {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, toolCall]) => typeof toolCall.name === 'string' && toolCall.name.trim().length > 0)
    .map(([index, toolCall]) => ({
      id: toolCall.id ?? `call_${index}`,
      type: toolCall.type ?? 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }))
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

export class OpenAICompatibleChatAdapter implements RuntimeAdapter {
  readonly name = 'openai-compatible-chat'

  private async planFromStream(response: Response, input: RuntimePlanningInput): Promise<RuntimePlanResult> {
    const reader = response.body?.getReader()
    if (!reader) return jsonPlanResult(await response.json())

    await input.onStreamEvent?.({
      kind: 'stream_started',
      provider: input.settings.openaiCompatibleProvider,
      model: input.settings.openaiCompatibleModel,
      source: SOURCE,
    })

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolCalls = new Map<number, StreamingToolCall>()

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
          await input.onStreamEvent?.({
            kind: 'content_delta',
            delta: safeProviderStreamText(delta.content, STREAM_DELTA_LIMIT),
            preview: safeProviderStreamText(content, STREAM_PREVIEW_LIMIT),
          })
        }

        if (!Array.isArray(delta.tool_calls)) continue
        for (const toolDelta of delta.tool_calls) {
          const index = Number.isInteger(toolDelta?.index) ? Number(toolDelta.index) : toolCalls.size
          const current = toolCalls.get(index) ?? { arguments: '' }
          if (typeof toolDelta?.id === 'string' && toolDelta.id.length > 0) current.id = toolDelta.id
          if (typeof toolDelta?.type === 'string' && toolDelta.type.length > 0) current.type = toolDelta.type
          const fn = toolDelta?.function
          if (fn && typeof fn === 'object') {
            if (typeof fn.name === 'string' && fn.name.length > 0) current.name = fn.name
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) current.arguments += fn.arguments
          }
          toolCalls.set(index, current)

          const event = {
            kind: 'tool_call_delta' as const,
            toolCallIndex: index,
            ...(current.name ? { toolName: current.name } : {}),
            ...(typeof fn?.arguments === 'string' && fn.arguments.length > 0
              ? { argumentsDelta: safeProviderStreamText(fn.arguments, STREAM_DELTA_LIMIT) }
              : {}),
            ...(current.arguments.length > 0
              ? { argumentsPreview: safeProviderStreamText(current.arguments, STREAM_PREVIEW_LIMIT) }
              : {}),
          }
          await input.onStreamEvent?.(event)
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
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

    await input.onStreamEvent?.({
      kind: 'stream_completed',
      contentLength: content.length,
      toolCallCount: toolCalls.size,
    })

    const toolSteps = plannerStepsFromToolCalls(normalizeStreamingToolCalls(toolCalls))
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

    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.settings.openaiCompatibleApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.settings.openaiCompatibleModel,
          messages: [
            { role: 'system', content: input.systemPrompt ?? plannerSystemPrompt() },
            { role: 'user', content: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}` },
          ],
          tools: input.tools,
          tool_choice: input.toolChoice ?? 'auto',
          temperature: 0,
          max_tokens: input.maxTokens ?? 1600,
          stream: input.stream ?? true,
        }),
      }
      if (input.abortSignal) init.signal = input.abortSignal
      const response = await fetch(`${input.settings.openaiCompatibleBaseUrl.replace(/\/$/, '')}/chat/completions`, init)

      if (!response.ok) {
        const providerMessage = await response.text().catch(() => '')
        return {
          source: SOURCE,
          steps: [],
          error: {
            kind: 'provider_http_error',
            statusCode: response.status,
            message: safeProviderErrorMessage(providerMessage || response.statusText),
          },
        }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.toLowerCase().includes('text/event-stream')) return this.planFromStream(response, input)
      return jsonPlanResult(await response.json())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        source: SOURCE,
        steps: [],
        error: {
          kind: 'provider_network_error',
          message: safeProviderErrorMessage(message),
        },
      }
    }
  }
}
