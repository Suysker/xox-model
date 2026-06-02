import type { AgentToolObservation } from './tool-observation-continuation.js'

export type AgentEvidenceAuthority = 'ambient' | 'domain_read' | 'sandbox' | 'action' | 'memory'

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
  source: AgentEvidenceSource
  toolCallId?: string | null
  observationId?: string | null
  subject?: AgentEvidenceSubject
  facts: Record<string, unknown>
  summary?: string
  createdAt: string
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
  return facts.observationType === 'sandbox_result' &&
    facts.executionMode === 'executed' &&
    facts.status === 'completed' &&
    facts.exitCode === 0 &&
    facts.structuredOutput !== null &&
    facts.structuredOutput !== undefined
}

function observationAuthority(observation: AgentToolObservation): AgentEvidenceAuthority {
  const content = parseObservationContent(observation.modelContent)
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
  const subject = evidenceSubject(facts, authority)
  return {
    id: `${input.runId}:evidence:${input.index + 1}`,
    runId: input.runId,
    threadId: input.threadId,
    authority,
    source: observationSource(input.observation, authority),
    toolCallId: input.observation.toolCallId,
    observationId: input.observation.toolCallId,
    ...(subject ? { subject } : {}),
    facts,
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
    source: item.source,
    subject: item.subject,
    summary: item.summary,
    facts: item.facts,
  }))
}
