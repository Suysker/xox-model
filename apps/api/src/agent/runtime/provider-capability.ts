import type { RuntimeChatMessage } from './runtime-adapter.js'
import type { ProviderModelProfile } from '@agentic-os/runtime-openai-compatible'

// Inspired by OpenClaw's provider replay/thinking hooks, adapted as a small
// SaaS-safe contract. Provider capabilities translate protocol details only;
// they never choose tools, execute actions, or decide the next run step.

export type ProviderThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type ProviderReasoningOutputMode = 'native' | 'tagged' | 'hidden'

export type ProviderRuntimeFamily =
  | 'openai-compatible'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'anthropic'
  | 'google-gemini'
  | 'zai'
  | 'doubao'
  | 'hybrid-anthropic-openai'
  | 'generic'

export type ProviderThinkingProfile = {
  supported: boolean
  defaultLevel: ProviderThinkingLevel
  levels: ProviderThinkingLevel[]
  reasoningOutputMode: ProviderReasoningOutputMode
}

export type ProviderRequestPatch = {
  body?: Record<string, unknown>
  removeBodyKeys?: string[]
}

export type ProviderReplayPolicy = {
  family: ProviderRuntimeFamily
  mode:
    | 'openai-compatible'
    | 'anthropic-native'
    | 'google-gemini'
    | 'deepseek-openai-compatible-thinking'
    | 'moonshot-thinking'
    | 'hybrid-anthropic-openai'
    | 'generic'
  syntheticToolResultMode: 'faithful' | 'provider-approved' | 'forbidden'
  preservedAssistantMessageKeys: string[]
  assistantMessageBackfill: Array<{ key: string; value: unknown }>
  sanitizeToolCallIds: 'preserve-native' | 'openai-compatible'
  validateReplayTurns: boolean
}

export type ProviderRuntimeCapabilityContext = {
  profile: ProviderModelProfile
  thinkingLevel: ProviderThinkingLevel
}

export type ProviderRuntimeCapability = {
  family: ProviderRuntimeFamily
  thinkingProfile: ProviderThinkingProfile
  reasoningDeltaKeys: string[]
  buildRequestPatch(ctx: ProviderRuntimeCapabilityContext): ProviderRequestPatch
  buildReplayPolicy(ctx: ProviderRuntimeCapabilityContext): ProviderReplayPolicy
  sanitizeReplayMessages?(
    messages: RuntimeChatMessage[],
    ctx: ProviderRuntimeCapabilityContext,
  ): RuntimeChatMessage[]
}

export function normalizeThinkingLevel(
  profile: ProviderThinkingProfile,
  requested?: string | null,
): ProviderThinkingLevel {
  if (requested && profile.levels.includes(requested as ProviderThinkingLevel)) {
    return requested as ProviderThinkingLevel
  }
  return profile.defaultLevel
}

export function replayPolicyPreservedMessageKeys(policy: ProviderReplayPolicy) {
  return policy.preservedAssistantMessageKeys
}

export function baseReplayPolicy(
  family: ProviderRuntimeFamily,
  mode: ProviderReplayPolicy['mode'],
): ProviderReplayPolicy {
  return {
    family,
    mode,
    syntheticToolResultMode: 'faithful',
    preservedAssistantMessageKeys: [],
    assistantMessageBackfill: [],
    sanitizeToolCallIds: 'openai-compatible',
    validateReplayTurns: true,
  }
}

export function noThinkingProfile(): ProviderThinkingProfile {
  return {
    supported: false,
    defaultLevel: 'off',
    levels: ['off'],
    reasoningOutputMode: 'hidden',
  }
}
