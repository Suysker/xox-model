import { describe, expect, it } from 'vitest'
import {
  CompletionEvaluator,
  createAgentEffectiveEvaluatorSnapshot,
  createAgentEvaluationContract,
  createAgentEvaluatorReviewAdmission,
  InMemoryAgentEvaluatorStore,
  type AgentEvaluatorInput,
  type AgentFinalCandidate,
} from '@agentic-os/core'

describe('Agentic OS ADR0077 downstream evaluator timing', () => {
  it('admits review after a delayed three-turn candidate without consuming review budget early', async () => {
    const candidate = finalCandidate('2026-07-11T00:00:40.000Z')
    const snapshot = evaluatorSnapshot()
    const store = new InMemoryAgentEvaluatorStore()
    const nowMs = Date.parse(candidate.createdAt)
    let provenanceChecks = 0
    const review = await new CompletionEvaluator({
      store,
      now: () => new Date(nowMs).toISOString(),
      clockMs: () => nowMs,
      domainEvaluator: {
        isolation: 'isolated_rpc',
        evaluate: async ({ evaluatorInput, execution }) => {
          provenanceChecks += 1
          expect(evaluatorInput.evidenceKinds).toContain('workspace_data_provenance')
          expect(execution.deadlineAt).toBe('2026-07-11T00:00:45.000Z')
          return { status: 'pass', evidenceRefs: evaluatorInput.evidenceRefs, laneResultRefs: [] }
        },
      },
    }).evaluate({
      candidate,
      snapshot,
      evaluatorInput: evaluatorInput(candidate),
      reviewId: 'candidate_xox:review',
      runDeadlineAt: '2026-07-11T00:02:00.000Z',
    })
    const admission = await store.loadReviewAdmission({ scope: candidate.scope, reviewId: review.reviewId })
    expect(review.decision.status).toBe('pass')
    expect(provenanceChecks).toBe(1)
    expect(admission?.admittedAt).toBe(candidate.createdAt)
    expect(admission?.reviewDeadlineAt).toBe('2026-07-11T00:01:10.000Z')
  })

  it('reuses an expired persisted lane deadline and never reinvokes the downstream evaluator', async () => {
    const candidate = finalCandidate('2026-07-11T00:00:00.000Z')
    const snapshot = evaluatorSnapshot()
    const evaluatorInputValue = evaluatorInput(candidate)
    const reviewId = 'candidate_xox:review'
    const runDeadlineAt = '2026-07-11T00:02:00.000Z'
    const store = new InMemoryAgentEvaluatorStore()
    await store.reserveReview(createAgentEvaluatorReviewAdmission({
      reviewId, candidate, snapshot, inputHash: evaluatorInputValue.inputHash,
      runDeadlineAt, admittedAt: '2026-07-11T00:00:00.000Z',
    }))
    const manifest = snapshot.manifests.find((item) => item.evaluatorId === 'xox.workspace_data_provenance')!
    const invocationId = `${reviewId}:evaluator:${manifest.evaluatorId}`
    const idempotencyKey = `${candidate.candidateId}:${snapshot.snapshotId}:${manifest.evaluatorId}:${evaluatorInputValue.inputHash}`
    await store.reserveLane({
      schemaVersion: 'agentic-os.evaluator_lane_record.v2', invocationId, idempotencyKey,
      reviewAdmissionRef: reviewId, snapshotId: snapshot.snapshotId, candidateId: candidate.candidateId,
      scope: candidate.scope, evaluatorId: manifest.evaluatorId, criticality: manifest.criticality,
      runId: candidate.runId, attemptId: candidate.attemptId, inputHash: evaluatorInputValue.inputHash,
      status: 'reserved',
    })
    await store.startLane({
      scope: candidate.scope, invocationId, startedAt: '2026-07-11T00:00:00.000Z',
      laneDeadlineAt: '2026-07-11T00:00:05.000Z',
    })
    let provenanceChecks = 0
    const nowMs = Date.parse('2026-07-11T00:00:06.000Z')
    const review = await new CompletionEvaluator({
      store, now: () => new Date(nowMs).toISOString(), clockMs: () => nowMs,
      domainEvaluator: {
        isolation: 'isolated_rpc',
        evaluate: async () => {
          provenanceChecks += 1
          return { status: 'pass', evidenceRefs: [], laneResultRefs: [] }
        },
      },
    }).evaluate({ candidate, snapshot, evaluatorInput: evaluatorInputValue, reviewId, runDeadlineAt })
    const lane = await store.loadLaneByIdempotencyKey({ scope: candidate.scope, idempotencyKey })
    expect(review.decision.status).toBe('failed')
    expect(provenanceChecks).toBe(0)
    expect(lane?.laneDeadlineAt).toBe('2026-07-11T00:00:05.000Z')
    expect(lane?.laneResult?.status).toBe('timed_out')
  })
})

