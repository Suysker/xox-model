import type { AgentToolObservation } from './tool-observation-continuation.js'
import type { AgentGoalFacts } from '@xox/contracts'
import type {
  AgentLoopObligationLedger as OsAgentLoopObligationLedger,
  AgentLoopObligationLedgerProjection as OsAgentLoopObligationLedgerProjection,
  AgentLoopObligationSource as OsAgentLoopObligationSource,
  JsonObject,
  JsonValue,
} from '@agentic-os/contracts'
import {
  projectObligationLedger,
  projectObligationStateWithAdditionalObligations,
  projectObligationLedgerWithAdditionalObligations,
  type AdditionalObligationProjectionInput,
} from '@agentic-os/core'
import { isExecutedSandboxEvidenceFacts } from './evidence-ledger.js'
import type { ResponseEvaluation } from './response-evaluator.js'
import { objectHasKey } from './structured-evidence-utils.js'
import {
  loopObligationsFromResponseEvaluation,
  osKindForXoxObligation,
  osMetadataFromXoxObligation,
  planLoopObligations,
  userSafeObligationFailureSummary,
  xoxPlanFromOsPlan,
  type AgentLoopObligation,
  type AgentLoopObligationKind,
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

export type RuntimeBoundaryMissingObservationRepair = {
  toolNames: string[]
  requiredGoalFacts: AgentGoalFacts
  evaluation: ResponseEvaluation
  obligationLedger: AgentLoopObligationLedgerProjection
  obligationPlan: AgentLoopObligationPlan
  nextPlannerBrief: string
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

function osSourceFromXoxSource(source: AgentLoopObligationSource): OsAgentLoopObligationSource {
  if (source === 'goal_contract') return 'goal_contract'
  if (source === 'policy') return 'policy'
  if (source === 'human_interrupt') return 'human_interrupt'
  if (source === 'response_evaluator') return 'completion_evaluator'
  return 'host'
}

function osMetadataFromXoxLedgerObligation(obligation: AgentLoopLedgerObligation): JsonObject {
  const metadata: Record<string, JsonValue> = {
    ...osMetadataFromXoxObligation(obligation),
    xoxStatus: obligation.status,
  }
  if (obligation.goalFacts !== undefined) {
    metadata.goalFacts = JSON.parse(JSON.stringify(obligation.goalFacts)) as JsonValue
  }
  return metadata
}

export function osLedgerFromXoxLedger(ledger: AgentLoopObligationLedger): OsAgentLoopObligationLedger {
  return {
    schemaVersion: 'agentic-os.loop_obligation_ledger.v1',
    runId: ledger.runId,
    threadId: ledger.runId,
    obligations: ledger.obligations.map((obligation) => ({
      obligationId: obligation.id,
      kind: osKindForXoxObligation(obligation.kind),
      reason: obligation.reason,
      toolNames: obligation.toolNames,
      capabilities: obligation.capabilities,
      metadata: osMetadataFromXoxLedgerObligation(obligation),
      status: obligation.status,
      source: osSourceFromXoxSource(obligation.source),
      createdAtIteration: obligation.createdAtIteration,
      ...(obligation.closedAtIteration !== undefined ? { closedAtIteration: obligation.closedAtIteration } : {}),
      evidenceIds: obligation.evidenceIds,
      invalidReasons: obligation.invalidReasons,
    })),
  }
}

export function serializeObligationLedger(ledger: AgentLoopObligationLedger): AgentLoopObligationLedgerProjection {
  const projection = projectObligationLedger(osLedgerFromXoxLedger(ledger))
  return {
    schemaVersion: ledger.schemaVersion,
    runId: ledger.runId,
    openCount: projection.activeCount,
    satisfiedCount: projection.satisfiedCount,
    invalidCount: projection.invalidCount,
    blockedCount: projection.blockedCount,
    obligations: ledger.obligations.map((obligation, index) => ({
      id: projection.obligations[index]?.obligationId ?? obligation.id,
      kind: obligation.kind,
      status: projection.obligations[index]?.status ?? obligation.status,
      source: obligation.source,
      reason: projection.obligations[index]?.reason ?? obligation.reason,
      toolNames: projection.obligations[index]?.toolNames ?? obligation.toolNames,
      ...(obligation.requiredDataScopes ? { requiredDataScopes: obligation.requiredDataScopes } : {}),
      ...(obligation.requiredMetrics ? { requiredMetrics: obligation.requiredMetrics } : {}),
      evidenceIds: projection.obligations[index]?.evidenceIds ?? obligation.evidenceIds,
      invalidReasons: projection.obligations[index]?.invalidReasons ?? obligation.invalidReasons,
    })),
  }
}

function xoxSourceFromOsSource(source: OsAgentLoopObligationSource): AgentLoopObligationSource {
  if (source === 'goal_contract') return 'goal_contract'
  if (source === 'policy') return 'policy'
  if (source === 'human_interrupt') return 'human_interrupt'
  if (source === 'completion_evaluator') return 'response_evaluator'
  return 'provider_tool_intent'
}

function metadataStringArray(metadata: JsonObject | undefined, key: string): string[] | undefined {
  const value = metadata?.[key]
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return values.length > 0 ? values : undefined
}

function xoxKindFromOsMetadata(
  metadata: JsonObject | undefined,
  fallback: AgentLoopObligationKind,
): AgentLoopObligationKind {
  const value = metadata?.xoxKind
  return value === 'assistant_final_answer' || value === 'sandbox_calculation' || value === 'domain_fact'
    ? value
    : fallback
}

function responseEvaluationObligationStatus(input: {
  obligation: AgentLoopObligation
  evaluation: ResponseEvaluation
}) {
  const sandboxInvalid = input.obligation.kind === 'sandbox_calculation' &&
    input.evaluation.findings.some((finding) => finding.code === 'response.sandbox_evidence_invalid')
  return sandboxInvalid ? 'invalid' as const : 'open' as const
}

function additionalObligationFromXoxObligation(input: {
  obligation: AgentLoopObligation
  status?: 'open' | 'invalid'
  invalidReasons?: string[]
}): AdditionalObligationProjectionInput {
  return {
    obligationId: input.obligation.id,
    kind: osKindForXoxObligation(input.obligation.kind),
    status: input.status ?? 'open',
    source: 'completion_evaluator',
    reason: input.obligation.reason,
    toolNames: input.obligation.toolNames,
    capabilities: input.obligation.capabilities,
    metadata: osMetadataFromXoxObligation(input.obligation),
    evidenceIds: [],
    invalidReasons: input.invalidReasons ?? [],
  }
}

function additionalObligationsFromResponseEvaluation(
  evaluation: ResponseEvaluation,
): AdditionalObligationProjectionInput[] {
  return loopObligationsFromResponseEvaluation(evaluation).map((obligation) => {
    const status = responseEvaluationObligationStatus({ obligation, evaluation })
    return additionalObligationFromXoxObligation({
      obligation,
      status,
      invalidReasons: status === 'invalid' ? ['response_evaluation_invalid'] : [],
    })
  })
}

function xoxProjectionFromOsProjection(input: {
  ledger: AgentLoopObligationLedger
  projection: OsAgentLoopObligationLedgerProjection
}): AgentLoopObligationLedgerProjection {
  const originalById = new Map(input.ledger.obligations.map((obligation) => [obligation.id, obligation]))
  return {
    schemaVersion: input.ledger.schemaVersion,
    runId: input.ledger.runId,
    openCount: input.projection.openCount,
    satisfiedCount: input.projection.satisfiedCount,
    invalidCount: input.projection.invalidCount,
    blockedCount: input.projection.blockedCount,
    obligations: input.projection.obligations.map((obligation) => {
      const original = originalById.get(obligation.obligationId)
      const fallbackKind = obligation.kind === 'assistant_final_answer' ? 'assistant_final_answer' : 'domain_fact'
      const requiredDataScopes = original?.requiredDataScopes ??
        metadataStringArray(obligation.metadata, 'requiredDataScopes')
      const requiredMetrics = original?.requiredMetrics ??
        metadataStringArray(obligation.metadata, 'requiredMetrics')
      return {
        id: obligation.obligationId,
        kind: original?.kind ?? xoxKindFromOsMetadata(obligation.metadata, fallbackKind),
        status: obligation.status,
        source: original?.source ?? xoxSourceFromOsSource(obligation.source),
        reason: obligation.reason,
        toolNames: obligation.toolNames,
        ...(requiredDataScopes ? { requiredDataScopes } : {}),
        ...(requiredMetrics ? { requiredMetrics } : {}),
        evidenceIds: obligation.evidenceIds,
        invalidReasons: obligation.invalidReasons,
      }
    }),
  }
}

export function serializeObligationLedgerForResponseEvent(input: {
  ledger: AgentLoopObligationLedger
  evaluation: ResponseEvaluation
}): AgentLoopObligationLedgerProjection {
  const projection = projectObligationLedgerWithAdditionalObligations({
    ledger: osLedgerFromXoxLedger(input.ledger),
    obligations: additionalObligationsFromResponseEvaluation(input.evaluation),
  })
  return xoxProjectionFromOsProjection({
    ledger: input.ledger,
    projection,
  })
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function runtimeBoundaryMissingObservationObligations(toolNames: readonly string[]): AgentLoopObligation[] {
  if (!toolNames.includes('sandbox_run_code')) return []
  return [{
    id: 'runtime_boundary_sandbox_calculation',
    kind: 'sandbox_calculation',
    reason: 'Provider 已产生 sandbox_run_code 工具意图，但本轮没有形成可执行 sandbox observation。',
    findingCodes: ['response.sandbox_evidence_missing'],
    authority: 'sandbox',
    subject: 'calculation',
    toolNames: ['sandbox_run_code'],
    capabilities: ['sandbox'],
    goalFacts: { requiresSandboxComputation: true },
  }]
}

export function runtimeBoundaryMissingObservationRepair(input: {
  ledger: AgentLoopObligationLedger
  objective: string
  toolNames: readonly string[]
}): RuntimeBoundaryMissingObservationRepair | null {
  const toolNames = uniqueStrings(input.toolNames)
  const obligations = runtimeBoundaryMissingObservationObligations(toolNames)
  if (obligations.length === 0) return null
  const state = projectObligationStateWithAdditionalObligations({
    ledger: osLedgerFromXoxLedger(input.ledger),
    objective: input.objective,
    obligations: obligations.map((obligation) => additionalObligationFromXoxObligation({ obligation })),
  })
  if (state.obligationPlan === null) return null
  const sourceById = new Map(
    [...activeLedgerObligations(input.ledger), ...obligations].map((obligation) => [obligation.id, obligation]),
  )
  const planObligations = state.obligationPlan.obligations
    .map((obligation) => sourceById.get(obligation.obligationId))
    .filter((obligation): obligation is AgentLoopObligation => obligation !== undefined)
  const obligationPlan = xoxPlanFromOsPlan({
    objective: input.objective,
    obligations: planObligations,
    osPlan: state.obligationPlan,
  })
  const requiredGoalFacts: AgentGoalFacts = { requiresSandboxComputation: true }
  const nextPlannerBrief = '继续调用 sandbox_run_code，用当前工作区事实完成可复核计算，再生成最终回答。'
  return {
    toolNames: uniqueStrings(obligations.flatMap((obligation) => obligation.toolNames)),
    requiredGoalFacts,
    evaluation: {
      status: 'needs_calculation',
      confidence: 0.96,
      findings: [{
        severity: 'fail',
        code: 'response.sandbox_evidence_missing',
        evidenceIds: [],
        message: 'Provider 已产生 sandbox_run_code 工具意图，但本轮没有形成可执行 sandbox observation。',
      }],
      requiredEvidence: [{
        authority: 'sandbox',
        subject: 'calculation',
        reason: '最终回答依赖派生计算，但本轮还没有完成的 sandbox_run_code evidence。',
      }],
      nextPlannerBrief,
    },
    obligationLedger: xoxProjectionFromOsProjection({
      ledger: input.ledger,
      projection: state.obligationLedger,
    }),
    obligationPlan,
    nextPlannerBrief,
  }
}
