import type {
  AgentEvidenceAuthority as OsAgentEvidenceAuthority,
  AgentEvidenceRecord as OsAgentEvidenceRecord,
  AgentEvidenceRequirement as OsAgentEvidenceRequirement,
  AgentEvidenceSubject as OsAgentEvidenceSubject,
  AgentEvidenceValidity as OsAgentEvidenceValidity,
  AgentFinalAnswerClaim as OsAgentFinalAnswerClaim,
  AgentLoopLedgerObligation as OsAgentLoopLedgerObligation,
  AgentLoopObligation as OsAgentLoopObligation,
  AgentLoopObligationLedger as OsAgentLoopObligationLedger,
  AgentLoopObligationLedgerProjection as OsAgentLoopObligationLedgerProjection,
  AgentLoopObligationPlan as OsAgentLoopObligationPlan,
  AgentObservation as OsAgentObservation,
  AgentRunRecord as OsAgentRunRecord,
  JsonObject as OsJsonObject,
  JsonValue as OsJsonValue,
} from '@agentic-os/contracts'
import type { AgentGoalContract, AgentGoalFacts } from '@xox/contracts'
import {
  activateObligations,
  activeLedgerObligations as osActiveLedgerObligations,
  applyFinalPassToObligationLedger,
  applyObservationToObligationLedger as applyOsObservationToObligationLedger,
  buildEvidenceLedger as buildOsEvidenceLedger,
  canAttemptFinalAnswer as osCanAttemptFinalAnswer,
  evaluateAgentFinalResponseReview,
  evidenceFactsContainKey,
  evidenceRequirementsFromFinalAnswerClaims,
  initializeObligationLedger as initializeOsObligationLedger,
  ledgerToObligationPlan as osLedgerToObligationPlan,
  projectObligationLedger,
  projectObligationLedgerWithAdditionalObligations,
  projectObligationStateWithAdditionalObligations,
  type AdditionalObligationProjectionInput,
  type AgentFinalResponseEvaluation,
  type AgentFinalResponseEvaluationStatus,
  type AgentFinalResponseFinding,
  type AgentFinalResponseRequiredEvidence,
  type ObligationObservationEvaluator,
} from '@agentic-os/core'
import type { Row } from '../../db/schema.js'
import { parseJson } from '../../db/database.js'
import type { AgentToolCapability } from '../tool-catalog.js'
import { mergeAgentGoalFacts } from '../runtime-goal-facts.js'
import type { AgentToolObservation } from './xox-tool-observation-adapter.js'
import { agenticOsObservationFromXox } from './xox-observation-adapter.js'

export type AgentEvidenceAuthority = Extract<OsAgentEvidenceAuthority, 'ambient' | 'domain_read' | 'sandbox' | 'action' | 'memory'>
export type AgentEvidenceValidity = OsAgentEvidenceValidity

export type AgentEvidenceSource =
  | 'ambient_context'
  | 'data_query_workspace'
  | 'sandbox_run_code'
  | 'agent_action_runtime'
  | 'memory_recall'

export type AgentEvidenceSubject = {
  type: 'workspace' | 'shareholder' | 'member' | 'ledger_entry' | 'forecast' | 'calculation' | 'action'
  id?: string | null
  label?: string | null
}

export type AgentEvidenceItem = {
  id: string
  runId: string
  threadId: string
  authority: AgentEvidenceAuthority
  validity: AgentEvidenceValidity
  source: AgentEvidenceSource
  toolCallId?: string | null
  observationId?: string | null
  subject?: AgentEvidenceSubject
  facts: Record<string, unknown>
  invalidReasons?: string[]
  summary?: string
  createdAt: string
}

export type AgentFinalAnswerClaim = Omit<OsAgentFinalAnswerClaim, 'subject'> & {
  subject?: AgentEvidenceSubject['type'] | AgentEvidenceSubject
}

export type AgentEvidenceRequirement = {
  authority: AgentEvidenceAuthority
  subject?: AgentEvidenceSubject['type']
  reason: string
  source: 'goal_facts' | 'trajectory' | 'final_answer_claim'
}

export type ResponseEvaluationStatus = AgentFinalResponseEvaluationStatus
export type ResponseEvaluationFinding = AgentFinalResponseFinding
export type ResponseRequiredEvidence = AgentFinalResponseRequiredEvidence & {
  authority: AgentEvidenceAuthority
  subject?: string
}
export type ResponseEvaluation = AgentFinalResponseEvaluation<ResponseRequiredEvidence>

export type AgentLoopObligationKind =
  | 'assistant_final_answer'
  | 'sandbox_calculation'
  | 'domain_fact'

export type AgentLoopObligationLedger = OsAgentLoopObligationLedger
export type AgentLoopLedgerObligation = OsAgentLoopLedgerObligation