function evaluatorSnapshot() {
  const contract = createAgentEvaluationContract({
    contractId: 'contract_xox', scope: scope(), runId: 'run_xox', attemptId: 'attempt_xox',
    objective: 'Read workspace facts, calculate in sandbox, and return a grounded result.',
    criteria: [{
      criterionId: 'workspace_provenance', description: 'Workspace data provenance is present.',
      criticality: 'required', visibility: 'generator_visible', evidenceKinds: ['workspace_data_provenance'],
    }],
    maxCandidateBytes: 10_000, maxEvaluatorInputBytes: 20_000,
    createdAt: '2026-07-11T00:00:00.000Z',
  })
  return createAgentEffectiveEvaluatorSnapshot({
    contract,
    hostManifests: [{
      schemaVersion: 'agentic-os.evaluator_manifest.v1', evaluatorId: 'xox.workspace_data_provenance',
      laneKind: 'domain', criticality: 'required', priority: 100, timeoutMs: 5_000,
      maxInputBytes: 20_000, criterionRefs: ['workspace_provenance'], trustMode: 'isolated_tenant',
      contentHash: 'xox_workspace_data_provenance_v1',
    }],
    maxParallelLanes: 4,
    reviewTimeoutMs: 30_000,
    createdAt: '2026-07-11T00:00:00.000Z',
  })
}

function finalCandidate(createdAt: string): AgentFinalCandidate {
  return {
    schemaVersion: 'agentic-os.final_candidate.v1', candidateId: 'candidate_xox', scope: scope(),
    runId: 'run_xox', attemptId: 'attempt_xox', candidateSequence: 3,
    assistantTextRef: 'assistant_turn_3', contentHash: 'candidate_hash', observationWatermark: 2,
    obligationRevision: 1, evaluationContractRef: 'contract_xox',
    sourceDecisionRef: 'model_turn_3', createdAt,
  }
}

function evaluatorInput(candidate: AgentFinalCandidate): AgentEvaluatorInput {
  return {
    run: {
      runId: candidate.runId, threadId: 'thread_xox', scope: candidate.scope,
      status: 'running', createdAt: '2026-07-11T00:00:00.000Z',
    },
    candidate,
    candidateText: 'Grounded workspace result.',
    inputHash: 'input_xox',
    objective: 'Read workspace facts, calculate in sandbox, and return a grounded result.',
    evidenceRefs: ['workspace_read_1', 'sandbox_result_1'],
    requiredEvidenceKinds: ['workspace_data_provenance'],
    evidenceKinds: ['workspace_data_provenance', 'sandbox_execution'],
    evidenceWatermark: 2,
    pendingActionRefs: [], activeObligationRefs: [], danglingToolCallRefs: [],
    invalidEvidenceRefs: [], staleEvidenceRefs: [], progressTerminal: true,
    finalizationBudgetAvailable: true,
  }
}

function scope() {
  return { tenantId: 'tenant_xox', workspaceId: 'workspace_xox', userId: 'user_xox' }
}
