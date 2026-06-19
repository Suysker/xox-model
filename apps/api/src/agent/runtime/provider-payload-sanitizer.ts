import type { ProviderModelProfile } from '@agentic-os/runtime-openai-compatible'

// Inspired by Hermes Agent's provider payload sanitation layer, adapted to keep
// OpenAI-compatible vendor quirks outside xox business tools.

export type ProviderPayloadSanitizerOptions = {
  omitToolChoice?: boolean
  preservedMessageKeys?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sanitizeMessage(message: unknown, options: ProviderPayloadSanitizerOptions) {
  if (!isRecord(message)) return message
  const role = message.role
  const sanitized: Record<string, unknown> = {}
  if (typeof role === 'string') sanitized.role = role
  if ('content' in message) sanitized.content = message.content
  if (role === 'assistant') {
    for (const key of options.preservedMessageKeys ?? []) {
      if (message[key] !== undefined) sanitized[key] = message[key]
    }
  }
  if (Array.isArray(message.tool_calls)) {
    sanitized.tool_calls = message.tool_calls.map((toolCall) => {
      if (!isRecord(toolCall)) return toolCall
      return {
        ...(typeof toolCall.id === 'string' ? { id: toolCall.id } : {}),
        type: 'function',
        ...(isRecord(toolCall.function)
          ? {
              function: {
                ...(typeof toolCall.function.name === 'string' ? { name: toolCall.function.name } : {}),
                ...(typeof toolCall.function.arguments === 'string' ? { arguments: toolCall.function.arguments } : {}),
              },
            }
          : {}),
      }
    })
  }
  if (typeof message.tool_call_id === 'string') sanitized.tool_call_id = message.tool_call_id
  if (typeof message.name === 'string') sanitized.name = message.name
  return sanitized
}

function shouldKeepToolChoice(profile: ProviderModelProfile, body: Record<string, unknown>, options: ProviderPayloadSanitizerOptions) {
  if (options.omitToolChoice) return false
  if (!profile.supportsTools) return false
  if (profile.toolChoicePolicy === 'omit' || profile.toolChoicePolicy === 'never') return false
  return body.tool_choice !== undefined
}

export function sanitizeOpenAICompatibleRequestBody(
  body: Record<string, unknown>,
  profile: ProviderModelProfile,
  options: ProviderPayloadSanitizerOptions = {},
) {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    if (key.startsWith('x_') || key.startsWith('_')) continue
    sanitized[key] = value
  }

  if (Array.isArray(sanitized.messages)) {
    sanitized.messages = sanitized.messages.map((message) => sanitizeMessage(message, options))
  }

  if (!profile.supportsTools || !Array.isArray(sanitized.tools) || sanitized.tools.length === 0) {
    delete sanitized.tools
  }

  if (!shouldKeepToolChoice(profile, sanitized, options)) {
    delete sanitized.tool_choice
  }

  if (!profile.supportsParallelToolCalls) {
    delete sanitized.parallel_tool_calls
  }

  return sanitized
}