export type AgentLoopObligationPlan = {
  schemaVersion: 'xox.loop_obligation_plan.v1'
  objective: string
  obligations: OsAgentLoopLedgerObligation[]
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

export type AgentLoopObligationLedgerProjection = {
  schemaVersion: 'xox.loop_obligation_ledger.v1'
  runId: string
  openCount: number
  satisfiedCount: number
  invalidCount: number
  blockedCount: number
  obligations: Array<{
    id: string
    kind: AgentLoopObligationKind
    status: OsAgentLoopLedgerObligation['status']
    source: 'goal_contract' | 'response_evaluator' | 'provider_tool_intent' | 'policy' | 'human_interrupt'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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

function compactJsonObject(value: unknown): OsJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as OsJsonObject
}

function compactJsonValue(value: unknown): OsJsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as OsJsonValue
}

function metadataStringArray(metadata: OsJsonObject | undefined, key: string): string[] | undefined {
  const value = metadataValue(metadata, key)
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return values.length > 0 ? values : undefined
}

function metadataRecord(metadata: OsJsonObject | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadataValue(metadata, key)
  return isRecord(value) ? value : undefined
}

function metadataString(metadata: OsJsonObject | undefined, key: string): string | undefined {
  if (metadata === undefined) return undefined
  const direct = metadata[key]
  if (typeof direct === 'string' && direct.trim().length > 0) return direct
  const host = metadata.host
  const hostValue = isRecord(host) ? host[key] : undefined
  return typeof hostValue === 'string' && hostValue.trim().length > 0 ? hostValue : undefined
}

function metadataValue(metadata: OsJsonObject | undefined, key: string): unknown {
  if (metadata === undefined) return undefined
  if (metadata[key] !== undefined) return metadata[key]
  const host = metadata.host
  return isRecord(host) ? host[key] : undefined
}

function goalFactsFromMetadata(metadata: OsJsonObject | undefined): AgentGoalFacts {
  const value = metadataRecord(metadata, 'goalFacts')
  return value ? value as AgentGoalFacts : {}
}

function osRunRecord(input: {
  threadId: string
  runId: string
  now?: string
}): OsAgentRunRecord {
  return {
    runId: input.runId,
    threadId: input.threadId,
    scope: {
      tenantId: 'xox-model',
      workspaceId: 'xox-model',
      userId: 'xox-model',
    },
    status: 'running',
    createdAt: input.now ?? new Date().toISOString(),
  }
}

function xoxObservationFromOsObservation(observation: OsAgentObservation): AgentToolObservation | null {
  const content = observation.content
  if (!isRecord(content)) return null
  const maybeXox = content.xoxObservation
  return isRecord(maybeXox) ? maybeXox as AgentToolObservation : null
}

export function isExecutedSandboxEvidenceFacts(facts: Record<string, unknown>) {
  const invalid = sandboxInvalidReasons(facts)
  return isSandboxObservationFacts(facts) &&
    facts.executionMode === 'executed' &&
    facts.status === 'completed' &&
    facts.exitCode === 0 &&
    facts.manifestScoped === true &&
    hasReadableSandboxOutput(facts) &&
    invalid.length === 0
}

function isSandboxObservationFacts(facts: Record<string, unknown>) {
  return facts.observationType === 'sandbox_execution'
}

function nonEmptyStringField(facts: Record<string, unknown>, key: string) {
  const value = facts[key]
  return typeof value === 'string' && value.trim().length > 0
}

function extractionHasParsedOutput(facts: Record<string, unknown>) {
  const extraction = facts.extraction
  if (!isRecord(extraction)) return false
  return extraction.extractionStatus === 'parsed' && extraction.parsedOutput !== null && extraction.parsedOutput !== undefined
}

function hasReadableSandboxOutput(facts: Record<string, unknown>) {
  return nonEmptyStringField(facts, 'outputText') ||
    nonEmptyStringField(facts, 'stdout') ||
    extractionHasParsedOutput(facts) ||
    (Array.isArray(facts.artifacts) && facts.artifacts.length > 0)
}

function sandboxInvalidReasons(facts: Record<string, unknown>) {
  const reasons: string[] = []
  if (!isSandboxObservationFacts(facts)) reasons.push('sandbox_observation_missing')
  if (facts.executionMode !== 'executed') reasons.push('sandbox_not_executed')
  if (facts.status !== 'completed') reasons.push('sandbox_not_completed')
  if (facts.exitCode !== 0) reasons.push('sandbox_exit_not_zero')
  if (facts.manifestScoped !== true) reasons.push('sandbox_not_manifest_scoped')
  if (!hasReadableSandboxOutput(facts)) reasons.push('sandbox_output_missing')
  const proof = isRecord(facts.evidenceProof) ? facts.evidenceProof : null
  if (!proof) {
    reasons.push('sandbox_proof_missing')
    return reasons
  }
  const manifest = isRecord(proof.manifest) ? proof.manifest : null
  if (!manifest?.consumed) reasons.push('sandbox_manifest_not_consumed')
  const sdkCalls = Array.isArray(proof.sdkCalls) ? proof.sdkCalls : []
  const completedSdkCalls = sdkCalls.filter((call) =>
    isRecord(call) && call.status === 'completed' && typeof call.observationId === 'string' && call.observationId.trim().length > 0)
  const sourceRefs = Array.isArray(proof.sourceObservationRefs)
    ? proof.sourceObservationRefs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const scope = isRecord(facts.dataBundleSummary) && typeof facts.dataBundleSummary.scope === 'string'
    ? facts.dataBundleSummary.scope
    : null
  const needsToolAnchoredDomainRead = scope === 'workspace_summary' ||
    scope === 'forecast_months' ||
    scope === 'entity_summary' ||
    scope === 'ledger_entries'
  if (needsToolAnchoredDomainRead && completedSdkCalls.length === 0) {
    reasons.push('sandbox_sdk_observation_missing')
  }
  if (sourceRefs.length === 0) reasons.push('sandbox_source_observation_missing')
  if (typeof proof.codeHash !== 'string' || !proof.codeHash.trim()) reasons.push('sandbox_code_hash_missing')
  if (typeof proof.outputHash !== 'string' || !proof.outputHash.trim()) reasons.push('sandbox_output_hash_missing')
  return reasons
}

function observationAuthority(observation: AgentToolObservation, facts: Record<string, unknown>): AgentEvidenceAuthority {
  if (observation.toolName === 'sandbox_run_code') return 'sandbox'
  if (isExecutedSandboxEvidenceFacts(facts)) return 'sandbox'
  if (facts.observationType === 'action_result' || facts.observationType === 'action_preview') return 'action'
  if (observation.toolName === 'memory_search' || observation.toolName === 'memory_remember') return 'memory'
  return 'domain_read'
}

function observationSource(observation: AgentToolObservation, authority: AgentEvidenceAuthority): AgentEvidenceSource {
  if (authority === 'sandbox') return 'sandbox_run_code'
  if (authority === 'action') return 'agent_action_runtime'
  if (authority === 'memory') return 'memory_recall'
  if (observation.toolName === 'sandbox_run_code') return 'sandbox_run_code'
  if (observation.toolName === 'data_query_workspace') return 'data_query_workspace'
  return 'data_query_workspace'
}

function evidenceValidity(
  observation: AgentToolObservation,
  authority: AgentEvidenceAuthority,
  facts: Record<string, unknown>,
): AgentEvidenceValidity {
  if (authority === 'sandbox') return isExecutedSandboxEvidenceFacts(facts) ? 'valid' : 'invalid'
  if (
    observation.status === 'failed' ||
    observation.status === 'cancelled' ||
    observation.status === 'not_executed' ||
    observation.status === 'invalid'
  ) return 'invalid'
  return 'valid'
}

function evidenceSubject(facts: Record<string, unknown>, authority: AgentEvidenceAuthority): OsAgentEvidenceSubject | undefined {
  if (authority === 'sandbox') return { type: 'calculation', label: typeof facts.purpose === 'string' ? facts.purpose : 'sandbox calculation' }
  if (authority === 'action') {
    const label = typeof facts.title === 'string' ? facts.title : typeof facts.actionKind === 'string' ? facts.actionKind : undefined
    return { type: 'action', ...(label ? { label } : {}) }
  }
  const scope = typeof facts.scope === 'string' ? facts.scope : null
  if (scope === 'team_summary') return { type: 'member', label: 'team summary' }
  if (scope === 'entity_summary' && evidenceFactsContainKey(facts, 'shareholders')) return { type: 'shareholder', label: 'entity summary' }
  if (scope === 'entity_summary') return { type: 'workspace', label: 'entity summary' }
  if (scope === 'ledger_history') return { type: 'ledger_entry', label: 'ledger history' }
  return { type: 'forecast', label: scope ?? 'workspace facts' }
}

function evidenceSummary(observation: AgentToolObservation, facts: Record<string, unknown>) {
  if (typeof facts.scope === 'string') return `${observation.toolName}:${facts.scope}`
  if (typeof facts.observationType === 'string') return `${observation.toolName}:${facts.observationType}`
  return observation.title || observation.toolName
}

function classifyXoxObservation(observation: OsAgentObservation) {
  const xoxObservation = xoxObservationFromOsObservation(observation)
  if (!xoxObservation) return undefined
  if (xoxObservation.synthetic === true && xoxObservation.lane === 'runner_evidence') {
    return { include: false }
  }
  const facts = parseObservationContent(xoxObservation.modelContent)
  const authority = observationAuthority(xoxObservation, facts)
  const validity = evidenceValidity(xoxObservation, authority, facts)
  const subject = evidenceSubject(facts, authority)
  return {
    authority,
    validity,
    source: observationSource(xoxObservation, authority),
    facts: compactJsonObject(facts),
    ...(subject ? { subject } : {}),
    invalidReasons: validity === 'invalid' && authority === 'sandbox' ? sandboxInvalidReasons(facts) : [],
    summary: evidenceSummary(xoxObservation, facts),
  }
}

function xoxEvidenceFromOsRecord(record: OsAgentEvidenceRecord): AgentEvidenceItem {
  const item: AgentEvidenceItem = {
    id: record.evidenceId,
    runId: record.runId,
    threadId: record.threadId,
    authority: record.authority as AgentEvidenceAuthority,
    validity: record.validity,
    source: record.source as AgentEvidenceSource,
    facts: record.facts,
    createdAt: record.createdAt,
  }
  if (record.toolCallId !== undefined) item.toolCallId = record.toolCallId
  if (record.observationId !== undefined) item.observationId = record.observationId
  if (record.subject !== undefined) item.subject = record.subject as AgentEvidenceSubject
  if (record.invalidReasons !== undefined) item.invalidReasons = record.invalidReasons
  if (record.summary !== undefined) item.summary = record.summary
  return item
}

function osRecordFromXoxEvidence(item: AgentEvidenceItem): OsAgentEvidenceRecord {
  const record: OsAgentEvidenceRecord = {
    evidenceId: item.id,
    runId: item.runId,
    threadId: item.threadId,
    authority: item.authority,
    validity: item.validity,
    source: item.source,
    toolName: item.source,
    facts: compactJsonObject(item.facts),
    createdAt: item.createdAt,
  }
  if (item.toolCallId !== undefined && item.toolCallId !== null) record.toolCallId = item.toolCallId
  if (item.observationId !== undefined && item.observationId !== null) record.observationId = item.observationId
  if (item.subject !== undefined) record.subject = item.subject
  if (item.invalidReasons !== undefined) record.invalidReasons = item.invalidReasons
  if (item.summary !== undefined) record.summary = item.summary
  return record
}

export function buildEvidenceLedger(input: {
  threadId: string
  runId: string
  observations: AgentToolObservation[]
  now?: string
}) {
  return buildOsEvidenceLedger({
    run: osRunRecord(input),
    observations: input.observations.map(agenticOsObservationFromXox),
    classifyObservation: ({ observation }) => classifyXoxObservation(observation),
    ...(input.now ? { clock: () => new Date(input.now!) } : {}),
  }).map(xoxEvidenceFromOsRecord)
}

export function evidenceContainsKey(items: AgentEvidenceItem[], key: string) {
  return items.some((item) => evidenceFactsContainKey(item.facts, key))
}

export function evidenceForModel(items: AgentEvidenceItem[]) {
  return items.map((item) => ({
    id: item.id,
    authority: item.authority,
    validity: item.validity,
    source: item.source,
    subject: item.subject,
    summary: item.summary,
    invalidReasons: item.invalidReasons,
    facts: item.facts,
  }))
}

export function buildEvidenceRequirements(input: {
  facts: AgentGoalFacts
  evidence: AgentEvidenceItem[]
  finalAnswerClaims?: AgentFinalAnswerClaim[]
}): AgentEvidenceRequirement[] {
  const requirements: AgentEvidenceRequirement[] = []
  const claims = input.finalAnswerClaims ?? []
  const claimRequirements = xoxEvidenceRequirementsFromFinalAnswerClaims(claims)
  const hasSandboxTrajectory = input.evidence.some((item) => item.authority === 'sandbox' || item.source === 'sandbox_run_code')
  const calculationClaimRequirement = claimRequirements.find((requirement) =>
    requirement.authority === 'sandbox' && requirement.subject === 'calculation')
  if (input.facts.requiresSandboxComputation) {
    requirements.push({
      authority: 'sandbox',
      subject: 'calculation',
      reason: '目标契约要求可复核的派生计算。',
      source: 'goal_facts',
    })
  } else if (hasSandboxTrajectory) {
    requirements.push({
      authority: 'sandbox',
      subject: 'calculation',
      reason: '本轮轨迹已调用 sandbox_run_code，最终回答必须基于有效沙箱 observation。',
      source: 'trajectory',
    })
  } else if (calculationClaimRequirement) {
    requirements.push({
      authority: 'sandbox',
      subject: 'calculation',
      reason: calculationClaimRequirement.reason,
      source: 'final_answer_claim',
    })
  }

  const shareholderClaimRequirement = claimRequirements.find((requirement) =>
    requirement.authority === 'domain_read' && requirement.subject === 'shareholder')
  if (input.facts.requiresOrderedEntityFacts) {
    requirements.push({
      authority: 'domain_read',
      subject: 'shareholder',
      reason: '目标契约要求有序实体事实。',
      source: 'goal_facts',
    })
  } else if (shareholderClaimRequirement) {
    requirements.push({
      authority: 'domain_read',
      subject: 'shareholder',
      reason: shareholderClaimRequirement.reason,
      source: 'final_answer_claim',
    })
  }

  return requirements
}

function xoxEvidenceRequirementsFromFinalAnswerClaims(
  claims: AgentFinalAnswerClaim[],
): AgentEvidenceRequirement[] {
  return evidenceRequirementsFromFinalAnswerClaims({
    claims: claims.map(osClaimFromXoxClaim),
  }).flatMap((requirement): AgentEvidenceRequirement[] => {
    if (requirement.authority === 'sandbox' && requirement.subject?.type === 'calculation') {
      return [{
        authority: 'sandbox',
        subject: 'calculation',
        reason: requirement.reason,
        source: 'final_answer_claim',
      }]
    }
    if (requirement.authority === 'domain_read' && requirement.subject?.type === 'shareholder') {
      return [{
        authority: 'domain_read',
        subject: 'shareholder',
        reason: requirement.reason,
        source: 'final_answer_claim',
      }]
    }
    return []
  })
}

function osClaimFromXoxClaim(claim: AgentFinalAnswerClaim): OsAgentFinalAnswerClaim {
  const { subject: _subject, ...claimWithoutSubject } = claim
  const subject = claimSubject(claim)
  return {
    ...claimWithoutSubject,
    ...(subject ? { subject } : {}),
  }
}

function claimSubject(claim: AgentFinalAnswerClaim): OsAgentFinalAnswerClaim['subject'] | undefined {
  if (!claim.subject) {
    return claim.kind === 'entity_specific' || claim.kind === 'domain_fact'
      ? { type: 'shareholder' }
      : undefined
  }
  if (typeof claim.subject === 'string') {
    return { type: claim.subject }
  }
  return claim.subject
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

function sandboxEvidenceItems(evidence: AgentEvidenceItem[]) {
  return evidence.filter((item) => item.authority === 'sandbox' || item.source === 'sandbox_run_code')
}

function invalidSandboxEvidenceItems(evidence: AgentEvidenceItem[]) {
  return sandboxEvidenceItems(evidence).filter((item) =>
    item.validity !== 'valid' ||
    !isExecutedSandboxEvidenceFacts(item.facts))
}

function hasCompletedSandboxEvidence(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) =>
    item.authority === 'sandbox' &&
    item.validity === 'valid' &&
    isExecutedSandboxEvidenceFacts(item.facts))
}

