import { describe, expect, it } from 'vitest'
import type { ResponseEvaluation } from '../src/agent/response-evaluator.js'
import type { AgentToolObservation } from '../src/agent/tool-observation-continuation.js'
import {
  activeLedgerObligations,
  applyObservationToLedger,
  applyResponseEvaluationToLedger,
  canAttemptFinalAnswer,
  initializeObligationLedger,
  ledgerToObligationPlan,
  serializeObligationLedger,
} from '../src/agent/loop-obligation-ledger.js'

function evaluation(overrides: Partial<ResponseEvaluation> = {}): ResponseEvaluation {
  return {
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
})
