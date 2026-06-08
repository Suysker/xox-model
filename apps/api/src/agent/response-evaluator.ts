import type { AgentGoalFacts } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import type { AgentEvidenceAuthority, AgentEvidenceItem, AgentFinalAnswerClaim } from './evidence-ledger.js'
import { buildEvidenceRequirements, isExecutedSandboxEvidenceFacts } from './evidence-ledger.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'
import type { AgentGoalContract } from '@xox/contracts'
import { mergeAgentGoalFacts } from './runtime-goal-facts.js'
import { objectHasKey } from './structured-evidence-utils.js'
import { classifyToolObservation } from './tool-observation-outcome.js'

export type ResponseEvaluationStatus =
  | 'pass'
  | 'awaiting_confirmation'
  | 'awaiting_clarification'
  | 'needs_more_evidence'
  | 'needs_calculation'
  | 'needs_final_answer'
  | 'blocked'

export type ResponseEvaluationFinding = {
  severity: 'info' | 'warn' | 'fail'
  code: string
  evidenceIds: string[]
  message: string
}

export type ResponseEvaluation = {
  status: ResponseEvaluationStatus
  confidence: number
  requiredEvidence: Array<{
    authority: AgentEvidenceAuthority
    subject?: string
    reason: string
  }>
  findings: ResponseEvaluationFinding[]
  nextPlannerBrief: string | null
}

export function responseEvaluationSummary(evaluation: ResponseEvaluation) {
  if (evaluation.status === 'pass') return '最终回答已通过 run-scoped evidence 检查。'
  if (evaluation.status === 'awaiting_confirmation') return '当前存在待确认动作，最终回答只作为中断说明，不关闭目标。'
  if (evaluation.status === 'awaiting_clarification') return '当前存在待澄清问题，最终回答只作为中断说明，不关闭目标。'
  if (evaluation.status === 'needs_calculation') return '最终回答还缺少可复核计算 evidence。'
  if (evaluation.status === 'needs_more_evidence') return '最终回答还缺少必要的结构化事实 evidence。'
  if (evaluation.status === 'needs_final_answer') return '工具 observation 已产生，但还没有模型最终回答。'
  return '最终回答证据检查被阻断。'
}

function goalFactsFromRow(goal: Row<'agent_goals'>): AgentGoalFacts {
  const contract = parseJson<Partial<AgentGoalContract>>(goal.contract_json, {})
  return contract.facts && typeof contract.facts === 'object' ? contract.facts : {}
}

function isCompletedObservation(observation: AgentToolObservation) {
  return observation.status === 'completed' && classifyToolObservation(observation) === 'completed_valid'
}

function hasCompletedSandboxEvidence(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) =>
    item.authority === 'sandbox' &&
    item.validity === 'valid' &&
    isExecutedSandboxEvidenceFacts(item.facts))
}

function sandboxEvidenceItems(evidence: AgentEvidenceItem[]) {
  return evidence.filter((item) => item.authority === 'sandbox' || item.source === 'sandbox_run_code')
}

function invalidSandboxEvidenceItems(evidence: AgentEvidenceItem[]) {
  return sandboxEvidenceItems(evidence).filter((item) =>
    item.validity !== 'valid' ||
    !isExecutedSandboxEvidenceFacts(item.facts))
}

function hasOrderedShareholderDomainEvidence(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) =>
    item.authority === 'domain_read' &&
    item.validity === 'valid' &&
    item.source === 'data_query_workspace' &&
    (objectHasKey(item.facts, 'firstShareholder') || objectHasKey(item.facts, 'shareholders')))
}