function hasOrderedShareholderDomainEvidence(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) =>
    item.authority === 'domain_read' &&
    item.validity === 'valid' &&
    item.source === 'data_query_workspace' &&
    (evidenceFactsContainKey(item.facts, 'firstShareholder') || evidenceFactsContainKey(item.facts, 'shareholders')))
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
  const evidenceRequirements = buildEvidenceRequirements({
    facts,
    evidence: input.evidence,
    finalAnswerClaims: input.finalAnswerClaims ?? [],
  })
  const requiredEvidence = responseRequiredEvidence(evidenceRequirements)
  const evidenceRecords = input.evidence.map(osRecordFromXoxEvidence)
  return evaluateAgentFinalResponseReview<ResponseRequiredEvidence>({
    finalAssistantText: input.finalAssistantText,
    observationCount: input.observations.length,
    evidenceRecords,
    evidenceRequirements: osEvidenceRequirementsFromXoxRequirements(evidenceRequirements),
    requiredEvidence,
    missingFinalAnswerRequiredEvidence: [{
      authority: 'domain_read',
      reason: '工具 observation 已产生，但还没有模型最终回答。',
    }],
    ...(input.pendingActionCount !== undefined ? { pendingActionCount: input.pendingActionCount } : {}),
    ...(input.awaitingClarification !== undefined ? { awaitingClarification: input.awaitingClarification } : {}),
    finalAnswerObligation: {
      obligationId: 'loop_obligation_assistant_final_answer',
      reason: '工具 observation 已产生，但还没有模型最终回答。',
      metadata: xoxObligationMetadata({
        xoxKind: 'assistant_final_answer',
        findingCodes: ['response.final_answer_missing'],
        goalFacts: {},
      }),
    },
    awaitingConfirmation: {
      severity: 'info',
      code: 'response.pending_confirmation_interrupt',
      message: '运行图中仍有待确认动作，不能把说明文字判定为目标完成。',
      confidence: 0.99,
      nextPlannerBrief: null,
    },
    awaitingClarificationCopy: {
      severity: 'info',
      code: 'response.pending_clarification_interrupt',
      message: '运行图中仍有待澄清问题，不能把说明文字判定为目标完成。',
      confidence: 0.99,
      nextPlannerBrief: null,
    },
    missingFinalAnswer: {
      severity: 'fail',
      code: 'response.final_answer_missing',
      message: '工具结果只能作为 observation，不能替代面向用户的 assistant final answer。',
      confidence: 0.99,
      nextPlannerBrief: '基于已经取得的 observation 生成最终回答；不要把工具返回原文当成最终回答。',
    },
    providerProtocolArtifact: ({ artifactFormat }) => ({
      severity: 'fail',
      code: 'response.provider_tool_call_text_not_final',
      message: `Provider 返回了 ${artifactFormat} 工具调用协议文本，不能作为面向用户的最终回答。`,
      confidence: 0.99,
      nextPlannerBrief: '上一轮 provider 把工具调用协议片段放进 assistant content。不要把它当最终回答；如果还需要工具，必须通过结构化 tool_calls 继续，否则基于已取得 observation 输出自然语言最终回答。',
    }),
    emptyFinalAnswer: {
      severity: 'fail',
      code: 'response.empty_final_answer',
      message: '没有可展示的最终回答。',
      confidence: 0.98,
      nextPlannerBrief: '生成一个面向用户的最终回答。',
    },
    buildEvidenceFailureEvaluation: () => xoxEvidenceFailureEvaluation({
      evidence: input.evidence,
      requiredEvidence,
      evidenceRequirements,
    }),
    buildPassEvaluation: (): ResponseEvaluation => {
      return {
        status: 'pass',
        confidence: input.evidence.some((item) => item.authority === 'sandbox') ? 0.94 : 0.9,
        requiredEvidence,
        findings: [{
          severity: 'info',
          code: 'response.evidence_accepted',
          evidenceIds: input.evidence.filter((item) => item.authority !== 'memory').map((item) => item.id),
          message: input.evidence.some((item) => item.authority === 'sandbox')
            ? '最终回答已在 sandbox/domain evidence 之后生成。'
            : '最终回答已在当前 run evidence 之后生成。',
        }],
        nextPlannerBrief: null,
      }
    },
  })
}

