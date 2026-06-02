import type {
  ProviderRuntimeCapability,
  ProviderRuntimeCapabilityContext,
  ProviderThinkingProfile,
} from '../provider-capability.js'
import { baseReplayPolicy, noThinkingProfile } from '../provider-capability.js'

const genericThinkingProfile: ProviderThinkingProfile = noThinkingProfile()

export function createOpenAICompatibleCapability(): ProviderRuntimeCapability {
  return {
    family: 'openai-compatible',
    thinkingProfile: genericThinkingProfile,
    reasoningDeltaKeys: [],
    buildRequestPatch() {
      return {}
    },
    buildReplayPolicy() {
      return baseReplayPolicy('openai-compatible', 'openai-compatible')
    },
  }
}

export function createDoubaoCapability(): ProviderRuntimeCapability {
  return {
    ...createOpenAICompatibleCapability(),
    family: 'doubao',
    buildReplayPolicy() {
      return baseReplayPolicy('doubao', 'openai-compatible')
    },
  }
}

export function createGenericCapability(): ProviderRuntimeCapability {
  return {
    ...createOpenAICompatibleCapability(),
    family: 'generic',
    buildReplayPolicy() {
      return baseReplayPolicy('generic', 'generic')
    },
  }
}

export function requestPatchFromBinaryThinking(
  ctx: ProviderRuntimeCapabilityContext,
  enabledPatch: Record<string, unknown>,
  disabledPatch: Record<string, unknown>,
) {
  return {
    body: ctx.thinkingLevel === 'off' ? disabledPatch : enabledPatch,
  }
}
