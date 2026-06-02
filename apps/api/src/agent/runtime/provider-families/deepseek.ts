import type { ProviderModelProfile } from '../provider-model-profile.js'
import type {
  ProviderRuntimeCapability,
  ProviderRuntimeCapabilityContext,
  ProviderThinkingProfile,
} from '../provider-capability.js'
import { baseReplayPolicy, noThinkingProfile } from '../provider-capability.js'

const REASONING_CONTENT_KEY = 'reasoning_content'

const v4ThinkingProfile: ProviderThinkingProfile = {
  supported: true,
  defaultLevel: 'high',
  levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  reasoningOutputMode: 'native',
}

function isDeepSeekV4(profile: ProviderModelProfile) {
  return profile.replayPolicy === 'deepseek-v4-thinking'
}

function reasoningEffort(level: ProviderRuntimeCapabilityContext['thinkingLevel']) {
  if (level === 'minimal' || level === 'low') return 'low'
  if (level === 'medium') return 'medium'
  if (level === 'xhigh' || level === 'max') return 'max'
  return 'high'
}

export function createDeepSeekCapability(profile: ProviderModelProfile): ProviderRuntimeCapability {
  const thinkingProfile = isDeepSeekV4(profile) ? v4ThinkingProfile : noThinkingProfile()
  return {
    family: 'deepseek',
    thinkingProfile,
    reasoningDeltaKeys: isDeepSeekV4(profile) ? [REASONING_CONTENT_KEY] : [],
    buildRequestPatch(ctx) {
      if (!isDeepSeekV4(ctx.profile)) return {}
      if (ctx.thinkingLevel === 'off') {
        return {
          body: { thinking: { type: 'disabled' } },
          removeBodyKeys: ['reasoning_effort'],
        }
      }
      return {
        body: {
          thinking: { type: 'enabled' },
          reasoning_effort: reasoningEffort(ctx.thinkingLevel),
        },
      }
    },
    buildReplayPolicy(ctx) {
      if (!isDeepSeekV4(ctx.profile)) {
        return baseReplayPolicy('deepseek', 'openai-compatible')
      }
      return {
        ...baseReplayPolicy('deepseek', 'deepseek-openai-compatible-thinking'),
        preservedAssistantMessageKeys: [REASONING_CONTENT_KEY],
        assistantMessageBackfill: ctx.thinkingLevel === 'off'
          ? []
          : [{ key: REASONING_CONTENT_KEY, value: '' }],
      }
    },
  }
}