function responseRequiredEvidence(evidenceRequirements: AgentEvidenceRequirement[]): ResponseEvaluation['requiredEvidence'] {
  return evidenceRequirements.map((requirement) => ({
    authority: requirement.authority,
    ...(requirement.subject ? { subject: requirement.subject } : {}),
    reason: requirement.reason,
  }))
}

function xoxEvidenceFailureEvaluation(input: {
  evidence: AgentEvidenceItem[]
  requiredEvidence: ResponseEvaluation['requiredEvidence']
  evidenceRequirements: AgentEvidenceRequirement[]
}): ResponseEvaluation {
  const sandboxEvidence = sandboxEvidenceItems(input.evidence)
  const findings: ResponseEvaluationFinding[] = []
  const requiresSandboxEvidence = input.evidenceRequirements.some((requirement) => requirement.authority === 'sandbox')
  const requiresShareholderEvidence = input.evidenceRequirements.some((requirement) =>
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
        requiredEvidence: input.requiredEvidence,
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
      requiredEvidence: input.requiredEvidence,
      findings,
      nextPlannerBrief: '补充包含有序股东信息的工作区事实，再基于该事实生成最终回答。',
    }
  }

  return {
    status: 'needs_more_evidence',
    confidence: 0.9,
    requiredEvidence: input.requiredEvidence,
    findings: [{
      severity: 'fail',
      code: 'response.evidence_missing',
      evidenceIds: input.evidence.map((item) => item.id),
      message: '本轮缺少必要的结构化事实 evidence。',
    }],
    nextPlannerBrief: '补充必要的工作区事实，再基于该事实生成最终回答。',
  }
}

