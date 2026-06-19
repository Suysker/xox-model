import type { Settings } from '../../core/settings.js'
import {
  resolveProviderModelProfile,
  type ProviderModelProfile,
} from '@agentic-os/runtime-openai-compatible'
import type {
  ProviderRuntimeCapability,
  ProviderThinkingLevel,
} from './provider-capability.js'
import { normalizeThinkingLevel } from './provider-capability.js'
import { createAnthropicCapability } from './provider-families/anthropic.js'
import { createDeepSeekCapability } from './provider-families/deepseek.js'
import { createGeminiCapability } from './provider-families/gemini.js'
import { createMoonshotCapability } from './provider-families/moonshot.js'
import {
  createDoubaoCapability,
  createGenericCapability,
  createOpenAICompatibleCapability,
} from './provider-families/openai-compatible.js'
import { createQwenCapability } from './provider-families/qwen.js'
import { createZaiCapability } from './provider-families/zai.js'

export function runtimeProfileFromSettings(settings: Settings) {
  return resolveProviderModelProfile({
    provider: settings.openaiCompatibleProvider,
    model: settings.openaiCompatibleModel,
  })
}

export function resolveProviderRuntimeCapability(profile: ProviderModelProfile): ProviderRuntimeCapability {
  switch (profile.provider) {
    case 'deepseek':
      return createDeepSeekCapability(profile)
    case 'qwen':
    case 'modelstudio':
    case 'dashscope':
      return createQwenCapability()
    case 'moonshot':
    case 'kimi':
      return createMoonshotCapability()
    case 'anthropic':
    case 'claude':
      return createAnthropicCapability()
    case 'gemini':
    case 'google':
      return createGeminiCapability()
    case 'glm':
    case 'zai':
    case 'zhipu':
      return createZaiCapability()
    case 'doubao':
    case 'volcengine':
      return createDoubaoCapability()
    case 'openai':
    case 'openrouter':
    case 'vllm':
      return createOpenAICompatibleCapability()
    default:
      return createGenericCapability()
  }
}

export function resolveRuntimeThinkingLevel(input: {
  capability: ProviderRuntimeCapability
  requested?: string | null | undefined
}): ProviderThinkingLevel {
  return normalizeThinkingLevel(input.capability.thinkingProfile, input.requested)
}

export function providerCapabilityFromSettings(settings: Settings) {
  const profile = runtimeProfileFromSettings(settings)
  return {
    profile,
    capability: resolveProviderRuntimeCapability(profile),
  }
}
