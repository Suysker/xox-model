import type {
  AgentObservation as OsObservation,
  AgentToolObservationOutcome as OsToolObservationOutcome,
  JsonObject as OsJsonObject,
} from '@agentic-os/contracts'
import type { AgentToolObservation } from '../tool-observation-continuation.js'
import { classifyToolObservation } from '../tool-observation-outcome.js'

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