export function initializeObligationLedger(input: { runId: string; threadId?: string }): AgentLoopObligationLedger {
  return initializeOsObligationLedger({
    runId: input.runId,
    threadId: input.threadId ?? input.runId,
  })
}

function xoxObligationMetadata(input: {
  xoxKind: AgentLoopObligationKind
  findingCodes: string[]
  authority?: AgentEvidenceAuthority
  subject?: string
  goalFacts?: AgentGoalFacts
  requiredDataScopes?: string[]
  requiredMetrics?: string[]
}): OsJsonObject {
  const metadata: Record<string, OsJsonValue> = {
    xoxKind: input.xoxKind,
    findingCodes: input.findingCodes,
  }
  if (input.authority) metadata.authority = input.authority
  if (input.subject) metadata.subject = input.subject
  if (input.goalFacts) metadata.goalFacts = compactJsonValue(input.goalFacts)
  if (input.requiredDataScopes) metadata.requiredDataScopes = input.requiredDataScopes
  if (input.requiredMetrics) metadata.requiredMetrics = input.requiredMetrics
  return metadata
}

export function loopObligationsFromResponseEvaluation(evaluation: ResponseEvaluation): OsAgentLoopObligation[] {
  return evaluation.obligations ?? []
}

function mergeGoalFacts(values: AgentGoalFacts[]) {
  const merged: AgentGoalFacts = {}
  const forbiddenActions = new Set<NonNullable<AgentGoalFacts['forbiddenActions']>[number]>()
  const requiredActionCapabilities = new Set<NonNullable<AgentGoalFacts['requiredActionCapabilities']>[number]>()
  for (const value of values) {
    if (value.workspaceName) merged.workspaceName = value.workspaceName
    if (value.expectedMemberCount) merged.expectedMemberCount = value.expectedMemberCount
    if (value.expectedShareholderCount) merged.expectedShareholderCount = value.expectedShareholderCount
    if (value.expectedHorizonMonths) merged.expectedHorizonMonths = value.expectedHorizonMonths
    if (value.expectedStartMonth) merged.expectedStartMonth = value.expectedStartMonth
    if (value.requiresForecastSummary) merged.requiresForecastSummary = true
    if (value.requiresSandboxComputation) merged.requiresSandboxComputation = true
    if (value.requiresOrderedEntityFacts) merged.requiresOrderedEntityFacts = true
    for (const capability of value.requiredActionCapabilities ?? []) requiredActionCapabilities.add(capability)
    for (const action of value.forbiddenActions ?? []) forbiddenActions.add(action)
  }
  if (requiredActionCapabilities.size > 0) merged.requiredActionCapabilities = [...requiredActionCapabilities]
  if (forbiddenActions.size > 0) merged.forbiddenActions = [...forbiddenActions]
  return merged
}

