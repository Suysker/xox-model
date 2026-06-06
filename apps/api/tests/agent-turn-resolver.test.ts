import { describe, expect, it } from 'vitest'
import type { AgentEvaluationResult, AgentToolLoopGuardrailFinding } from '@xox/contracts'
import {
  repairMessage,
  resolveAfterEvaluation,
  resolveAfterPlanning,
} from '../src/agent/turn-resolver.js'
import type { AgentToolObservation } from '../src/agent/tool-observation-continuation.js'

const observation: AgentToolObservation = {
  title: '查询工作区数据',
  toolName: 'data_query_workspace',
  toolCallId: 'call_read_1',
  toolArguments: { question: '几个月回本' },
  displayPreview: '已读取回本周期。',
  modelContent: '{"paybackMonthLabel":null}',
  status: 'completed',
}

function evaluation(status: AgentEvaluationResult['status'], overrides: Partial<AgentEvaluationResult> = {}) {
  return {
    status,
    blocker: null,
    nextPlannerBrief: null,
    userQuestion: null,
    unsatisfiedCriteria: [],
    ...overrides,
  } satisfies Pick<AgentEvaluationResult, 'status' | 'blocker' | 'nextPlannerBrief' | 'userQuestion' | 'unsatisfiedCriteria'>
}

describe('Agent turn resolver', () => {
  it('routes plain assistant text through evaluation before it can become final output', () => {
    expect(resolveAfterPlanning({
      pendingAssistantText: '你好，我可以帮你处理经营模型。',
      actionRows: [],
      planRows: [],
      observations: [],
      guardrailFindings: [],
    })).toMatchObject({ type: 'evaluate' })
  })

  it('preserves assistant text plus tool observations as work that still needs evaluation', () => {
    expect(resolveAfterPlanning({
      pendingAssistantText: '我先查询回本数据。',
      actionRows: [],
      planRows: [{ id: 'step_1', status: 'completed' }],
      observations: [observation],
      guardrailFindings: [],
    })).toMatchObject({ type: 'evaluate' })
  })

  it('routes a final assistant candidate after consumed observations to final evidence evaluation', () => {
    expect(resolveAfterPlanning({
      pendingAssistantText: '根据刚才的工具结果，目前还没有回本。',
      actionRows: [],
      planRows: [],
      observations: [],
      guardrailFindings: [],
      hasFinalAssistantCandidate: true,
    })).toEqual({
      type: 'final_output',
      reason: 'final_assistant_candidate_after_observations',
      assistantText: '根据刚才的工具结果，目前还没有回本。',
    })
  })

  it('turns blocking tool-loop findings into a failed next step', () => {
    const finding: AgentToolLoopGuardrailFinding = {
      severity: 'block',
      pattern: 'no_progress',
      evidence: ['same tool repeated'],
      repairBrief: '工具调用没有产生新进展。',
    }
    expect(resolveAfterPlanning({
      pendingAssistantText: null,
      actionRows: [],
      planRows: [],
      observations: [],
      guardrailFindings: [finding],
    })).toEqual({
      type: 'failed',
      reason: '工具调用没有产生新进展。',
      evidence: ['same tool repeated'],
    })
  })

  it('turns evaluator continue into a scoped repair prompt for the same objective', () => {
    const nextPlannerBrief = '还需要先读取成员和股东列表。'
    expect(resolveAfterEvaluation({
      evaluation: evaluation('continue', { nextPlannerBrief }),
      objective: '我们几个月才能回本？帮成员 A 记账。',
      pendingAssistantText: null,
      observations: [observation],
      newObservationCount: 1,
      actionRows: [],
    })).toEqual({
      type: 'run_again',
      reason: 'evaluation_requires_repair',
      nextMessage: repairMessage({
        objective: '我们几个月才能回本？帮成员 A 记账。',
        nextPlannerBrief,
      }),
    })
  })

  it('keeps pending confirmations as an interruption instead of a final answer', () => {
    expect(resolveAfterEvaluation({
      evaluation: evaluation('needs_confirmation', { blocker: '等待 1 张确认卡。' }),
      objective: '股东 A 注资 100 万',
      pendingAssistantText: '已生成确认卡。',
      observations: [observation],
      newObservationCount: 1,
      actionRows: [
        { id: 'action_pending', status: 'pending' },
        { id: 'action_done', status: 'executed' },
      ],
    })).toEqual({
      type: 'await_confirmation',
      reason: '等待 1 张确认卡。',
      actionRequestIds: ['action_pending'],
    })
  })

  it('requires main-loop continuation after a passing evaluation with new tool observations', () => {
    expect(resolveAfterEvaluation({
      evaluation: evaluation('pass'),
      objective: '我们几个月回本？',
      pendingAssistantText: null,
      observations: [observation],
      newObservationCount: 1,
      actionRows: [],
    })).toEqual({
      type: 'continue_with_observations',
      reason: 'evaluation_passed_with_new_tool_observations',
      observations: [observation],
    })
  })

  it('allows final assistant output after observations have already been consumed by a later turn', () => {
    expect(resolveAfterEvaluation({
      evaluation: evaluation('pass'),
      objective: '我们几个月回本？',
      pendingAssistantText: '目前尚未回本。',
      observations: [observation],
      newObservationCount: 0,
      actionRows: [],
    })).toEqual({
      type: 'final_output',
      reason: 'evaluation_passed_without_observations',
      assistantText: '目前尚未回本。',
    })
  })
})
