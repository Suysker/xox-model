import type { AgentToolObservation } from './tool-observation-continuation.js'
import { isExecutedSandboxEvidenceFacts } from './evidence-ledger.js'
import type { ResponseEvaluation } from './response-evaluator.js'
import { objectHasKey } from './structured-evidence-utils.js'
import {
  loopObligationsFromResponseEvaluation,
  planLoopObligations,
  userSafeObligationFailureSummary,
  type AgentLoopObligation,
  type AgentLoopObligationPlan,
} from './loop-obligations.js'

export type AgentLoopObligationStatus =
  | 'open'
  | 'satisfied'
  | 'invalid'
  | 'blocked'
  | 'cancelled'

export type AgentLoopObligationSource =
  | 'goal_contract'
  | 'response_evaluator'
  | 'provider_tool_intent'
  | 'policy'
  | 'human_interrupt'

export type AgentLoopLedgerObligation = AgentLoopObligation & {
  status: AgentLoopObligationStatus
  source: AgentLoopObligationSource
  createdAtIteration: number
  closedAtIteration?: number
  evidenceIds: string[]
  invalidReasons: string[]
}

export type AgentLoopObligationLedger = {
  schemaVersion: 'xox.loop_obligation_ledger.v1'
  runId: string
  obligations: AgentLoopLedgerObligation[]
}

export type AgentLoopObligationLedgerProjection = {
  schemaVersion: AgentLoopObligationLedger['schemaVersion']
  runId: string
  openCount: number
  satisfiedCount: number
  invalidCount: number
  blockedCount: number
  obligations: Array<{
    id: string
    kind: AgentLoopLedgerObligation['kind']
    status: AgentLoopObligationStatus
    source: AgentLoopObligationSource
    reason: string
    toolNames: string[]
    requiredDataScopes?: string[]
    requiredMetrics?: string[]
    evidenceIds: string[]
    invalidReasons: string[]
  }>
}

export function initializeObligationLedger(input: { runId: string }): AgentLoopObligationLedger {
  return {
    schemaVersion: 'xox.loop_obligation_ledger.v1',
    runId: input.runId,
    obligations: [],
  }
}

function stableObligationKey(obligation: AgentLoopObligation) {
  return [
    obligation.kind,
    obligation.authority ?? '',
    obligation.subject ?? '',
    obligation.toolNames.slice().sort().join(','),
  ].join(':')
}

function parseObservationContent(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return { text: value }
  }
}

function isActive(status: AgentLoopObligationStatus) {
  return status === 'open' || status === 'invalid'
}

function activateFromEvaluation(input: {
  ledger: AgentLoopObligationLedger
  obligations: AgentLoopObligation[]
  iteration: number
}) {
  for (const obligation of input.obligations) {
    const existing = input.ledger.obligations.find((item) =>
      stableObligationKey(item) === stableObligationKey(obligation))
    if (existing) {
      if (existing.status === 'satisfied' || existing.status === 'cancelled') continue
      existing.status = 'open'
      existing.reason = obligation.reason
      existing.findingCodes = obligation.findingCodes
      existing.toolNames = obligation.toolNames
      existing.capabilities = obligation.capabilities
      existing.goalFacts = obligation.goalFacts
      existing.invalidReasons = []
      if (obligation.requiredDataScopes) existing.requiredDataScopes = obligation.requiredDataScopes
      else delete existing.requiredDataScopes
      if (obligation.requiredMetrics) existing.requiredMetrics = obligation.requiredMetrics
      else delete existing.requiredMetrics
      continue
    }
    input.ledger.obligations.push({
      ...obligation,
      status: 'open',
      source: 'response_evaluator',
      createdAtIteration: input.iteration,
      evidenceIds: [],
      invalidReasons: [],
    })
  }
}

function closeFinalAnswerObligation(input: { ledger: AgentLoopObligationLedger; iteration: number }) {
  for (const obligation of input.ledger.obligations) {
    if (obligation.kind !== 'assistant_final_answer' || !isActive(obligation.status)) continue
    obligation.status = 'satisfied'
    obligation.closedAtIteration = input.iteration
    obligation.invalidReasons = []
  }
}

export function applyResponseEvaluationToLedger(input: {
  ledger: AgentLoopObligationLedger
  evaluation: ResponseEvaluation
  iteration: number
}) {
  if (input.evaluation.status === 'pass') {
    closeFinalAnswerObligation(input)
    return
  }
  activateFromEvaluation({
    ledger: input.ledger,
    obligations: loopObligationsFromResponseEvaluation(input.evaluation),
    iteration: input.iteration,
  })
}

function observationEvidenceId(observation: AgentToolObservation) {
  return observation.toolCallId ?? `${observation.toolName}:observation`
}