function xoxKindFromOsMetadata(
  metadata: OsJsonObject | undefined,
  fallback: AgentLoopObligationKind,
): AgentLoopObligationKind {
  const value = metadataString(metadata, 'xoxKind')
  return value === 'assistant_final_answer' || value === 'sandbox_calculation' || value === 'domain_fact'
    ? value
    : fallback
}

function xoxSourceFromOsSource(source: OsAgentLoopLedgerObligation['source']): AgentLoopObligationLedgerProjection['obligations'][number]['source'] {
  if (source === 'goal_contract') return 'goal_contract'
  if (source === 'policy') return 'policy'
  if (source === 'human_interrupt') return 'human_interrupt'
  if (source === 'completion_evaluator') return 'response_evaluator'
  return 'provider_tool_intent'
}

function xoxPlanFromOsPlan(input: {
  objective: string
  osPlan: OsAgentLoopObligationPlan
}): AgentLoopObligationPlan {
  const goalFacts = mergeGoalFacts(input.osPlan.obligations.map((obligation) => goalFactsFromMetadata(obligation.metadata)))
  return {
    schemaVersion: 'xox.loop_obligation_plan.v1',
    objective: input.objective,
    obligations: input.osPlan.obligations,
    requiredToolNames: input.osPlan.requiredToolNames,
    selectedCapabilities: input.osPlan.selectedCapabilities as AgentToolCapability[],
    requiredActionCapabilities: [],
    goalFacts,
    modelContext: {
      purpose: input.osPlan.modelContext.purpose,
      obligations: input.osPlan.modelContext.obligations.map((obligation) => {
        const requiredDataScopes = metadataStringArray(obligation.metadata, 'requiredDataScopes')
        const requiredMetrics = metadataStringArray(obligation.metadata, 'requiredMetrics')
        return {
          id: obligation.obligationId,
          kind: xoxKindFromOsMetadata(obligation.metadata, obligation.kind === 'assistant_final_answer' ? 'assistant_final_answer' : 'domain_fact'),
          reason: obligation.reason,
          toolNames: obligation.toolNames,
          ...(requiredDataScopes ? { requiredDataScopes } : {}),
          ...(requiredMetrics ? { requiredMetrics } : {}),
        }
      }),
      instruction: input.osPlan.modelContext.instruction,
    },
  }
}

export function planLoopObligations(input: {
  objective: string
  obligations: OsAgentLoopObligation[]
}): AgentLoopObligationPlan | null {
  if (input.obligations.length === 0) return null
  const ledger = initializeOsObligationLedger({
    runId: 'xox-local-obligation-plan',
    threadId: 'xox-local-obligation-plan',
  })
  activateObligations({
    ledger,
    obligations: input.obligations,
    source: 'completion_evaluator',
    iteration: 0,
  })
  const osPlan = osLedgerToObligationPlan({
    ledger,
    objective: input.objective,
  })
  return osPlan ? xoxPlanFromOsPlan({ objective: input.objective, osPlan }) : null
}

export function applyResponseEvaluationToLedger(input: {
  ledger: AgentLoopObligationLedger
  evaluation: ResponseEvaluation
  iteration: number
}) {
  if (input.evaluation.status === 'pass') {
    applyFinalPassToObligationLedger({
      ledger: input.ledger,
      iteration: input.iteration,
    })
    return
  }
  activateObligations({
    ledger: input.ledger,
    obligations: loopObligationsFromResponseEvaluation(input.evaluation),
    source: 'completion_evaluator',
    iteration: input.iteration,
  })
}

