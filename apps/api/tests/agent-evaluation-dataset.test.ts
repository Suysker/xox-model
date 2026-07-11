import { describe, expect, it } from 'vitest'
import {
  createDownstreamHarnessEvaluationScenario,
  runAgentOfflineEvaluation,
} from '@agentic-os/testing'
import type { AgentObservation, AgentScope } from '@agentic-os/contracts'

describe('xox Agentic OS evaluation dataset', () => {
  it('evaluates product quality with a downstream rubric and no host-owned harness loop', async () => {
    const scope: AgentScope = {
      tenantId: 'tenant_eval', workspaceId: 'workspace_eval', userId: 'user_eval',
    }
    const scenario = createDownstreamHarnessEvaluationScenario({
      scope,
      scenarioId: 'xox_workspace_forecast_grounding',
      version: '1',
      source: 'historical_failure',
      evaluationDefinitionRef: 'xox.financial_workspace_grounding.v1',
      runInput: {
        threadId: 'thread_eval', scope,
        userMessage: 'Summarize the approved workspace forecast and cite the current source facts.',
        maxIterations: 8,
      },
      expected: {
        allowedStatuses: ['completed'],
        requiredTextIncludes: ['approved forecast', 'workspace source'],
        requiredObservationToolNames: ['workspace_facts'],
        forbiddenObservationOutcomes: ['failed_terminal'],
        requireUniqueToolCallObservations: true,
      },
      rubricRefs: ['xox.financial_workspace_grounding.v1'],
      environmentFixtureRefs: ['xox.fixture.approved_forecast.v1'],
      tags: ['xox-model', 'financial-workspace', 'grounding'],
    })
    const report = await runAgentOfflineEvaluation({
      scope, datasetId: 'xox.financial_workspace', datasetVersion: '1',
      harnessRevision: 'agentic-os-adr0070-0073', scenarios: [scenario],
      trialsPerScenario: 2, maxParallelTrials: 1,
      runTrial: async ({ trialId }) => ({
        result: {
          status: 'completed', runId: trialId, threadId: scenario.input.threadId,
          assistantText: 'The approved forecast is grounded in the current workspace source.',
          observations: [workspaceFactsObservation(trialId)], evidence: [],
        },
        trajectoryRef: `${trialId}:trajectory`,
      }),
    })
    expect(report.aggregate.trialCount).toBe(2)
    expect(report.aggregate.deterministicPassRate).toBe(1)
    expect(report.evaluationContractVersions).toEqual(['xox.financial_workspace_grounding.v1'])
  })
})

function workspaceFactsObservation(trialId: string): AgentObservation {
  return {
    observationId: `${trialId}:workspace-facts`,
    toolCallId: `${trialId}:call:workspace-facts`,
    toolName: 'workspace_facts',
    status: 'ok',
    outcome: 'completed_valid',
    content: { sourceRef: 'workspace-source-ref', forecastStatus: 'approved' },
  }
}
