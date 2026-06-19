import {
  evaluateToolLoopGuardrails as evaluateAgenticToolLoopGuardrails,
  type ToolLoopActionLike,
  type ToolLoopGuardrailInput as AgenticToolLoopGuardrailInput,
} from '@agentic-os/core'
import type { AgentToolLoopGuardrailFinding } from '@xox/contracts'
import type { Row } from '../../db/schema.js'
import type { AgentToolObservation } from '../tool-observation-continuation.js'

export type ToolLoopGuardrailInput = {
  iteration: number
  priorObservations: AgentToolObservation[]
  newObservations: AgentToolObservation[]
  planRows: Row<'agent_plan_steps'>[]
  actionRows: Row<'agent_action_requests'>[]
  hasFinalAssistantCandidate?: boolean
}

function actionRowForCore(row: Row<'agent_action_requests'>): ToolLoopActionLike {
  return {
    id: row.id,
    kind: row.kind,
  }
}

export function evaluateToolLoopGuardrails(input: ToolLoopGuardrailInput): AgentToolLoopGuardrailFinding[] {
  const coreInput: AgenticToolLoopGuardrailInput = {
    iteration: input.iteration,
    priorObservations: input.priorObservations,
    newObservations: input.newObservations,
    planRows: input.planRows,
    actionRows: input.actionRows.map(actionRowForCore),
    ...(input.hasFinalAssistantCandidate !== undefined
      ? { hasFinalAssistantCandidate: input.hasFinalAssistantCandidate }
      : {}),
  }

  return evaluateAgenticToolLoopGuardrails(coreInput) as AgentToolLoopGuardrailFinding[]
}
