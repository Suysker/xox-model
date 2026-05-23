import { plannerSystemPrompt } from '../prompt-registry.js'
import type { ChatTool } from '../tool-catalog.js'
import type { RuntimePlanningInput } from './runtime-adapter.js'
import { resolveProviderModelProfile, type ProviderModelProfile } from './provider-model-profile.js'
import { normalizeProviderToolSchemas } from './provider-tool-schema.js'

export type ProviderRequestShape = {
  profile: ProviderModelProfile
  body: Record<string, unknown>
}

export type ProviderRequestShapeOptions = {
  omitToolChoice?: boolean
  disableThinking?: boolean
}

function shouldSendToolChoice(profile: ProviderModelProfile, toolCount: number, omitToolChoice?: boolean) {
  if (omitToolChoice || toolCount <= 0 || !profile.supportsTools) return false
  return profile.toolChoicePolicy === 'auto' || profile.toolChoicePolicy === 'required-allowed'
}

function toolChoiceForProfile(profile: ProviderModelProfile) {
  if (profile.toolChoicePolicy === 'required-allowed') return 'required'
  return 'auto'
}

function profileFromInput(input: RuntimePlanningInput) {
  return resolveProviderModelProfile({
    provider: input.settings.openaiCompatibleProvider,
    model: input.settings.openaiCompatibleModel,
  })
}

function normalizedTools(input: RuntimePlanningInput, profile: ProviderModelProfile): ChatTool[] {
  if (!profile.supportsTools) return []
  return normalizeProviderToolSchemas(input.tools, profile)
}

function providerExtraParams(profile: ProviderModelProfile, options: ProviderRequestShapeOptions) {
  if (options.disableThinking && profile.thinking?.disabledPayload) return profile.thinking.disabledPayload
  return {}
}

function requestMaxTokens(input: RuntimePlanningInput, profile: ProviderModelProfile) {
  const requested = input.maxTokens ?? 1600
  return profile.maxOutputTokens ? Math.min(requested, profile.maxOutputTokens) : requested
}

export function shapeOpenAICompatibleChatRequest(
  input: RuntimePlanningInput,
  options: ProviderRequestShapeOptions = {},
): ProviderRequestShape {
  const profile = profileFromInput(input)
  const tools = normalizedTools(input, profile)
  const body: Record<string, unknown> = {
    model: profile.requestModel,
    messages: input.messages ?? [
      { role: 'system', content: input.systemPrompt ?? plannerSystemPrompt() },
      { role: 'user', content: `上下文：${JSON.stringify(input.context)}\n用户指令：${input.message}` },
    ],
    temperature: 0,
    max_tokens: requestMaxTokens(input, profile),
    stream: input.stream ?? true,
    ...providerExtraParams(profile, options),
  }
  if (tools.length > 0) body.tools = tools
  if (shouldSendToolChoice(profile, tools.length, options.omitToolChoice)) {
    body.tool_choice = toolChoiceForProfile(profile)
  }
  if (profile.supportsParallelToolCalls) body.parallel_tool_calls = true
  return { profile, body }
}
