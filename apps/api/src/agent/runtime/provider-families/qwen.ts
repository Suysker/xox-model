import type { ProviderRuntimeCapability, ProviderThinkingProfile } from '../provider-capability.js'
import { baseReplayPolicy } from '../provider-capability.js'

const ENABLE_THINKING_KEY = 'enable_thinking'

const qwenThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'high',
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  reasoningOutputMode: 'native',
}

export function createQwenCapability(): ProviderRuntimeCapability {
  return {
    family: 'qwen',
    thinkingProfile: qwenThinkingProfile,
    reasoningDeltaKeys: ['reasoning_content'],
    buildRequestPatch(ctx) {
      return {
        body: {
          [ENABLE_THINKING_KEY]: ctx.thinkingLevel !== 'off',
        },
      }
    },
    buildReplayPolicy() {
      return baseReplayPolicy('qwen', 'openai-compatible')
    },
  }
}
