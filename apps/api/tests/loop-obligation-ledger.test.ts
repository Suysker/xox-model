import { describe, expect, it } from 'vitest'
import { finalResponseGateDecisionObligations } from '@agentic-os/core'
import type { AgentEvidenceRequirementEvaluation } from '@agentic-os/contracts'
import type {
  AgentEvidenceRequirement,
  ResponseEvaluation,
} from '../src/agent/agentic-os/xox-final-review-adapter.js'
import type { AgentToolObservation } from '../src/agent/agentic-os/xox-tool-observation-adapter.js'
import {
  activeLedgerObligations,
  applyObservationToLedger,
  applyResponseEvaluationToLedger,
  canAttemptFinalAnswer,
  initializeObligationLedger,
  ledgerToObligationPlan,
  osEvidenceRequirementFromXoxRequirement,
  runtimeBoundaryMissingObservationRepair,
  serializeObligationLedger,
  serializeObligationLedgerForResponseEvent,
} from '../src/agent/agentic-os/xox-final-review-adapter.js'

function evaluation(overrides: Partial<ResponseEvaluation> = {}): ResponseEvaluation {
  return withGeneratedObligations({
    status: 'needs_calculation',
    confidence: 0.9,
    requiredEvidence: [
      { authority: 'sandbox', subject: 'calculation', reason: '需要可复核计算。' },
      { authority: 'domain_read', subject: 'shareholder', reason: '需要有序股东事实。' },
    ],
    findings: [
      {
        severity: 'fail',
        code: 'response.sandbox_evidence_missing',
        evidenceIds: [],
        message: '缺少沙箱计算。',
      },
    ],
    nextPlannerBrief: '继续取得缺失 evidence。',
    ...overrides,
  })
}

function withGeneratedObligations(evaluation: ResponseEvaluation): ResponseEvaluation {
  if (evaluation.obligations !== undefined || evaluation.status === 'pass') return evaluation
  if (evaluation.status === 'awaiting_confirmation' || evaluation.status === 'awaiting_clarification') {
    return evaluation
  }
  if (evaluation.status === 'needs_final_answer') {
    return {
      ...evaluation,
      obligations: finalResponseGateDecisionObligations({
        decision: {
          kind: 'needs_final_answer',
          finalText: '',
          evidenceIds: evaluation.findings.flatMap((finding) => finding.evidenceIds),
        },
        evidenceRequirements: [],
      }),
    }
  }
  const requirements = evaluation.requiredEvidence.map((requirement): AgentEvidenceRequirement => {
    const mapped: AgentEvidenceRequirement = {
      authority: requirement.authority,
      reason: requirement.reason,
      source: 'goal_facts',
    }
    if (isXoxEvidenceSubject(requirement.subject)) {
      mapped.subject = requirement.subject
    }
    return mapped
  })
  const osRequirements = requirements.map(osEvidenceRequirementFromXoxRequirement)
  return {
    ...evaluation,
    obligations: finalResponseGateDecisionObligations({
      decision: {
        kind: 'needs_evidence',
        finalText: '',
        evidenceIds: evaluation.findings.flatMap((finding) => finding.evidenceIds),
        evidenceRequirementEvaluation: requirementEvaluation(evaluation, osRequirements),
      },
      evidenceRequirements: osRequirements,
    }),
  }
}

function isXoxEvidenceSubject(value: string | undefined): value is NonNullable<AgentEvidenceRequirement['subject']> {
  return value === 'workspace' ||
    value === 'shareholder' ||
    value === 'member' ||
    value === 'ledger_entry' ||
    value === 'forecast' ||
    value === 'calculation' ||
    value === 'action'
}

