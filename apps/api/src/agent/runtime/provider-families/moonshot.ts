import type { ProviderRuntimeCapability, ProviderThinkingProfile } from '../provider-capability.js'
import { baseReplayPolicy } from '../provider-capability.js'
import { requestPatchFromBinaryThinking } from './openai-compatible.js'

const THINKING_KEY = 'thinking'
const REASONING_CONTENT_KEY = 'reasoning_content'

const moonshotThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'low',
  levels: ['off', 'low', 'medium', 'high'],
  reasoningOutputMode: 'native',
}

export function createMoonshotCapability(): ProviderRuntimeCapability {
  return {
    family: 'moonshot',
    thinkingProfile: moonshotThinkingProfile,
    reasoningDeltaKeys: [REASONING_CONTENT_KEY],
    buildRequestPatch(ctx) {
      return requestPatchFromBinaryThinking(
        ctx,
        { [THINKING_KEY]: { type: 'enabled' } },
        { [THINKING_KEY]: { type: 'disabled' } },
      )
    },
    buildReplayPolicy() {
      return {
        ...baseReplayPolicy('moonshot', 'moonshot-thinking'),
        preservedAssistantMessageKeys: [REASONING_CONTENT_KEY],
        sanitizeToolCallIds: 'preserve-native',
      }
    },
  }
}
