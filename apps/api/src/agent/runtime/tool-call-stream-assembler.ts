import type { ProviderToolCall } from './tool-call-repair.js'

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
