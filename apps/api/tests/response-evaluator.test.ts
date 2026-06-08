import { describe, expect, it } from 'vitest'
import type { Row } from '../src/db/schema.js'
import { buildEvidenceLedger } from '../src/agent/evidence-ledger.js'
import { loopObligationsFromResponseEvaluation, planLoopObligations } from '../src/agent/loop-obligations.js'
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

  it('rejects provider plain-text tool-call artifacts as final assistant answers', () => {
    const observations = [observation()]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })
    const leakedToolCallText = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="sandbox_run_code">',
      '<｜DSML｜parameter name="code">print("roi")</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('\n')

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: leakedToolCallText,
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_final_answer',
      findings: [expect.objectContaining({ code: 'response.provider_tool_call_text_not_final' })],
    })
  })

  it('rejects truncated provider plain-text tool-call markers as final assistant answers', () => {
    const observations = [observation()]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="sandbox_run_code">\n<｜｜DSML｜｜parameter name="purpose">retry',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_final_answer',
      findings: [expect.objectContaining({ code: 'response.provider_tool_call_text_not_final' })],
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

  it('accepts final answers only after domain shareholder facts and sandbox calculation both exist', () => {
    const observations = [
      observation({
        toolCallId: 'call_entity',
        toolArguments: { scope: 'entity_summary' },
        modelContent: JSON.stringify({
          scope: 'entity_summary',
          shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
          firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
        }),
      }),
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: true,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          outputText: '',
          stdout: '',
          artifacts: [],
          purpose: '计算第一位股东投资回报',
          extraction: {
            extractionStatus: 'parsed',
            parsedOutput: {
              schemaVersion: 'xox.sandbox.result.v1',
              structured: {
                firstShareholder: { index: 1, name: '股东 A', investmentAmount: 1000000 },
                shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
              },
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
      goal: goal({ requiresSandboxComputation: true, requiresOrderedEntityFacts: true }),
      finalAssistantText: '按沙箱计算，股东 A 的个人回报率为 12%。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'pass',
      findings: [expect.objectContaining({ code: 'response.evidence_accepted' })],
    })
  })

  it('does not let sandbox-embedded shareholder fields satisfy domain shareholder evidence', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: true,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          stdout: 'shareholder ROI: 12%',
          artifacts: [],
          purpose: '计算第一位股东投资回报',
          extraction: {
            extractionStatus: 'parsed',
            parsedOutput: {
              shareholders: [{ index: 1, name: '股东 A', investmentAmount: 1000000 }],
            },
          },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true, requiresOrderedEntityFacts: true }),
      finalAssistantText: '按沙箱计算，股东 A 的个人回报率为 12%。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_more_evidence',
      findings: [expect.objectContaining({ code: 'response.entity_evidence_missing' })],
    })
  })

  it('rejects sandbox-shaped fixtures that did not execute real code', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: true,
          status: 'completed',
          executionMode: 'not_executed',
          exitCode: 0,
          manifestScoped: true,
          outputText: 'answer: 1',
          extraction: { extractionStatus: 'text_only', summary: 'answer: 1' },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evidence).toEqual([
      expect.objectContaining({
        authority: 'sandbox',
        validity: 'invalid',
        source: 'sandbox_run_code',
        invalidReasons: expect.arrayContaining(['sandbox_not_executed']),
      }),
    ])
    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '沙箱已经算完。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_invalid' })],
    })
  })

  it('rejects completed sandbox observations with no readable output', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: false,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          outputText: '',
          stdout: '',
          artifacts: [],
          extraction: { extractionStatus: 'empty' },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evidence).toEqual([
      expect.objectContaining({
        authority: 'sandbox',
        validity: 'invalid',
        source: 'sandbox_run_code',
        invalidReasons: expect.arrayContaining(['sandbox_output_missing']),
      }),
    ])
    expect(evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true }),
      finalAssistantText: '沙箱已经算完。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_invalid' })],
    })
  })

  it('rejects failed sandbox trajectory even when initial goal facts are empty', () => {
    const observations = [
      observation({
        title: '受控沙箱执行被阻断',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: false,
          status: 'failed',
          executionMode: 'executed',
          exitCode: 1,
          manifestScoped: true,
          outputText: 'Traceback: boom',
          stderr: 'Traceback: boom',
          artifacts: [],
          extraction: { extractionStatus: 'text_only', summary: 'Traceback: boom' },
        }),
        status: 'failed',
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '我已经算出了结果。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'needs_calculation',
      findings: [expect.objectContaining({ code: 'response.sandbox_evidence_invalid' })],
    })
  })

  it('accepts readable sandbox observations from the actual tool trajectory even when goal facts are missing', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: true,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          outputText: 'answer: 1',
          stdout: 'answer: 1',
          artifacts: [],
          extraction: { extractionStatus: 'text_only', summary: 'answer: 1' },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evidence[0]).toMatchObject({
      authority: 'sandbox',
      validity: 'valid',
      source: 'sandbox_run_code',
    })
    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '沙箱已经算完。',
      observations,
      evidence,
    })).toMatchObject({
      status: 'pass',
      findings: [expect.objectContaining({ code: 'response.evidence_accepted' })],
    })
  })

  it('requires ordered shareholder evidence for structured final-answer entity claims', () => {
    const observations = [
      observation({
        title: '受控沙箱执行完成',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'sandbox_execution',
          completed: true,
          status: 'completed',
          executionMode: 'executed',
          exitCode: 0,
          manifestScoped: true,
          outputText: 'personal ROI: 12%',
          stdout: 'personal ROI: 12%',
          artifacts: [],
          purpose: '计算个人股东回报',
          extraction: { extractionStatus: 'text_only', summary: 'personal ROI: 12%' },
        }),
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })

    expect(evaluateAssistantResponse({
      goal: goal(),
      finalAssistantText: '第 2 位股东的个人投资回报率是 12%。',
      observations,
      evidence,
      finalAnswerClaims: [{ kind: 'entity_specific', subject: 'shareholder', reason: 'final answer claims shareholder-specific ROI' }],
    })).toMatchObject({
      status: 'needs_more_evidence',
      findings: [expect.objectContaining({ code: 'response.entity_evidence_missing' })],
    })
  })

  it('turns evaluator findings into typed runner obligations', () => {
    const observations = [
      observation({
        title: '受控沙箱执行被阻断',
        toolName: 'sandbox_run_code',
        toolCallId: 'call_sandbox',
        modelContent: JSON.stringify({
          observationType: 'provider_tool_call_boundary',
          completed: false,
          status: 'not_executed',
          executionMode: 'not_executed',
          toolName: 'sandbox_run_code',
          manifestScoped: false,
        }),
        status: 'not_executed',
        synthetic: true,
      }),
    ]
    const evidence = buildEvidenceLedger({ threadId: 'thread_1', runId: 'run_1', observations })
    const evaluation = evaluateAssistantResponse({
      goal: goal({ requiresSandboxComputation: true, requiresOrderedEntityFacts: true }),
      finalAssistantText: '第 1 位股东贷款后的 ROI 是 12%。',
      observations,
      evidence,
    })

    const obligations = loopObligationsFromResponseEvaluation(evaluation)
    expect(obligations).toEqual([
      expect.objectContaining({
        kind: 'sandbox_calculation',
        toolNames: ['sandbox_run_code'],
        findingCodes: expect.arrayContaining(['response.sandbox_evidence_invalid']),
      }),
      expect.objectContaining({
        kind: 'domain_fact',
        subject: 'shareholder',
        toolNames: ['data_query_workspace'],
      }),
    ])
    expect(planLoopObligations({ objective: 'test objective', obligations })).toMatchObject({
      requiredToolNames: expect.arrayContaining(['sandbox_run_code', 'data_query_workspace']),
      selectedCapabilities: expect.arrayContaining(['sandbox', 'data']),
      goalFacts: {
        requiresSandboxComputation: true,
        requiresOrderedEntityFacts: true,
      },
    })
  })
})
