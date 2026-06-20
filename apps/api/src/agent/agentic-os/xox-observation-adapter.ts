import type {
  AgentObservation as OsObservation,
  AgentToolObservationOutcome as OsToolObservationOutcome,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import {
  createHostObservationBridge,
  type HostObservationBridge,
} from '@agentic-os/core'
import type { AgentToolObservation } from '../tool-observation-continuation.js'
import { classifyToolObservation } from '../tool-observation-outcome.js'

export type XoxObservationBridge = HostObservationBridge<AgentToolObservation>

function compactJsonObject(value: unknown): OsJsonObject {
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

export function xoxObservationContent(observation: AgentToolObservation): OsJsonObject {
  return {
    xoxObservation: compactJsonObject(observation),
    displayPreview: observation.displayPreview,
    modelContent: observation.modelContent,
    status: observation.status,
    outcome: observation.outcome ?? null,
  }
}

export function xoxObservationOutcome(observation: AgentToolObservation): OsToolObservationOutcome {
  return classifyToolObservation(observation) as OsToolObservationOutcome
}

export function agenticOsObservationFromXox(
  observation: AgentToolObservation,
  index = 0,
): OsObservation {
  return {
    observationId: observation.toolCallId || `xox_observation_${index + 1}`,
    toolCallId: observation.toolCallId || `xox_tool_call_${index + 1}`,
    toolName: observation.toolName,
    status: observation.status === 'completed' ? 'ok' : 'error',
    outcome: xoxObservationOutcome(observation),
    content: xoxObservationContent(observation),
  }
}

export function xoxObservationFromAgenticOs(observation: OsObservation): AgentToolObservation {
  const content = observation.content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const maybeXox = (content as Record<string, unknown>).xoxObservation
    if (maybeXox && typeof maybeXox === 'object' && !Array.isArray(maybeXox)) {
      return maybeXox as AgentToolObservation
    }
  }

  const preview = typeof content === 'string'
    ? content
    : JSON.stringify(content ?? null)
  const fallback: AgentToolObservation = {
    title: observation.toolName,
    toolName: observation.toolName,
    toolCallId: observation.toolCallId,
    toolArguments: {},
    displayPreview: preview,
    modelContent: preview,
    status: observation.status === 'ok' ? 'completed' : 'failed',
    synthetic: true,
  }
  if (observation.outcome !== undefined) fallback.outcome = observation.outcome
  return fallback
}

export function xoxObservationKey(observation: AgentToolObservation): string {
  return [
    observation.toolCallId || observation.toolName,
    observation.status,
    observation.outcome ?? '',
    observation.modelContent,
  ].join(':')
}

export function createXoxObservationBridge(): XoxObservationBridge {
  return createHostObservationBridge<AgentToolObservation>({
    toCanonical: ({ hostObservation, index }) => agenticOsObservationFromXox(hostObservation, index),
    fromCanonical: ({ observation }) => xoxObservationFromAgenticOs(observation),
    hostKey: ({ hostObservation }) => xoxObservationKey(hostObservation),
  })
}