const xoxObligationObservationEvaluator: ObligationObservationEvaluator = ({ obligation, observation }) => {
  const xoxObservation = xoxObservationFromOsObservation(observation)
  if (!xoxObservation) return null
  const xoxKind = xoxKindFromOsMetadata(obligation.metadata, 'domain_fact')
  if (xoxKind === 'sandbox_calculation') {
    if (xoxObservation.toolName !== 'sandbox_run_code') return { status: 'ignored' }
    const facts = parseObservationContent(xoxObservation.modelContent)
    if (xoxObservation.status !== 'completed') return { status: 'invalid', reason: `sandbox_${xoxObservation.status}` }
    if (!isExecutedSandboxEvidenceFacts(facts)) return { status: 'invalid', reason: 'sandbox_evidence_invalid' }
    return { status: 'satisfied' }
  }
  if (xoxKind === 'domain_fact') {
    if (xoxObservation.toolName !== 'data_query_workspace') return { status: 'ignored' }
    const facts = parseObservationContent(xoxObservation.modelContent)
    if (xoxObservation.status !== 'completed') return { status: 'invalid', reason: `domain_read_${xoxObservation.status}` }
    if (metadataString(obligation.metadata, 'subject') === 'shareholder') {
      if (evidenceFactsContainKey(facts, 'firstShareholder') || evidenceFactsContainKey(facts, 'shareholders')) {
        return { status: 'satisfied' }
      }
      return { status: 'invalid', reason: 'ordered_shareholder_facts_missing' }
    }
    return { status: 'satisfied' }
  }
  return null
}

export function applyObservationToLedger(input: {
  ledger: AgentLoopObligationLedger
  observation: AgentToolObservation
  iteration: number
}) {
  if (input.observation.synthetic === true || input.observation.lane === 'runner_evidence') return []
  return applyOsObservationToObligationLedger({
    ledger: input.ledger,
    observation: agenticOsObservationFromXox(input.observation),
    iteration: input.iteration,
    evaluateObservation: xoxObligationObservationEvaluator,
  })
}

export function activeLedgerObligations(ledger: AgentLoopObligationLedger) {
  const activeIds = new Set(osActiveLedgerObligations(ledger).map((obligation) => obligation.obligationId))
  return serializeObligationLedger(ledger).obligations.filter((obligation) => activeIds.has(obligation.id))
}

export function canAttemptFinalAnswer(ledger: AgentLoopObligationLedger) {
  return osCanAttemptFinalAnswer(ledger)
}

export function ledgerToObligationPlan(input: {
  ledger: AgentLoopObligationLedger
  objective: string
}): AgentLoopObligationPlan | null {
  const osPlan = osLedgerToObligationPlan(input)
  return osPlan ? xoxPlanFromOsPlan({ objective: input.objective, osPlan }) : null
}

export function serializeObligationLedger(ledger: AgentLoopObligationLedger): AgentLoopObligationLedgerProjection {
  return xoxProjectionFromOsProjection(projectObligationLedger(ledger))
}

function additionalObligationFromOsObligation(input: {
  obligation: OsAgentLoopObligation
  status?: 'open' | 'invalid'
  invalidReasons?: string[]
}): AdditionalObligationProjectionInput {
  return {
    obligationId: input.obligation.obligationId,
    kind: input.obligation.kind,
    status: input.status ?? 'open',
    source: 'completion_evaluator',
    reason: input.obligation.reason,
    toolNames: input.obligation.toolNames ?? [],
    capabilities: input.obligation.capabilities ?? [],
    requiredOutcomes: input.obligation.requiredOutcomes ?? [],
    ...(input.obligation.metadata ? { metadata: input.obligation.metadata } : {}),
    evidenceIds: [],
    invalidReasons: input.invalidReasons ?? [],
  }
}

function additionalObligationsFromResponseEvaluation(
  evaluation: ResponseEvaluation,
): AdditionalObligationProjectionInput[] {
  return loopObligationsFromResponseEvaluation(evaluation).map((obligation) => {
    const sandboxInvalid = xoxKindFromOsMetadata(obligation.metadata, 'domain_fact') === 'sandbox_calculation' &&
      evaluation.findings.some((finding) => finding.code === 'response.sandbox_evidence_invalid')
    return additionalObligationFromOsObligation({
      obligation,
      status: sandboxInvalid ? 'invalid' : 'open',
      invalidReasons: sandboxInvalid ? ['response_evaluation_invalid'] : [],
    })
  })
}

