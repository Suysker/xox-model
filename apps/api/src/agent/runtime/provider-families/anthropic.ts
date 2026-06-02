import type { ProviderRuntimeCapability, ProviderThinkingProfile } from '../provider-capability.js'
import { baseReplayPolicy } from '../provider-capability.js'

const anthropicThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'medium',
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  reasoningOutputMode: 'native',
}

export function createAnthropicCapability(): ProviderRuntimeCapability {
  return {
    family: 'anthropic',
    thinkingProfile: anthropicThinkingProfile,
    reasoningDeltaKeys: [],
    buildRequestPatch() {
      return {}
    },
    buildReplayPolicy() {
      return {
        ...baseReplayPolicy('anthropic', 'anthropic-native'),
        syntheticToolResultMode: 'provider-approved',
        sanitizeToolCallIds: 'preserve-native',
      }
    },
  }
}
