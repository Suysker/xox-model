import type { Settings } from '../../core/settings.js'
import { redactSecretLikeContent } from '../memory.js'
import type { RuntimeChatMessage } from './runtime-adapter.js'
import {
  providerCapabilityFromSettings,
  resolveRuntimeThinkingLevel,
} from './provider-capability-registry.js'

export type ProviderReplayObservation = {
  toolName: string
  toolCallId: string
  toolArguments: Record<string, unknown>
  modelContent: string
  lane?: 'provider_tool' | 'runner_evidence'
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function observationCallId(observation: ProviderReplayObservation, index: number, suffix: string) {
  const base = observation.toolCallId || `call_observation_${index}_${observation.toolName}`
  return suffix ? `${base}_${suffix}_${index}` : base
}

function runnerEvidenceMessage(observations: ProviderReplayObservation[]): RuntimeChatMessage | null {
  if (observations.length === 0) return null
  const content = [
    'Runner evidence context. These facts were collected by the harness before planning; they are not provider tool calls and must not be described as tools you called.',
    ...observations.map((observation, index) => [
      `Evidence ${index + 1}: ${observation.toolName}`,
      `Arguments: ${safeJson(observation.toolArguments)}`,
      `Content: ${redactSecretLikeContent(observation.modelContent).slice(0, 12000)}`,
    ].join('\n')),
  ].join('\n\n')
  return { role: 'system', content }
}

export function sanitizeProviderReplayMessages(input: {
  settings: Settings
  messages: RuntimeChatMessage[]
  thinkingLevel?: string | undefined
}): RuntimeChatMessage[] {
  const { profile, capability } = providerCapabilityFromSettings(input.settings)
  const thinkingLevel = resolveRuntimeThinkingLevel({
    capability,
    requested: input.thinkingLevel,
  })
  const replayPolicy = capability.buildReplayPolicy({ profile, thinkingLevel })
  const replayMessages = input.messages.map((message) => {
    if (message.role !== 'assistant') return message
    const copy = { ...message } as RuntimeChatMessage & Record<string, unknown>
    for (const item of replayPolicy.assistantMessageBackfill) {
      if (copy[item.key] === undefined) copy[item.key] = item.value
    }
    return copy
  })
  return capability.sanitizeReplayMessages?.(replayMessages, { profile, thinkingLevel }) ?? replayMessages
}

export function providerToolObservationReplayMessages(input: {
  settings: Settings
  observations: ProviderReplayObservation[]
  suffix?: string
  maxObservations?: number
  thinkingLevel?: string | undefined
}): RuntimeChatMessage[] {
  const usable = input.observations.slice(-(input.maxObservations ?? 12))
  if (usable.length === 0) return []
  const suffix = input.suffix ?? ''
  const runnerEvidence = usable.filter((observation) => observation.lane === 'runner_evidence')
  const providerObservations = usable.filter((observation) => observation.lane !== 'runner_evidence')
  const evidenceMessage = runnerEvidenceMessage(runnerEvidence)
  const toolCalls = providerObservations.map((observation, index) => ({
    id: observationCallId(observation, index, suffix),
    type: 'function' as const,
    function: {
      name: observation.toolName,
      arguments: safeJson(observation.toolArguments),
    },
  }))
  const providerMessages: RuntimeChatMessage[] = toolCalls.length > 0
    ? [
        {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        ...providerObservations.map((observation, index) => ({
          role: 'tool' as const,
          tool_call_id: observationCallId(observation, index, suffix),
          name: observation.toolName,
          content: redactSecretLikeContent(observation.modelContent).slice(0, 12000),
        })),
      ]
    : []
  const messages: RuntimeChatMessage[] = [
    ...(evidenceMessage ? [evidenceMessage] : []),
    ...providerMessages,
  ]
  return sanitizeProviderReplayMessages({
    settings: input.settings,
    messages,
    thinkingLevel: input.thinkingLevel,
  })
}
