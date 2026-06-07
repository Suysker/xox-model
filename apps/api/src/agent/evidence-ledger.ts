import type { AgentGoalFacts } from '@xox/contracts'
import type { AgentToolObservation } from './tool-observation-continuation.js'

export type AgentEvidenceAuthority = 'ambient' | 'domain_read' | 'sandbox' | 'action' | 'memory'
export type AgentEvidenceValidity = 'valid' | 'invalid'

export type AgentEvidenceSource =
  | 'ambient_context'
  | 'data_query_workspace'
  | 'sandbox_run_code'
  | 'agent_action_runtime'
  | 'memory_recall'

export type AgentEvidenceSubject = {
  type: 'workspace' | 'shareholder' | 'member' | 'ledger_entry' | 'forecast' | 'calculation'
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

export type AgentFinalAnswerClaim = {
  kind: 'derived_calculation' | 'entity_specific'
  subject?: AgentEvidenceSubject['type']
  reason: string
}

export type AgentEvidenceRequirement = {
  authority: AgentEvidenceAuthority
  subject?: AgentEvidenceSubject['type']
  reason: string
  source: 'goal_facts' | 'trajectory' | 'final_answer_claim'
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

export function isExecutedSandboxEvidenceFacts(facts: Record<string, unknown>) {
  return isSandboxObservationFacts(facts) &&
    facts.executionMode === 'executed' &&
    facts.status === 'completed' &&
    facts.exitCode === 0 &&
    facts.manifestScoped === true &&
    hasReadableSandboxOutput(facts)
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
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return false
  const record = extraction as Record<string, unknown>
  return record.extractionStatus === 'parsed' && record.parsedOutput !== null && record.parsedOutput !== undefined
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
  return reasons.length > 0 ? reasons : ['sandbox_evidence_invalid']
}

function observationAuthority(observation: AgentToolObservation): AgentEvidenceAuthority {
  const content = parseObservationContent(observation.modelContent)
  if (observation.toolName === 'sandbox_run_code') return 'sandbox'
  if (isExecutedSandboxEvidenceFacts(content)) return 'sandbox'
  if (content.observationType === 'action_result' || content.observationType === 'action_preview') return 'action'
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

function evidenceValidity(observation: AgentToolObservation, authority: AgentEvidenceAuthority, facts: Record<string, unknown>) {
  if (authority === 'sandbox') return isExecutedSandboxEvidenceFacts(facts) ? 'valid' : 'invalid'
  if (
    observation.status === 'failed' ||
    observation.status === 'cancelled' ||
    observation.status === 'not_executed' ||
    observation.status === 'invalid'
  ) return 'invalid'
  return 'valid'
}

function evidenceSubject(facts: Record<string, unknown>, authority: AgentEvidenceAuthority): AgentEvidenceSubject | undefined {
  if (authority === 'sandbox') return { type: 'calculation', label: typeof facts.purpose === 'string' ? facts.purpose : 'sandbox calculation' }
  if (authority === 'action') {
    const label = typeof facts.title === 'string' ? facts.title : typeof facts.actionKind === 'string' ? facts.actionKind : undefined
    return { type: 'workspace', ...(label ? { label } : {}) }
  }
  const scope = typeof facts.scope === 'string' ? facts.scope : null
  if (scope === 'team_summary') return { type: 'member', label: 'team summary' }
  if (scope === 'entity_summary') return { type: 'workspace', label: 'entity summary' }
  if (scope === 'ledger_history') return { type: 'ledger_entry', label: 'ledger history' }
  return { type: 'forecast', label: scope ?? 'workspace facts' }
}

function evidenceSummary(observation: AgentToolObservation, facts: Record<string, unknown>) {
  if (typeof facts.scope === 'string') return `${observation.toolName}:${facts.scope}`
  if (typeof facts.observationType === 'string') return `${observation.toolName}:${facts.observationType}`
  return observation.title || observation.toolName
}

export function evidenceFromToolObservation(input: {
  threadId: string
  runId: string
  observation: AgentToolObservation
  index: number
  now?: string
}): AgentEvidenceItem {
  const facts = parseObservationContent(input.observation.modelContent)
  const authority = observationAuthority(input.observation)
  const validity = evidenceValidity(input.observation, authority, facts)
  const subject = evidenceSubject(facts, authority)
  return {
    id: `${input.runId}:evidence:${input.index + 1}`,
    runId: input.runId,
    threadId: input.threadId,
    authority,
    validity,
    source: observationSource(input.observation, authority),
    toolCallId: input.observation.toolCallId,
    observationId: input.observation.toolCallId,
    ...(subject ? { subject } : {}),
    facts,
    ...(validity === 'invalid' && authority === 'sandbox' ? { invalidReasons: sandboxInvalidReasons(facts) } : {}),
    summary: evidenceSummary(input.observation, facts),
    createdAt: input.now ?? new Date().toISOString(),
  }
}

export function buildEvidenceLedger(input: {
  threadId: string
  runId: string
  observations: AgentToolObservation[]
  now?: string
}) {
  return input.observations.map((observation, index) =>
    evidenceFromToolObservation({
      threadId: input.threadId,
      runId: input.runId,
      observation,
      index,
      ...(input.now ? { now: input.now } : {}),
    }),
  )
}

export function buildEvidenceRequirements(input: {
  facts: AgentGoalFacts
  evidence: AgentEvidenceItem[]
  finalAnswerClaims?: AgentFinalAnswerClaim[]
}): AgentEvidenceRequirement[] {
  const requirements: AgentEvidenceRequirement[] = []
  const claims = input.finalAnswerClaims ?? []
  const hasSandboxTrajectory = input.evidence.some((item) => item.authority === 'sandbox' || item.source === 'sandbox_run_code')
  const calculationClaim = claims.find((claim) => claim.kind === 'derived_calculation')
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
  } else if (calculationClaim) {
    requirements.push({
      authority: 'sandbox',
      subject: 'calculation',
      reason: calculationClaim.reason,
      source: 'final_answer_claim',
    })
  }

  const shareholderClaim = claims.find((claim) => claim.kind === 'entity_specific' && (!claim.subject || claim.subject === 'shareholder'))
  if (input.facts.requiresOrderedEntityFacts) {
    requirements.push({
      authority: 'domain_read',
      subject: 'shareholder',
      reason: '目标契约要求有序实体事实。',
      source: 'goal_facts',
    })
  } else if (shareholderClaim) {
    requirements.push({
      authority: 'domain_read',
      subject: 'shareholder',
      reason: shareholderClaim.reason,
      source: 'final_answer_claim',
    })
  }

  return requirements
}

function objectHasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  if (Object.hasOwn(value, key)) return true
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, key))
  return Object.values(value as Record<string, unknown>).some((item) => objectHasKey(item, key))
}

export function evidenceContainsKey(items: AgentEvidenceItem[], key: string) {
  return items.some((item) => objectHasKey(item.facts, key))
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
