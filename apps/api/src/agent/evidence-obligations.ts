import type { AgentEvidenceAuthority } from './evidence-ledger.js'
import type { ResponseEvaluation } from './response-evaluator.js'

export type AgentEvidenceObligationKind =
  | 'assistant_final_answer'
  | 'sandbox_calculation'
  | 'domain_fact'

export type AgentEvidenceObligation = {
  id: string
  kind: AgentEvidenceObligationKind
  authority?: AgentEvidenceAuthority
  subject?: string
  reason: string
  toolNames: string[]
  findingCodes: string[]
  plannerInstruction: string
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function requirementObligation(input: {
  index: number
  authority: AgentEvidenceAuthority
  subject?: string
  reason: string
  findingCodes: string[]
}): AgentEvidenceObligation {
  if (input.authority === 'sandbox') {
    return {
      id: `evidence_obligation_${input.index + 1}_sandbox_calculation`,
      kind: 'sandbox_calculation',
      authority: input.authority,
      ...(input.subject ? { subject: input.subject } : {}),
      reason: input.reason,
      toolNames: ['sandbox_run_code'],
      findingCodes: input.findingCodes,
      plannerInstruction: 'Run sandbox_run_code with the available domain facts. Return a real sandbox observation before any final answer.',
    }
  }

  if (input.authority === 'domain_read') {
    return {
      id: `evidence_obligation_${input.index + 1}_domain_fact`,
      kind: 'domain_fact',
      authority: input.authority,
      ...(input.subject ? { subject: input.subject } : {}),
      reason: input.reason,
      toolNames: ['data_query_workspace'],
      findingCodes: input.findingCodes,
      plannerInstruction: input.subject === 'shareholder'
        ? 'Read ordered shareholder/entity facts with data_query_workspace before making entity-specific claims.'
        : 'Read the required workspace facts with data_query_workspace before answering.',
    }
  }

  return {
    id: `evidence_obligation_${input.index + 1}_${input.authority}`,
    kind: 'domain_fact',
    authority: input.authority,
    ...(input.subject ? { subject: input.subject } : {}),
    reason: input.reason,
    toolNames: [],
    findingCodes: input.findingCodes,
    plannerInstruction: 'Satisfy this evidence requirement through the existing run loop before final answer.',
  }
}

export function obligationsFromResponseEvaluation(evaluation: ResponseEvaluation): AgentEvidenceObligation[] {
  const findingCodes = unique(evaluation.findings.map((finding) => finding.code))
  const obligations: AgentEvidenceObligation[] = []

  if (evaluation.status === 'needs_final_answer') {
    obligations.push({
      id: 'evidence_obligation_assistant_final_answer',
      kind: 'assistant_final_answer',
      reason: evaluation.findings.find((finding) => finding.code === 'response.final_answer_missing')?.message ??
        'Tool observations exist but the model has not produced a final user-facing answer.',
      toolNames: [],
      findingCodes,
      plannerInstruction: 'Use the replayed observations to produce the final assistant answer. Do not call tools unless another obligation explicitly requires one.',
    })
  }

  for (const [index, requirement] of evaluation.requiredEvidence.entries()) {
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
      findingCodes,
    }))
  }

  return obligations
}

export function obligationRepairMessage(input: {
  objective: string
  obligations: AgentEvidenceObligation[]
  fallbackBrief?: string | null
}) {
  if (input.obligations.length === 0) {
    return [
      input.fallbackBrief ?? 'Continue the same objective through the runner loop.',
      `Objective: ${input.objective}`,
    ].join('\n\n')
  }

  return [
    'Runner evidence obligations:',
    JSON.stringify(input.obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      authority: obligation.authority ?? null,
      subject: obligation.subject ?? null,
      toolNames: obligation.toolNames,
      reason: obligation.reason,
      instruction: obligation.plannerInstruction,
    }))),
    'Satisfy these obligations inside the current run. Tool outputs are observations for the next assistant turn, not final user answers.',
    `Objective: ${input.objective}`,
  ].join('\n\n')
}