function recordSatisfied(input: {
  obligation: AgentLoopLedgerObligation
  observation: AgentToolObservation
  iteration: number
}) {
  input.obligation.status = 'satisfied'
  input.obligation.closedAtIteration = input.iteration
  input.obligation.invalidReasons = []
  input.obligation.evidenceIds = [...new Set([...input.obligation.evidenceIds, observationEvidenceId(input.observation)])]
}

function recordInvalid(input: {
  obligation: AgentLoopLedgerObligation
  observation: AgentToolObservation
  reason: string
}) {
  input.obligation.status = 'invalid'
  input.obligation.evidenceIds = [...new Set([...input.obligation.evidenceIds, observationEvidenceId(input.observation)])]
  input.obligation.invalidReasons = [...new Set([...input.obligation.invalidReasons, input.reason])]
}

function applySandboxObservation(input: {
  obligation: AgentLoopLedgerObligation
  observation: AgentToolObservation
  iteration: number
}) {
  if (input.observation.toolName !== 'sandbox_run_code') return
  const facts = parseObservationContent(input.observation.modelContent)
  if (input.observation.status !== 'completed') {
    recordInvalid({ ...input, reason: `sandbox_${input.observation.status}` })
    return
  }
  if (!isExecutedSandboxEvidenceFacts(facts)) {
    recordInvalid({ ...input, reason: 'sandbox_evidence_invalid' })
    return
  }
  recordSatisfied(input)
}

function applyDomainObservation(input: {
  obligation: AgentLoopLedgerObligation
  observation: AgentToolObservation
  iteration: number
}) {
  if (input.observation.toolName !== 'data_query_workspace') return
  const facts = parseObservationContent(input.observation.modelContent)
  if (input.observation.status !== 'completed') {
    recordInvalid({ ...input, reason: `domain_read_${input.observation.status}` })
    return
  }
  if (input.obligation.subject === 'shareholder') {
    if (objectHasKey(facts, 'firstShareholder') || objectHasKey(facts, 'shareholders')) {
      recordSatisfied(input)
      return
    }
    recordInvalid({ ...input, reason: 'ordered_shareholder_facts_missing' })
    return
  }
  recordSatisfied(input)
}

export function applyObservationToLedger(input: {
  ledger: AgentLoopObligationLedger
  observation: AgentToolObservation
  iteration: number
}) {
  if (input.observation.synthetic === true || input.observation.lane === 'runner_evidence') return
  for (const obligation of input.ledger.obligations) {
    if (!isActive(obligation.status)) continue
    if (obligation.kind === 'sandbox_calculation') {
      applySandboxObservation({ obligation, observation: input.observation, iteration: input.iteration })
    } else if (obligation.kind === 'domain_fact') {
      applyDomainObservation({ obligation, observation: input.observation, iteration: input.iteration })
    }
  }
}

export function activeLedgerObligations(ledger: AgentLoopObligationLedger) {
  return ledger.obligations.filter((obligation) => isActive(obligation.status))
}

export function hasOpenNonFinalAnswerObligations(ledger: AgentLoopObligationLedger) {
  return activeLedgerObligations(ledger).some((obligation) => obligation.kind !== 'assistant_final_answer')
}

export function canAttemptFinalAnswer(ledger: AgentLoopObligationLedger) {
  return !hasOpenNonFinalAnswerObligations(ledger)
}

export function ledgerToObligationPlan(input: {
  ledger: AgentLoopObligationLedger
  objective: string
}): AgentLoopObligationPlan | null {
  return planLoopObligations({
    objective: input.objective,
    obligations: activeLedgerObligations(input.ledger),
  })
}

export function userSafeLedgerFailureSummary(input: {
  ledger: AgentLoopObligationLedger
  objective: string
}) {
  return userSafeObligationFailureSummary(ledgerToObligationPlan(input))
}

export function serializeObligationLedger(ledger: AgentLoopObligationLedger): AgentLoopObligationLedgerProjection {
  const open = activeLedgerObligations(ledger)
  return {
    schemaVersion: ledger.schemaVersion,
    runId: ledger.runId,
    openCount: open.length,
    satisfiedCount: ledger.obligations.filter((obligation) => obligation.status === 'satisfied').length,
    invalidCount: ledger.obligations.filter((obligation) => obligation.status === 'invalid').length,
    blockedCount: ledger.obligations.filter((obligation) => obligation.status === 'blocked').length,
    obligations: ledger.obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
      source: obligation.source,
      reason: obligation.reason,
      toolNames: obligation.toolNames,
      ...(obligation.requiredDataScopes ? { requiredDataScopes: obligation.requiredDataScopes } : {}),
      ...(obligation.requiredMetrics ? { requiredMetrics: obligation.requiredMetrics } : {}),
      evidenceIds: obligation.evidenceIds,
      invalidReasons: obligation.invalidReasons,
    })),
  }
}
