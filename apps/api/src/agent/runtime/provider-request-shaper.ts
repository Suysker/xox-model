import { plannerSystemPrompt } from '../prompt-registry.js'
import type { RuntimePlanningInput } from './runtime-adapter.js'
import {
  shapeOpenAICompatibleChatRequest as shapeProviderOpenAICompatibleChatRequest,
  type ProviderModelProfile,
} from '@agentic-os/runtime-openai-compatible'

export type ProviderRequestShape = {
  profile: ProviderModelProfile
  body: Record<string, unknown>
}

export type ProviderRequestShapeOptions = {
  omitToolChoice?: boolean
  thinkingLevel?: string
}

export function shapeOpenAICompatibleChatRequest(
  input: RuntimePlanningInput,
  options: ProviderRequestShapeOptions = {},
): ProviderRequestShape {
  const requestedThinkingLevel = options.thinkingLevel ?? input.thinkingLevel
  const requestInput = {
    provider: input.settings.openaiCompatibleProvider,
    model: input.settings.openaiCompatibleModel,
    systemPrompt: input.systemPrompt ?? plannerSystemPrompt(),
    userContent: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}`,
    tools: input.tools,
    stream: input.stream ?? true,
  }
  const shaped = shapeProviderOpenAICompatibleChatRequest({
    ...requestInput,
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(requestedThinkingLevel !== undefined ? { thinkingLevel: requestedThinkingLevel } : {}),
    ...(options.omitToolChoice !== undefined ? { omitToolChoice: options.omitToolChoice } : {}),
  })
  return {
    profile: shaped.profile,
    body: shaped.body,
  }
}
