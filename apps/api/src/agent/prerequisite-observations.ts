import type { AgentGoalFacts, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { storePlannedActionGraph, type StoredActionGraph } from './action-graph-store.js'
import { answerWorkspaceDataQuestion } from './data-agent.js'
import type { AgentLoopObligationPlan } from './loop-obligations.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'

type PrerequisiteContext = PlannerContext & {
  thread: Row<'agent_threads'>
}

const ENTITY_SUMMARY_TOOL_ARGUMENTS = {
  question: '当前工作区有序成员、股东、员工和成本对象列表',
  scope: 'entity_summary',
  metrics: ['shareholderNames', 'shareholderInvestments'],
}

function parseObservationModelContent(observation: AgentToolObservation) {
  try {
    const parsed = JSON.parse(observation.modelContent)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function hasEntitySummaryObservation(observations: AgentToolObservation[]) {
  return observations.some((observation) => {
    if (observation.toolName !== 'data_query_workspace' || observation.status !== 'completed') return false
    const facts = parseObservationModelContent(observation)
    return facts?.scope === 'entity_summary' && Array.isArray(facts.shareholders)
  })
}

function obligationRequiresEntitySummary(plan?: AgentLoopObligationPlan | null) {
  return Boolean(plan?.obligations.some((obligation) =>
    obligation.requiredDataScopes?.includes('entity_summary')))
}

function shouldRunEntitySummaryPrerequisite(input: {
  goalFacts?: AgentGoalFacts | null
  obligationPlan?: AgentLoopObligationPlan | null
  observations: AgentToolObservation[]
}) {
  if (hasEntitySummaryObservation(input.observations)) return false
  return Boolean(input.goalFacts?.requiresOrderedEntityFacts) ||
    obligationRequiresEntitySummary(input.obligationPlan)
}

export async function runPrerequisiteObservations(
  ctx: PrerequisiteContext,
  input: {
    goalFacts?: AgentGoalFacts | null
    obligationPlan?: AgentLoopObligationPlan | null
    observations: AgentToolObservation[]
    plannerSource: AgentPlannerSource
  },
): Promise<StoredActionGraph | null> {
  if (!shouldRunEntitySummaryPrerequisite(input)) return null

  const read = await answerWorkspaceDataQuestion(ctx, ENTITY_SUMMARY_TOOL_ARGUMENTS)
  if (!read) return null

  return storePlannedActionGraph(ctx, {
    plannerSource: input.plannerSource,
    items: [{
      ...read,
      toolName: 'data_query_workspace',
      toolCallId: `runner_evidence_${ctx.runId}_entity_summary`,
      toolArguments: ENTITY_SUMMARY_TOOL_ARGUMENTS,
      observationLane: 'runner_evidence',
      syntheticObservation: true,
    }],
    emitPlanReady: false,
  })
}
