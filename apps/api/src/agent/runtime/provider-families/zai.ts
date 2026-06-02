import type { ProviderRuntimeCapability, ProviderThinkingProfile } from '../provider-capability.js'
import { baseReplayPolicy } from '../provider-capability.js'

const THINKING_KEY = 'thinking'
const REASONING_CONTENT_KEY = 'reasoning_content'

const zaiThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'medium',
  levels: ['off', 'low', 'medium', 'high'],
  reasoningOutputMode: 'native',
}

export function createZaiCapability(): ProviderRuntimeCapability {
  return {
    family: 'zai',
    thinkingProfile: zaiThinkingProfile,
    reasoningDeltaKeys: [REASONING_CONTENT_KEY],
    buildRequestPatch(ctx) {
      if (ctx.thinkingLevel === 'off') return { body: { [THINKING_KEY]: { type: 'disabled' } } }
      return { body: { [THINKING_KEY]: { type: 'enabled' } } }
    },
    buildReplayPolicy() {
      return {
        ...baseReplayPolicy('zai', 'openai-compatible'),
        preservedAssistantMessageKeys: [REASONING_CONTENT_KEY],
      }
    },
  }
}