function requirementEvaluation(
  evaluation: ResponseEvaluation,
  requirements: ReturnType<typeof osEvidenceRequirementFromXoxRequirement>[],
): AgentEvidenceRequirementEvaluation {
  const invalidEvidenceIds = evaluation.findings
    .filter((finding) => finding.code === 'response.sandbox_evidence_invalid')
    .flatMap((finding) => finding.evidenceIds)
  const findings = requirements.map((requirement) => {
    const invalid = requirement.authority === 'sandbox' && invalidEvidenceIds.length > 0
    return {
      requirement,
      status: invalid ? 'invalid' as const : 'missing' as const,
      reason: invalid ? `${requirement.reason} Matching evidence was invalid or insufficient.` : requirement.reason,
      matchedEvidenceIds: invalid ? invalidEvidenceIds : [],
      validEvidenceIds: [],
      invalidEvidenceIds: invalid ? invalidEvidenceIds : [],
    }
  })
  return {
    status: 'needs_evidence',
    findings,
    satisfiedCount: 0,
    missingCount: findings.filter((finding) => finding.status === 'missing').length,
    invalidCount: findings.filter((finding) => finding.status === 'invalid').length,
  }
}

function observation(overrides: Partial<AgentToolObservation> = {}): AgentToolObservation {
  return {
    title: '查询工作区数据',
    toolName: 'data_query_workspace',
    toolCallId: 'call_data',
    toolArguments: {},
    displayPreview: '读取完成',
    modelContent: JSON.stringify({ scope: 'workspace_summary', totalProfit: 100 }),
    status: 'completed',
    ...overrides,
  }
}

function sandboxProof() {
  return {
    executionMode: 'executed',
    status: 'completed',
    exitCode: 0,
    backendId: 'local-script',
    codeHash: 'code_hash',
    outputHash: 'output_hash',
    manifest: {
      manifestId: 'manifest_1',
      bundleId: 'bundle_1',
      contentHash: 'content_hash',
      nonce: 'nonce_1',
      consumed: true,
    },
    sdkCalls: [],
    sourceObservationRefs: ['bundle:bundle_1'],
  }
}

function completedSandbox(): AgentToolObservation {
  return observation({
    title: '受控沙箱执行完成',
    toolName: 'sandbox_run_code',
    toolCallId: 'call_sandbox',
    modelContent: JSON.stringify({
      observationType: 'sandbox_execution',
      status: 'completed',
      executionMode: 'executed',
      exitCode: 0,
      manifestScoped: true,
      evidenceProof: sandboxProof(),
      outputText: 'shareholder roi: 0.12',
      purpose: '计算第二位股东贷款后 ROI',
    }),
  })
}

