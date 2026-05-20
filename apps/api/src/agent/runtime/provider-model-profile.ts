import { resolveProviderModelRef, type ProviderModelRef } from './provider-model-ref.js'

export type ProviderApiFamily = 'openai-compatible-chat' | 'openai-responses' | 'openai-agents-sdk'

export type ProviderToolChoicePolicy = 'omit' | 'auto' | 'required-allowed' | 'never'

export type ProviderModelProfile = ProviderModelRef & {
  apiFamily: ProviderApiFamily
  supportsTools: boolean
  supportsStreaming: boolean
  supportsParallelToolCalls: boolean
  toolChoicePolicy: ProviderToolChoicePolicy
  streamArgumentRepair: 'off' | 'bounded-balanced-json'
  thinking?: {
    mode: 'none' | 'binary' | 'reasoning-effort' | 'provider-extra-body'
    disabledPayload?: Record<string, unknown>
  }
  schemaProfile?: 'openai-strict' | 'gemini' | 'deepseek' | 'generic-json-schema'
  replayPolicy?: 'openai-compatible' | 'deepseek-v4-thinking' | 'moonshot-thinking' | 'generic'
  contextWindow?: number
  maxOutputTokens?: number
}

function modelIncludes(profile: ProviderModelRef, value: string) {
  return profile.model.toLowerCase().includes(value) || profile.requestModel.toLowerCase().includes(value)
}

function genericProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...ref,
    apiFamily: 'openai-compatible-chat',
    supportsTools: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    toolChoicePolicy: 'auto',
    streamArgumentRepair: 'bounded-balanced-json',
    schemaProfile: 'generic-json-schema',
    replayPolicy: 'generic',
  }
}

function deepSeekProfile(ref: ProviderModelRef): ProviderModelProfile {
  const isV4 = modelIncludes(ref, 'v4')
  const isReasoner = modelIncludes(ref, 'reasoner')
  return {
    ...genericProfile(ref),
    schemaProfile: 'deepseek',
    replayPolicy: isV4 ? 'deepseek-v4-thinking' : 'openai-compatible',
    toolChoicePolicy: isReasoner ? 'omit' : 'auto',
    contextWindow: isV4 ? 1_000_000 : 131_072,
    maxOutputTokens: isV4 ? 384_000 : isReasoner ? 65_536 : 8_192,
    ...(isV4
      ? {
          thinking: {
            mode: 'provider-extra-body' as const,
            disabledPayload: { thinking: { type: 'disabled' } },
          },
        }
      : {}),
  }
}

function qwenProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...genericProfile(ref),
    schemaProfile: 'generic-json-schema',
    contextWindow: modelIncludes(ref, 'coder') ? 262_144 : 1_000_000,
    thinking: {
      mode: 'provider-extra-body',
      disabledPayload: { enable_thinking: false },
    },
  }
}

function moonshotProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...genericProfile(ref),
    replayPolicy: 'moonshot-thinking',
    contextWindow: 262_144,
    thinking: {
      mode: 'binary',
      disabledPayload: { thinking: { type: 'disabled' } },
    },
  }
}

function doubaoProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...genericProfile(ref),
    contextWindow: 256_000,
  }
}

function glmProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...genericProfile(ref),
    contextWindow: 128_000,
  }
}

function geminiProfile(ref: ProviderModelRef): ProviderModelProfile {
  return {
    ...genericProfile(ref),
    schemaProfile: 'gemini',
    contextWindow: 1_000_000,
  }
}

function vllmProfile(ref: ProviderModelRef): ProviderModelProfile {
  const requiredToolChoice = /(?:^|[-_:])tool(?:[-_])?required(?:$|[-_:])/i.test(ref.requestModel)
  return {
    ...genericProfile(ref),
    toolChoicePolicy: requiredToolChoice ? 'required-allowed' : 'auto',
    schemaProfile: 'generic-json-schema',
  }
}

export function resolveProviderModelProfile(input: {
  provider: string
  model: string
}): ProviderModelProfile {
  const ref = resolveProviderModelRef(input)
  switch (ref.provider) {
    case 'deepseek':
      return deepSeekProfile(ref)
    case 'qwen':
    case 'modelstudio':
    case 'dashscope':
      return qwenProfile(ref)
    case 'moonshot':
    case 'kimi':
      return moonshotProfile(ref)
    case 'doubao':
    case 'volcengine':
      return doubaoProfile(ref)
    case 'glm':
    case 'zai':
    case 'zhipu':
      return glmProfile(ref)
    case 'gemini':
    case 'google':
      return geminiProfile(ref)
    case 'vllm':
      return vllmProfile(ref)
    case 'openrouter':
      return {
        ...genericProfile(ref),
        supportsParallelToolCalls: true,
      }
    case 'openai':
      return {
        ...genericProfile(ref),
        apiFamily: 'openai-responses',
        supportsParallelToolCalls: true,
        schemaProfile: 'openai-strict',
      }
    default:
      return genericProfile(ref)
  }
}