function xoxProjectionFromOsProjection(
  projection: OsAgentLoopObligationLedgerProjection,
): AgentLoopObligationLedgerProjection {
  return {
    schemaVersion: 'xox.loop_obligation_ledger.v1',
    runId: projection.runId,
    openCount: projection.activeCount,
    satisfiedCount: projection.satisfiedCount,
    invalidCount: projection.invalidCount,
    blockedCount: projection.blockedCount,
    obligations: projection.obligations.map((obligation) => {
      const requiredDataScopes = metadataStringArray(obligation.metadata, 'requiredDataScopes')
      const requiredMetrics = metadataStringArray(obligation.metadata, 'requiredMetrics')
      return {
        id: obligation.obligationId,
        kind: xoxKindFromOsMetadata(obligation.metadata, obligation.kind === 'assistant_final_answer' ? 'assistant_final_answer' : 'domain_fact'),
        status: obligation.status,
        source: xoxSourceFromOsSource(obligation.source),
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
  return xoxProjectionFromOsProjection(projectObligationLedgerWithAdditionalObligations({
    ledger: input.ledger,
    obligations: additionalObligationsFromResponseEvaluation(input.evaluation),
  }))
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function runtimeBoundaryMissingObservationObligations(toolNames: readonly string[]): OsAgentLoopObligation[] {
  if (!toolNames.includes('sandbox_run_code')) return []
  return [{
    obligationId: 'runtime_boundary_sandbox_calculation',
    kind: 'tool_observation',
    reason: 'Provider 已产生 sandbox_run_code 工具意图，但本轮没有形成可执行 sandbox observation。',
    toolNames: ['sandbox_run_code'],
    capabilities: ['sandbox'],
    requiredOutcomes: ['completed_valid'],
    metadata: xoxObligationMetadata({
      xoxKind: 'sandbox_calculation',
      findingCodes: ['response.sandbox_evidence_missing'],
      authority: 'sandbox',
      subject: 'calculation',
      goalFacts: { requiresSandboxComputation: true },
    }),
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
    ledger: input.ledger,
    objective: input.objective,
    obligations: obligations.map((obligation) => additionalObligationFromOsObligation({ obligation })),
  })
  if (state.obligationPlan === null) return null
  const obligationPlan = xoxPlanFromOsPlan({
    objective: input.objective,
    osPlan: state.obligationPlan,
  })
  const requiredGoalFacts: AgentGoalFacts = { requiresSandboxComputation: true }
  const nextPlannerBrief = '继续调用 sandbox_run_code，用当前工作区事实完成可复核计算，再生成最终回答。'
  return {
    toolNames: uniqueStrings(obligations.flatMap((obligation) => obligation.toolNames ?? [])),
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
    obligationLedger: xoxProjectionFromOsProjection(state.obligationLedger),
    obligationPlan,
    nextPlannerBrief,
  }
}

export function osEvidenceRecordsFromXoxEvidence(evidence: AgentEvidenceItem[]): OsAgentEvidenceRecord[] {
  return evidence.map(osRecordFromXoxEvidence)
}

export function osEvidenceFromXoxEvidence(evidence: AgentEvidenceItem[]) {
  return evidence.map((item) => ({
    kind: item.authority,
    label: item.summary ?? item.source,
    value: compactJsonObject({
      id: item.id,
      source: item.source,
      validity: item.validity,
      facts: item.facts,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      ...(item.invalidReasons !== undefined ? { invalidReasons: item.invalidReasons } : {}),
    }),
  }))
}

function osEvidenceRequirementsFromXoxRequirements(
  requirements: AgentEvidenceRequirement[],
): OsAgentEvidenceRequirement[] {
  return requirements.map((requirement, index) =>
    osEvidenceRequirementFromXoxRequirement(requirement, index))
}

function xoxRequirementEvidenceSource(requirement: AgentEvidenceRequirement): AgentEvidenceSource {
  if (requirement.authority === 'sandbox') return 'sandbox_run_code'
  if (requirement.authority === 'domain_read') return 'data_query_workspace'
  if (requirement.authority === 'action') return 'agent_action_runtime'
  if (requirement.authority === 'memory') return 'memory_recall'
  return 'ambient_context'
}

function xoxRequirementObligationId(requirement: AgentEvidenceRequirement, index: number): string {
  if (requirement.authority === 'sandbox') return `loop_obligation_${index + 1}_sandbox_calculation`
  if (requirement.authority === 'domain_read') {
    return `loop_obligation_${index + 1}_${requirement.subject === 'shareholder' ? 'ordered_entity_fact' : 'domain_fact'}`
  }
  return `loop_obligation_${index + 1}_${requirement.authority}`
}

function xoxRequirementFindingCodes(requirement: AgentEvidenceRequirement): string[] {
  if (requirement.authority === 'sandbox') return ['response.sandbox_evidence_missing']
  if (requirement.authority === 'domain_read' && requirement.subject === 'shareholder') {
    return ['response.entity_evidence_missing']
  }
  return ['response.evidence_missing']
}

function xoxRequirementMetadata(
  requirement: AgentEvidenceRequirement,
  index: number,
): OsJsonObject {
  const shareholderFact = requirement.authority === 'domain_read' && requirement.subject === 'shareholder'
  return {
    ...xoxObligationMetadata({
      xoxKind: requirement.authority === 'sandbox' ? 'sandbox_calculation' : 'domain_fact',
      findingCodes: xoxRequirementFindingCodes(requirement),
      authority: requirement.authority,
      ...(requirement.subject ? { subject: requirement.subject } : {}),
      goalFacts: requirement.authority === 'sandbox'
        ? { requiresSandboxComputation: true }
        : shareholderFact
          ? { requiresOrderedEntityFacts: true }
          : {},
      ...(shareholderFact
        ? {
            requiredDataScopes: ['entity_summary'],
            requiredMetrics: ['shareholderNames', 'shareholderInvestments'],
          }
        : {}),
    }),
    obligationId: xoxRequirementObligationId(requirement, index),
    xoxRequirementSource: requirement.source,
  }
}

function xoxRequirementCapabilities(requirement: AgentEvidenceRequirement): string[] {
  if (requirement.authority === 'sandbox') return ['sandbox']
  if (requirement.authority === 'domain_read') return ['data']
  return []
}

function xoxRequirementToolNames(requirement: AgentEvidenceRequirement): string[] {
  if (requirement.authority === 'sandbox') return ['sandbox_run_code']
  if (requirement.authority === 'domain_read') return ['data_query_workspace']
  return []
}

export function osEvidenceRequirementFromXoxRequirement(
  requirement: AgentEvidenceRequirement,
  index = 0,
): OsAgentEvidenceRequirement {
  const osRequirement: OsAgentEvidenceRequirement = {
    requirementId: `${requirement.source}:${requirement.authority}:${requirement.subject ?? 'any'}`,
    reason: requirement.reason,
    authority: requirement.authority,
    source: xoxRequirementEvidenceSource(requirement),
    metadata: xoxRequirementMetadata(requirement, index),
  }
  const toolNames = xoxRequirementToolNames(requirement)
  if (toolNames.length > 0) osRequirement.toolNames = toolNames
  const capabilities = xoxRequirementCapabilities(requirement)
  if (capabilities.length > 0) osRequirement.capabilities = capabilities
  if (requirement.subject !== undefined) {
    osRequirement.subject = { type: requirement.subject }
  }
  return osRequirement
}