export function evaluateAssistantResponse(input: {
  goal: Row<'agent_goals'>
  finalAssistantText: string | null
  observations: AgentToolObservation[]
  evidence: AgentEvidenceItem[]
  finalAnswerClaims?: AgentFinalAnswerClaim[]
  runtimeFacts?: AgentGoalFacts
  pendingActionCount?: number
  awaitingClarification?: boolean
}): ResponseEvaluation {
  const facts = mergeAgentGoalFacts(goalFactsFromRow(input.goal), input.runtimeFacts ?? {})
  const requiredEvidence: ResponseEvaluation['requiredEvidence'] = []
  const findings: ResponseEvaluationFinding[] = []
  const finalText = input.finalAssistantText?.trim() ?? ''

  if ((input.pendingActionCount ?? 0) > 0) {
    return {
      status: 'awaiting_confirmation',
      confidence: 0.99,
      requiredEvidence,
      findings: [{
        severity: 'info',
        code: 'response.pending_confirmation_interrupt',
        evidenceIds: input.evidence.map((item) => item.id),
        message: '运行图中仍有待确认动作，不能把说明文字判定为目标完成。',
      }],
      nextPlannerBrief: null,
    }
  }

  if (input.awaitingClarification) {
    return {
      status: 'awaiting_clarification',
      confidence: 0.99,
      requiredEvidence,
      findings: [{
        severity: 'info',
        code: 'response.pending_clarification_interrupt',
        evidenceIds: input.evidence.map((item) => item.id),
        message: '运行图中仍有待澄清问题，不能把说明文字判定为目标完成。',
      }],
      nextPlannerBrief: null,
    }
  }

  if (input.observations.length > 0 && finalText.length === 0) {
    requiredEvidence.push({
      authority: 'domain_read',
      reason: '工具 observation 已产生，但还没有模型最终回答。',
    })
    findings.push({
      severity: 'fail',
      code: 'response.final_answer_missing',
      evidenceIds: input.evidence.map((item) => item.id),
      message: '工具结果只能作为 observation，不能替代面向用户的 assistant final answer。',
    })
    return {
      status: 'needs_final_answer',
      confidence: 0.99,
      requiredEvidence,
      findings,
      nextPlannerBrief: '基于已经取得的 observation 生成最终回答；不要把工具返回原文当成最终回答。',
    }
  }

  const evidenceRequirements = buildEvidenceRequirements({
    facts,
    evidence: input.evidence,
    finalAnswerClaims: input.finalAnswerClaims ?? [],
  })
  requiredEvidence.push(...evidenceRequirements.map((requirement) => ({
    authority: requirement.authority,
    ...(requirement.subject ? { subject: requirement.subject } : {}),
    reason: requirement.reason,
  })))
  const sandboxEvidence = sandboxEvidenceItems(input.evidence)
  const requiresSandboxEvidence = evidenceRequirements.some((requirement) => requirement.authority === 'sandbox')
  const requiresShareholderEvidence = evidenceRequirements.some((requirement) =>
    requirement.authority === 'domain_read' && requirement.subject === 'shareholder')

  if (requiresSandboxEvidence) {
    const completedSandbox = hasCompletedSandboxEvidence(input.evidence)
    if (!completedSandbox) {
      const invalidSandbox = invalidSandboxEvidenceItems(input.evidence)
      const code = invalidSandbox.length > 0
        ? 'response.sandbox_evidence_invalid'
        : 'response.sandbox_evidence_missing'
      findings.push({
        severity: 'fail',
        code,
        evidenceIds: (invalidSandbox.length > 0 ? invalidSandbox : sandboxEvidence).map((item) => item.id),
        message: invalidSandbox.length > 0
          ? '本轮 sandbox_run_code observation 未真实完成、退出异常或缺少可读输出，不能作为计算 evidence。'
          : '最终回答依赖派生计算，但本轮还没有完成的 sandbox_run_code evidence。',
      })
      return {
        status: 'needs_calculation',
        confidence: 0.96,
        requiredEvidence,
        findings,
        nextPlannerBrief: invalidSandbox.length > 0
          ? '继续或修复 sandbox_run_code，确保真实执行并产生可读 stdout、文本结果或 artifact，再基于 observation 生成最终回答。'
          : '继续调用 sandbox_run_code，用当前工作区事实完成可复核计算，再生成最终回答。',
      }
    }

  }

  if (requiresShareholderEvidence &&
    !hasOrderedShareholderDomainEvidence(input.evidence)) {
    findings.push({
      severity: 'fail',
      code: 'response.entity_evidence_missing',
      evidenceIds: input.evidence.map((item) => item.id),
      message: '本轮缺少可复核的有序股东事实，不能把全局口径当成个人股东口径。',
    })
    return {
      status: 'needs_more_evidence',
      confidence: 0.9,
      requiredEvidence,
      findings,
      nextPlannerBrief: '补充包含有序股东信息的工作区事实，再基于该事实生成最终回答。',
    }
  }

  if (finalText.length === 0) {
    findings.push({
      severity: 'fail',
      code: 'response.empty_final_answer',
      evidenceIds: input.evidence.map((item) => item.id),
      message: '没有可展示的最终回答。',
    })
    return {
      status: 'needs_final_answer',
      confidence: 0.98,
      requiredEvidence,
      findings,
      nextPlannerBrief: '生成一个面向用户的最终回答。',
    }
  }

  findings.push({
    severity: 'info',
    code: 'response.evidence_accepted',
    evidenceIds: input.evidence.filter((item) => item.authority !== 'memory').map((item) => item.id),
    message: input.evidence.some((item) => item.authority === 'sandbox')
      ? '最终回答已在 sandbox/domain evidence 之后生成。'
      : '最终回答已在当前 run evidence 之后生成。',
  })
  return {
    status: 'pass',
    confidence: input.evidence.some((item) => item.authority === 'sandbox') ? 0.94 : 0.9,
    requiredEvidence,
    findings,
    nextPlannerBrief: null,
  }
}

export function hasCompletedToolEvidence(observations: AgentToolObservation[]) {
  return observations.some(isCompletedObservation)
}