describe('Agent loop obligation ledger', () => {
  it('keeps evaluator obligations durable until matching observations close them', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })

    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation(),
      iteration: 1,
    })
    expect(activeLedgerObligations(ledger).map((item) => item.kind)).toEqual([
      'sandbox_calculation',
      'domain_fact',
    ])
    expect(canAttemptFinalAnswer(ledger)).toBe(false)

    applyObservationToLedger({
      ledger,
      observation: completedSandbox(),
      iteration: 2,
    })
    expect(serializeObligationLedger(ledger)).toMatchObject({
      openCount: 1,
      satisfiedCount: 1,
      obligations: [
        expect.objectContaining({ kind: 'sandbox_calculation', status: 'satisfied' }),
        expect.objectContaining({ kind: 'domain_fact', status: 'open' }),
      ],
    })
    expect(canAttemptFinalAnswer(ledger)).toBe(false)

    const plan = ledgerToObligationPlan({ ledger, objective: '计算第 2 位股东 ROI' })
    expect(plan).toMatchObject({
      requiredToolNames: ['data_query_workspace'],
      selectedCapabilities: ['data'],
      goalFacts: { requiresOrderedEntityFacts: true },
      modelContext: {
        obligations: [
          expect.objectContaining({
            kind: 'domain_fact',
            requiredDataScopes: ['entity_summary'],
            requiredMetrics: ['shareholderNames', 'shareholderInvestments'],
          }),
        ],
      },
    })
  })

  it('does not close shareholder facts from a workspace summary read', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        status: 'needs_more_evidence',
        requiredEvidence: [
          { authority: 'domain_read', subject: 'shareholder', reason: '需要有序股东事实。' },
        ],
      }),
      iteration: 1,
    })

    applyObservationToLedger({ ledger, observation: observation(), iteration: 2 })

    expect(activeLedgerObligations(ledger)).toEqual([
      expect.objectContaining({
        kind: 'domain_fact',
        status: 'invalid',
        invalidReasons: ['ordered_shareholder_facts_missing'],
      }),
    ])

    applyObservationToLedger({
      ledger,
      observation: observation({
        modelContent: JSON.stringify({
          scope: 'entity_summary',
          firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
          shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
        }),
      }),
      iteration: 3,
    })

    expect(activeLedgerObligations(ledger)).toEqual([])
    expect(canAttemptFinalAnswer(ledger)).toBe(true)
  })

  it('only closes shareholder facts from model-visible runner obligation observations', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        status: 'needs_more_evidence',
        requiredEvidence: [
          { authority: 'domain_read', subject: 'shareholder', reason: '需要有序股东事实。' },
        ],
      }),
      iteration: 1,
    })

    const entitySummary = {
      scope: 'entity_summary',
      firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
      shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
    }

    applyObservationToLedger({
      ledger,
      observation: observation({
        toolCallId: 'runner_evidence_run_1_entity_summary',
        toolArguments: { scope: 'entity_summary' },
        modelContent: JSON.stringify(entitySummary),
        lane: 'runner_evidence',
        synthetic: true,
      }),
      iteration: 2,
    })

    expect(activeLedgerObligations(ledger)).toEqual([
      expect.objectContaining({ kind: 'domain_fact', status: 'open' }),
    ])

    applyObservationToLedger({
      ledger,
      observation: observation({
        toolCallId: 'runner_obligation_run_1_entity_summary',
        toolArguments: { scope: 'entity_summary' },
        modelContent: JSON.stringify(entitySummary),
        lane: 'runner_obligation',
      }),
      iteration: 3,
    })

    expect(activeLedgerObligations(ledger)).toEqual([])
    expect(canAttemptFinalAnswer(ledger)).toBe(true)
  })

  it('keeps invalid sandbox observations active for a repair loop', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        requiredEvidence: [
          { authority: 'sandbox', subject: 'calculation', reason: '需要可复核计算。' },
        ],
      }),
      iteration: 1,
    })

    applyObservationToLedger({
      ledger,
      observation: observation({
        toolName: 'sandbox_run_code',
        toolCallId: 'call_bad_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          status: 'failed',
          executionMode: 'executed',
          exitCode: 1,
          manifestScoped: true,
          outputText: 'Traceback',
        }),
      }),
      iteration: 2,
    })

    expect(activeLedgerObligations(ledger)).toEqual([
      expect.objectContaining({
        kind: 'sandbox_calculation',
        status: 'invalid',
        invalidReasons: ['sandbox_evidence_invalid'],
      }),
    ])
    expect(ledgerToObligationPlan({ ledger, objective: '计算 ROI' })).toMatchObject({
      requiredToolNames: ['sandbox_run_code'],
    })
  })

  it('closes final-answer obligations only after the response evaluator passes', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })

    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        status: 'needs_final_answer',
        requiredEvidence: [],
        findings: [{
          severity: 'fail',
          code: 'response.final_answer_missing',
          evidenceIds: ['run_1:evidence:1'],
          message: '缺少最终回答。',
        }],
      }),
      iteration: 1,
    })

    expect(activeLedgerObligations(ledger)).toEqual([
      expect.objectContaining({ kind: 'assistant_final_answer', status: 'open' }),
    ])
    expect(canAttemptFinalAnswer(ledger)).toBe(true)

    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        status: 'pass',
        requiredEvidence: [],
        findings: [{
          severity: 'info',
          code: 'response.evidence_accepted',
          evidenceIds: ['run_1:evidence:1'],
          message: '通过。',
        }],
      }),
      iteration: 2,
    })

    expect(activeLedgerObligations(ledger)).toEqual([])
    expect(serializeObligationLedger(ledger)).toMatchObject({
      openCount: 0,
      satisfiedCount: 1,
    })
  })

  it('projects response-event obligations through Agentic OS without mutating the ledger', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    const projection = serializeObligationLedgerForResponseEvent({
      ledger,
      evaluation: evaluation({
        requiredEvidence: [
          { authority: 'sandbox', subject: 'calculation', reason: '需要修复沙箱计算。' },
        ],
        findings: [{
          severity: 'fail',
          code: 'response.sandbox_evidence_invalid',
          evidenceIds: ['run_1:evidence:sandbox'],
          message: '沙箱结果无效。',
        }],
      }),
    })

    expect(ledger.obligations).toEqual([])
    expect(projection).toMatchObject({
      openCount: 1,
      invalidCount: 1,
      obligations: [
        expect.objectContaining({
          kind: 'sandbox_calculation',
          status: 'invalid',
          source: 'response_evaluator',
          toolNames: ['sandbox_run_code'],
          invalidReasons: ['response_evaluation_invalid'],
        }),
      ],
    })
  })

  it('does not duplicate response-event obligations that already exist in the ledger', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    const response = evaluation({
      requiredEvidence: [
        { authority: 'domain_read', subject: 'shareholder', reason: '需要有序股东事实。' },
      ],
    })
    applyResponseEvaluationToLedger({
      ledger,
      evaluation: response,
      iteration: 1,
    })

    const projection = serializeObligationLedgerForResponseEvent({
      ledger,
      evaluation: response,
    })

    expect(projection.obligations).toHaveLength(1)
    expect(projection.obligations[0]).toMatchObject({
      kind: 'domain_fact',
      toolNames: ['data_query_workspace'],
      requiredDataScopes: ['entity_summary'],
      requiredMetrics: ['shareholderNames', 'shareholderInvestments'],
    })
  })

  it('projects runtime-boundary missing observations through Agentic OS without mutating the ledger', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    const repair = runtimeBoundaryMissingObservationRepair({
      ledger,
      objective: '计算贷款后的股东 ROI',
      toolNames: ['sandbox_run_code'],
    })

    expect(ledger.obligations).toEqual([])
    expect(repair).toMatchObject({
      toolNames: ['sandbox_run_code'],
      requiredGoalFacts: { requiresSandboxComputation: true },
      evaluation: {
        status: 'needs_calculation',
        findings: [expect.objectContaining({ code: 'response.sandbox_evidence_missing' })],
      },
      obligationLedger: {
        openCount: 1,
        obligations: [
          expect.objectContaining({
            id: 'runtime_boundary_sandbox_calculation',
            kind: 'sandbox_calculation',
            source: 'response_evaluator',
            toolNames: ['sandbox_run_code'],
          }),
        ],
      },
      obligationPlan: {
        requiredToolNames: ['sandbox_run_code'],
        selectedCapabilities: ['sandbox'],
        goalFacts: { requiresSandboxComputation: true },
        modelContext: {
          obligations: [
            expect.objectContaining({
              id: 'runtime_boundary_sandbox_calculation',
              kind: 'sandbox_calculation',
              toolNames: ['sandbox_run_code'],
            }),
          ],
        },
      },
    })
  })

  it('does not duplicate runtime-boundary repair obligations that already exist in the ledger', () => {
    const ledger = initializeObligationLedger({ runId: 'run_1' })
    applyResponseEvaluationToLedger({
      ledger,
      evaluation: evaluation({
        requiredEvidence: [
          { authority: 'sandbox', subject: 'calculation', reason: '需要可复核计算。' },
        ],
      }),
      iteration: 1,
    })

    const repair = runtimeBoundaryMissingObservationRepair({
      ledger,
      objective: '计算贷款后的股东 ROI',
      toolNames: ['sandbox_run_code'],
    })

    expect(repair?.obligationLedger.obligations).toHaveLength(1)
    expect(repair?.obligationPlan.obligations).toHaveLength(1)
    expect(repair?.obligationPlan.obligations[0]).toMatchObject({
      obligationId: 'loop_obligation_1_sandbox_calculation',
      kind: 'tool_observation',
      toolNames: ['sandbox_run_code'],
      metadata: expect.objectContaining({
        host: expect.objectContaining({ xoxKind: 'sandbox_calculation' }),
      }),
    })
  })
})
