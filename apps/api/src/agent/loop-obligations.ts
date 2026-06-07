import type { AgentGoalFacts } from '@xox/contracts'
import type { AgentToolCapability } from './tool-catalog.js'
import type { AgentEvidenceAuthority } from './evidence-ledger.js'
import type { ResponseEvaluation } from './response-evaluator.js'

export type AgentLoopObligationKind =
  | 'assistant_final_answer'
  | 'sandbox_calculation'
  | 'domain_fact'

export type AgentLoopObligation = {
  id: string
  kind: AgentLoopObligationKind
  reason: string
  findingCodes: string[]
  authority?: AgentEvidenceAuthority
  subject?: string
  toolNames: string[]
  capabilities: AgentToolCapability[]
  goalFacts: AgentGoalFacts
  requiredDataScopes?: string[]
  requiredMetrics?: string[]
}

export type AgentLoopObligationPlan = {
  schemaVersion: 'xox.loop_obligation_plan.v1'
  objective: string
  obligations: AgentLoopObligation[]
  requiredToolNames: string[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  goalFacts: AgentGoalFacts
  modelContext: {
    purpose: 'satisfy_runner_obligations'
    obligations: Array<{
      id: string
      kind: AgentLoopObligationKind
      reason: string
      toolNames: string[]
      requiredDataScopes?: string[]
      requiredMetrics?: string[]
    }>
    instruction: string
  }
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

function findingCodes(evaluation: ResponseEvaluation) {
  return unique(evaluation.findings.map((finding) => finding.code).filter(Boolean))
}

function requirementObligation(input: {
  index: number
  authority: AgentEvidenceAuthority
  subject?: string
  reason: string
  findingCodes: string[]
}): AgentLoopObligation {
  if (input.authority === 'sandbox') {
    return {
      id: `loop_obligation_${input.index + 1}_sandbox_calculation`,
      kind: 'sandbox_calculation',
      authority: input.authority,
      ...(input.subject ? { subject: input.subject } : {}),
      reason: input.reason,
      findingCodes: input.findingCodes,
      toolNames: ['sandbox_run_code'],
      capabilities: ['sandbox'],
      goalFacts: { requiresSandboxComputation: true },
    }
  }

  if (input.authority === 'domain_read') {
    const shareholderFact = input.subject === 'shareholder'
    return {
      id: `loop_obligation_${input.index + 1}_${shareholderFact ? 'ordered_entity_fact' : 'domain_fact'}`,
      kind: 'domain_fact',
      authority: input.authority,
      ...(input.subject ? { subject: input.subject } : {}),
      reason: input.reason,
      findingCodes: input.findingCodes,
      toolNames: ['data_query_workspace'],
      capabilities: ['data'],
      goalFacts: shareholderFact ? { requiresOrderedEntityFacts: true } : {},
      ...(shareholderFact
        ? {
            requiredDataScopes: ['entity_summary'],
            requiredMetrics: ['shareholderNames', 'shareholderInvestments'],
          }
        : {}),
    }
  }

  return {
    id: `loop_obligation_${input.index + 1}_${input.authority}`,
    kind: 'domain_fact',
    authority: input.authority,
    ...(input.subject ? { subject: input.subject } : {}),
    reason: input.reason,
    findingCodes: input.findingCodes,
    toolNames: [],
    capabilities: [],
    goalFacts: {},
  }
}

export function loopObligationsFromResponseEvaluation(evaluation: ResponseEvaluation): AgentLoopObligation[] {
  const codes = findingCodes(evaluation)
  const obligations: AgentLoopObligation[] = []

  if (evaluation.status === 'needs_final_answer') {
    obligations.push({
      id: 'loop_obligation_assistant_final_answer',
      kind: 'assistant_final_answer',
      reason: evaluation.findings.find((finding) => finding.code === 'response.final_answer_missing')?.message ??
        'Tool observations exist but the model has not produced a final user-facing answer.',
      findingCodes: codes,
      toolNames: [],
      capabilities: [],
      goalFacts: {},
    })
  }

  for (const [index, requirement] of evaluation.requiredEvidence.entries()) {
    if (evaluation.status === 'needs_more_evidence' && requirement.authority !== 'domain_read') continue
    if (
      evaluation.status === 'needs_calculation' &&
      requirement.authority !== 'sandbox' &&
      !(requirement.authority === 'domain_read' && requirement.subject === 'shareholder')
    ) {
      continue
    }
    const duplicateFinalAnswerRequirement =
      evaluation.status === 'needs_final_answer' &&
      requirement.authority === 'domain_read' &&
      !requirement.subject
    if (duplicateFinalAnswerRequirement) continue

    obligations.push(requirementObligation({
      index,
      authority: requirement.authority,
      ...(requirement.subject ? { subject: requirement.subject } : {}),
      reason: requirement.reason,
      findingCodes: codes,
    }))
  }

  return obligations
}

function mergeGoalFacts(values: AgentGoalFacts[]) {
  const merged: AgentGoalFacts = {}
  const forbiddenActions = new Set<NonNullable<AgentGoalFacts['forbiddenActions']>[number]>()
  for (const value of values) {
    if (value.workspaceName) merged.workspaceName = value.workspaceName
    if (value.expectedMemberCount) merged.expectedMemberCount = value.expectedMemberCount
    if (value.expectedShareholderCount) merged.expectedShareholderCount = value.expectedShareholderCount
    if (value.expectedHorizonMonths) merged.expectedHorizonMonths = value.expectedHorizonMonths
    if (value.expectedStartMonth) merged.expectedStartMonth = value.expectedStartMonth
    if (value.requiresForecastSummary) merged.requiresForecastSummary = true
    if (value.requiresSandboxComputation) merged.requiresSandboxComputation = true
    if (value.requiresOrderedEntityFacts) merged.requiresOrderedEntityFacts = true
    for (const action of value.forbiddenActions ?? []) forbiddenActions.add(action)
  }
  if (forbiddenActions.size > 0) merged.forbiddenActions = [...forbiddenActions]
  return merged
}

export function planLoopObligations(input: {
  objective: string
  obligations: AgentLoopObligation[]
}): AgentLoopObligationPlan | null {
  if (input.obligations.length === 0) return null
  const toolNames = unique(input.obligations.flatMap((obligation) => obligation.toolNames))
  const capabilities = unique(input.obligations.flatMap((obligation) => obligation.capabilities))
  const goalFacts = mergeGoalFacts(input.obligations.map((obligation) => obligation.goalFacts))

  return {
    schemaVersion: 'xox.loop_obligation_plan.v1',
    objective: input.objective,
    obligations: input.obligations,
    requiredToolNames: toolNames,
    selectedCapabilities: capabilities,
    requiredActionCapabilities: [],
    goalFacts,
    modelContext: {
      purpose: 'satisfy_runner_obligations',
      obligations: input.obligations.map((obligation) => ({
        id: obligation.id,
        kind: obligation.kind,
        reason: obligation.reason,
        toolNames: obligation.toolNames,
        ...(obligation.requiredDataScopes ? { requiredDataScopes: obligation.requiredDataScopes } : {}),
        ...(obligation.requiredMetrics ? { requiredMetrics: obligation.requiredMetrics } : {}),
      })),
      instruction: [
        'Continue the same user objective.',
        'Satisfy the listed runner-owned obligations through tool observations before producing a final answer.',
        'Tool outputs are observations for the model; they are not the user-facing final answer.',
      ].join(' '),
    },
  }
}

export function fallbackLoopObligationPlan(input: {
  objective: string
  instruction: string
}): AgentLoopObligationPlan {
  return {
    schemaVersion: 'xox.loop_obligation_plan.v1',
    objective: input.objective,
    obligations: [],
    requiredToolNames: [],
    selectedCapabilities: [],
    requiredActionCapabilities: [],
    goalFacts: {},
    modelContext: {
      purpose: 'satisfy_runner_obligations',
      obligations: [],
      instruction: input.instruction,
    },
  }
}

export function userSafeObligationFailureSummary(plan: AgentLoopObligationPlan | null) {
  if (!plan || plan.obligations.length === 0) {
    return '这轮没有完成所有目标：缺少必要的可复核证据，已停止以避免基于不完整信息回答。'
  }
  const hasSandbox = plan.obligations.some((obligation) => obligation.kind === 'sandbox_calculation')
  const hasDomainFacts = plan.obligations.some((obligation) => obligation.kind === 'domain_fact')
  if (hasSandbox && hasDomainFacts) {
    return '这轮没有完成所有目标：仍缺少必要的工作区事实和可复核计算结果，已停止以避免基于不完整信息回答。'
  }
  if (hasSandbox) {
    return '这轮没有完成所有目标：可复核计算还没有成功完成，已停止以避免给出未经验证的结果。'
  }
  if (hasDomainFacts) {
    return '这轮没有完成所有目标：仍缺少必要的工作区事实，已停止以避免用全局口径替代具体对象口径。'
  }
  return '这轮没有完成所有目标：模型还没有基于已取得的工具结果生成最终回答。'
}
