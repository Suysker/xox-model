import {
  classifyToolObservationOutcome,
  isRepairableProviderBoundaryCode,
  isRepairableToolObservation as osIsRepairableToolObservation,
  isTerminalToolObservation as osIsTerminalToolObservation,
  type ToolObservationLike as AgenticOsToolObservationLike,
  type ToolObservationStatus,
} from '@agentic-os/core'
import type { AgentToolObservationOutcome } from '@xox/contracts'

export type { ToolObservationStatus }

export type ToolObservationLike = Omit<AgenticOsToolObservationLike, 'outcome'> & {
  outcome?: AgentToolObservationOutcome
}

export function classifyToolObservation(input: ToolObservationLike): AgentToolObservationOutcome {
  return classifyToolObservationOutcome(input) as AgentToolObservationOutcome
}

export function isRepairableToolObservation(input: ToolObservationLike) {
  return osIsRepairableToolObservation(input)
}

export function isTerminalToolObservation(input: ToolObservationLike) {
  return osIsTerminalToolObservation(input)
}

export { isRepairableProviderBoundaryCode }
