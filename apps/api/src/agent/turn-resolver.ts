import type { AgentEvaluationResult, AgentToolLoopGuardrailFinding } from '@xox/contracts'
import type { AgentToolObservation } from './tool-observation-continuation.js'
import { isRepairableToolObservation } from './tool-observation-outcome.js'

type RowLike = {
  id: string
  status?: string | null
}

export type AgentNextStep =
  | { type: 'evaluate'; reason: string }
  | { type: 'continue_with_observations'; reason: string; observations: AgentToolObservation[] }
  | { type: 'await_confirmation'; reason: string; actionRequestIds: string[] }
  | { type: 'await_clarification'; reason: string; prompt: string | null }
  | { type: 'final_output'; reason: string; assistantText: string | null }
  | { type: 'run_again'; reason: string; nextMessage: string }
  | { type: 'blocked'; reason: string; evidence: string[] }
  | { type: 'failed'; reason: string; evidence: string[] }

export function repairMessage(input: {
  objective: string
  nextPlannerBrief: string
}) {
  return [
    input.nextPlannerBrief,
    '上一轮工具观察结果会随本次规划一起提供；不要重复已经完成的只读查询或确认卡。',
    '如果观察结果已足够确定对象和值，继续调用对应业务工具；仍无法唯一确定时再询问用户。',
    `当前目标：${input.objective}`,
  ].join('\n\n')
}

export function resolveAfterPlanning(input: {
  pendingAssistantText: string | null
  actionRows: RowLike[]
  planRows: RowLike[]
  observations: AgentToolObservation[]
  guardrailFindings: AgentToolLoopGuardrailFinding[]
  hasFinalAssistantCandidate?: boolean
}): AgentNextStep {
  const blockingGuardrail = input.guardrailFindings.find((finding) => finding.severity === 'block')
  if (blockingGuardrail) {
    return {
      type: 'failed',
      reason: blockingGuardrail.repairBrief,
      evidence: blockingGuardrail.evidence,
    }
  }

  if (input.hasFinalAssistantCandidate) {
    return {
      type: 'final_output',
      reason: 'final_assistant_candidate_after_observations',
      assistantText: input.pendingAssistantText,
    }
  }

  return {
    type: 'evaluate',
    reason: 'planning_outputs_require_evaluation',
  }
}

export function resolveAfterEvaluation(input: {
  evaluation: Pick<AgentEvaluationResult, 'status' | 'blocker' | 'nextPlannerBrief' | 'userQuestion' | 'unsatisfiedCriteria'>
  objective: string
  pendingAssistantText: string | null
  observations: AgentToolObservation[]
  newObservationCount: number
  actionRows: RowLike[]
}): AgentNextStep {
  if (input.evaluation.status === 'continue') {
    if (!input.evaluation.nextPlannerBrief) {
      return {
        type: 'failed',
        reason: 'Loop Readiness Check 要求继续，但没有给出下一轮修复 brief。',
        evidence: input.evaluation.unsatisfiedCriteria.map((finding) => finding.message),
      }
    }
    return {
      type: 'run_again',
      reason: 'evaluation_requires_repair',
      nextMessage: repairMessage({
        objective: input.objective,
        nextPlannerBrief: input.evaluation.nextPlannerBrief,
      }),
    }
  }

  if (input.evaluation.status === 'needs_confirmation') {
    return {
      type: 'await_confirmation',
      reason: input.evaluation.blocker ?? '等待用户处理确认卡。',
      actionRequestIds: input.actionRows.filter((row) => row.status === 'pending').map((row) => row.id),
    }
  }

  if (input.evaluation.status === 'needs_clarification') {
    return {
      type: 'await_clarification',
      reason: input.evaluation.blocker ?? '等待用户补充信息。',
      prompt: input.evaluation.userQuestion ?? input.evaluation.nextPlannerBrief ?? input.evaluation.blocker,
    }
  }

  if (input.evaluation.status === 'blocked') {
    return {
      type: 'blocked',
      reason: input.evaluation.blocker ?? '目标被策略或业务条件阻断。',
      evidence: input.evaluation.unsatisfiedCriteria.map((finding) => finding.message),
    }
  }

  if (input.evaluation.status === 'failed') {
    const newObservations = input.newObservationCount > 0 ? input.observations.slice(-input.newObservationCount) : []
    if (newObservations.some(isRepairableToolObservation)) {
      return {
        type: 'continue_with_observations',
        reason: 'failed_evaluation_contains_repairable_tool_observation',
        observations: newObservations,
      }
    }
    return {
      type: 'failed',
      reason: input.evaluation.blocker ?? '目标执行失败。',
      evidence: input.evaluation.unsatisfiedCriteria.map((finding) => finding.message),
    }
  }

  if (input.newObservationCount > 0) {
    return {
      type: 'continue_with_observations',
      reason: 'evaluation_passed_with_new_tool_observations',
      observations: input.observations.slice(-input.newObservationCount),
    }
  }

  return {
    type: 'final_output',
    reason: 'evaluation_passed_without_observations',
    assistantText: input.pendingAssistantText,
  }
}
