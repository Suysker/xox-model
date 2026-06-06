import type { ProviderToolCall } from './tool-call-repair.js'
import type { ToolCallBoundaryViolationCode } from './runtime-adapter.js'
import { extractBalancedJson } from './balanced-json.js'

export type StreamingToolCall = {
  id?: string
  type?: string
  name?: string
  arguments: string
}

export type ToolCallDeltaInput = {
  index?: unknown
  id?: unknown
  type?: unknown
  function?: {
    name?: unknown
    arguments?: unknown
  }
}

export type ToolCallFrameStatus = 'complete' | 'truncated' | 'malformed' | 'aborted'

export type ToolCallFrameDamage = {
  kind: ToolCallBoundaryViolationCode
  message: string
  retryable: boolean
}

export type ToolCallFrame = {
  id: string
  providerCallId?: string
  index: number
  name: string | null
  argumentText: string
  status: ToolCallFrameStatus
  damage?: ToolCallFrameDamage
  providerMeta: {
    provider: string
    model: string
    finishReason?: string
  }
}

export type ToolCallFrameOptions = {
  provider: string
  model: string
  finishReason?: string
  streamInterrupted?: boolean
}

function hasCompleteArgumentJson(argumentText: string) {
  if (!argumentText.trim()) return true
  const extracted = extractBalancedJson(argumentText)
  return extracted?.complete === true
}

function frameDamage(input: {
  toolCall: StreamingToolCall
  finishReason?: string
  streamInterrupted?: boolean
}): ToolCallFrameDamage | undefined {
  if (input.streamInterrupted) {
    return {
      kind: 'tool_call_stream_interrupted',
      message: 'Provider stream ended before the tool-call frame reached a terminal state.',
      retryable: true,
    }
  }
  if (!hasCompleteArgumentJson(input.toolCall.arguments)) {
    return {
      kind: 'tool_call_arguments_truncated',
      message: input.finishReason === 'length'
        ? 'Provider stopped by length limit before tool arguments formed complete JSON.'
        : 'Provider stream ended before tool arguments formed complete JSON.',
      retryable: true,
    }
  }
  return undefined
}

export class ToolCallStreamAssembler {
  private readonly toolCalls = new Map<number, StreamingToolCall>()

  append(delta: ToolCallDeltaInput) {
    const index = Number.isInteger(delta.index) ? Number(delta.index) : this.toolCalls.size
    const current = this.toolCalls.get(index) ?? { arguments: '' }
    if (typeof delta.id === 'string' && delta.id.length > 0) current.id = delta.id
    if (typeof delta.type === 'string' && delta.type.length > 0) current.type = delta.type
    const fn = delta.function
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string' && fn.name.length > 0) current.name = fn.name
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) current.arguments += fn.arguments
    }
    this.toolCalls.set(index, current)
    return { index, toolCall: current }
  }

  entries() {
    return [...this.toolCalls.entries()]
  }

  toolNames() {
    return [...new Set(
      [...this.toolCalls.values()]
        .map((toolCall) => toolCall.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    )]
  }

  count() {
    return this.toolCalls.size
  }

  toFrames(options: ToolCallFrameOptions): ToolCallFrame[] {
    return this.entries()
      .sort(([left], [right]) => left - right)
      .map(([index, toolCall]) => {
        const damage = frameDamage({
          toolCall,
          ...(options.finishReason ? { finishReason: options.finishReason } : {}),
          ...(options.streamInterrupted ? { streamInterrupted: true } : {}),
        })
        const status: ToolCallFrameStatus = damage?.kind === 'tool_call_stream_interrupted'
          ? 'aborted'
          : damage?.kind === 'tool_call_arguments_truncated'
            ? 'truncated'
            : damage
              ? 'malformed'
              : 'complete'
        return {
          id: toolCall.id ?? `call_${index}${toolCall.name ? `_${toolCall.name}` : ''}`,
          ...(toolCall.id ? { providerCallId: toolCall.id } : {}),
          index,
          name: toolCall.name ?? null,
          argumentText: toolCall.arguments,
          status,
          ...(damage ? { damage } : {}),
          providerMeta: {
            provider: options.provider,
            model: options.model,
            ...(options.finishReason ? { finishReason: options.finishReason } : {}),
          },
        }
      })
  }

  toProviderToolCalls(): ProviderToolCall[] {
    return this.entries()
      .sort(([left], [right]) => left - right)
      .map(([index, toolCall]) => ({
        id: toolCall.id ?? `call_${index}${toolCall.name ? `_${toolCall.name}` : ''}`,
        type: toolCall.type ?? 'function',
        function: {
          ...(toolCall.name ? { name: toolCall.name } : {}),
          arguments: toolCall.arguments,
        },
      }))
  }
}
