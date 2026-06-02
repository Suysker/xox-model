import type { ProviderRuntimeCapability, ProviderThinkingProfile } from '../provider-capability.js'
import { baseReplayPolicy } from '../provider-capability.js'

const geminiThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'medium',
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  reasoningOutputMode: 'tagged',
}

export function createGeminiCapability(): ProviderRuntimeCapability {
  return {
    family: 'google-gemini',
    thinkingProfile: geminiThinkingProfile,
    reasoningDeltaKeys: [],
    buildRequestPatch() {
      return {}
    },
    buildReplayPolicy() {
      return {
        ...baseReplayPolicy('google-gemini', 'google-gemini'),
        syntheticToolResultMode: 'provider-approved',
        sanitizeToolCallIds: 'preserve-native',
      }
    },
  }
}
