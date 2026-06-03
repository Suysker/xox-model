import { describe, expect, it } from 'vitest'
import type { Row } from '../src/db/schema.js'
import { buildEvidenceLedger } from '../src/agent/evidence-ledger.js'
import { evaluateAssistantResponse } from '../src/agent/response-evaluator.js'
import type { AgentToolObservation } from '../src/agent/tool-observation-continuation.js'

function goal(facts: Record<string, unknown> = {}): Row<'agent_goals'> {
  return {
    id: 'goal_1',
    thread_id: 'thread_1',
    run_id: 'run_1',
    workspace_id: 'workspace_1',
    user_id: 'user_1',
    status: 'planning',
    objective: 'test objective',
    contract_json: JSON.stringify({
      goalId: 'goal_1',
      threadId: 'thread_1',
      runId: 'run_1',
      userId: 'user_1',
      workspaceId: 'workspace_1',
      objective: 'test objective',
      scope: { workspace: 'current', pages: [], allowedCapabilities: [] },
      acceptanceCriteria: [],
      facts,
      forbiddenActions: [],
      humanCheckpoints: [],
      automationLevel: 'manual',
      maxIterations: 5,
      contextStrategy: { memoryScopes: [], compactionMode: 'summary' },
    }),
    created_at: '2026-06-02T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    completed_at: null,
    blocked_reason: null,
  } as Row<'agent_goals'>
}

function observation(overrides: Partial<AgentToolObservation> = {}): AgentToolObservation {
  return {
    title: '查询工作区数据',
    toolName: 'data_query_workspace',
    toolCallId: 'call_data',
    toolArguments: { scope: 'workspace_summary' },
    displayPreview: '已读取工作区数据',
    modelContent: JSON.stringify({
      scope: 'workspace_summary',
      grossSales: 100,
      totalCost: 80,
      totalProfit: 20,
    }),
    status: 'completed',
    ...overrides,
  }
}

describe('Agent response evaluator', () => {
  it('does not let tool observations replace the final assistant answer', () => {
    const observations = [observation()]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: null,
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_final_answer',
      findings: [expect.objectContaining({ code: 'response.final_answer_missing' })],
    })
  })

  it('requires sandbox evidence when the goal contract asks for derived computation', () => {
    const observations = [observation()]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '当前回报需要计算。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_missing' })],
    })
  })

  it('treats pending confirmation or clarification as an interruption rather than completion', () => {
    const observations = [observation()]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '已生成确认卡，等待你确认。',
      observations,
      evidence,
      pendingActionCount: 1,
    })).toMatchObject({
      status: 'awaiting_confirmation',
      findings: [expect.objectContaining({ code: 'response.pending_confirmation_interrupt' })],
    })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '还需要你补充成员名称。',
      observations,
      evidence,
      awaitingClarification: true,
    })).toMatchObject({
      status: 'awaiting_clarification',
      findings: [expect.objectContaining({ code: 'response.pending_clarification_interrupt' })],
    })
  })

  it('accepts final answers after sandbox evidence includes ordered shareholder facts', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_result',
          completed: true,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          manifestConsumed: true,
          manifestConsumption: {
            manifestId: 'manifest_1',
            bundleId: 'bundle_1',
            contentHash: 'hash_1',
            nonceMatched: true,
          },
          purpose: '计算第一位股东投资回报',
          structuredOutput: {
            schemaVersion: 'xox.sandbox.result.v1',
            observedInput: {
              manifestId: 'manifest_1',
              bundleId: 'bundle_1',
              contentHash: 'hash_1',
              nonce: 'nonce_1',
            },
            structured: {
              firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
              shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
            },
          },
          result: {
            structured: {
              data: {
                firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
                shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
              },
            },
          },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '按沙箱计算，股东 A 的个人回报率为 12%。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'pass',
      findings: [expect.objectContaining({ code: 'response.evidence_accepted' })],
    })
  })

  it('rejects sandbox-shaped fixtures that did not execute real code', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_result',
          completed: true,
          status: 'completed',
          executionMode: 'not_executed',
          exitCode: 0,
          structuredOutput: { structured: { answer: 1 } },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evidence.some((item) => item.authority === 'sandbox')).toBe(false)
    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '沙箱已经算完。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_missing' })],
    })
  })

  it('rejects executed sandbox observations that did not consume the manifest bundle', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_result',
          completed: false,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          manifestConsumed: false,
          structuredOutput: {
            schemaVersion: 'xox.sandbox.result.v1',
            structured: { answer: 1 },
          },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evidence.some((item) => item.authority === 'sandbox')).toBe(false)
    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '沙箱已经算完。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_missing' })],
    })
  })
})
