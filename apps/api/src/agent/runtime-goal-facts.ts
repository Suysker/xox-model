import type { AgentGoalFacts } from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'

const FORBIDDEN_ACTIONS = new Set<NonNullable<AgentGoalFacts['forbiddenActions']>[number]>([
  'publish_release',
  'share_link',
  'account_action',
])

const REQUIRED_ACTION_CAPABILITIES = new Set<NonNullable<AgentGoalFacts['requiredActionCapabilities']>[number]>([
  'draft',
  'import_export',
  'ledger',
  'share',
  'version',
])

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function sanitizeAgentGoalFacts(value: unknown): AgentGoalFacts {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const workspaceName = nonEmptyString(record.workspaceName)
  const expectedMemberCount = positiveInteger(record.expectedMemberCount)
  const expectedShareholderCount = positiveInteger(record.expectedShareholderCount)
  const expectedHorizonMonths = positiveInteger(record.expectedHorizonMonths)
  const expectedStartMonth = positiveInteger(record.expectedStartMonth)
  const forbiddenActions = Array.isArray(record.forbiddenActions)
    ? record.forbiddenActions.filter((item): item is NonNullable<AgentGoalFacts['forbiddenActions']>[number] =>
        typeof item === 'string' && FORBIDDEN_ACTIONS.has(item as NonNullable<AgentGoalFacts['forbiddenActions']>[number]),
      )
    : []
  const requiredActionCapabilities = Array.isArray(record.requiredActionCapabilities)
    ? record.requiredActionCapabilities.filter((item): item is NonNullable<AgentGoalFacts['requiredActionCapabilities']>[number] =>
        typeof item === 'string' && REQUIRED_ACTION_CAPABILITIES.has(item as NonNullable<AgentGoalFacts['requiredActionCapabilities']>[number]),
      )
    : []
  const facts: AgentGoalFacts = {}
  if (workspaceName) facts.workspaceName = workspaceName
  if (expectedMemberCount) facts.expectedMemberCount = expectedMemberCount
  if (expectedShareholderCount) facts.expectedShareholderCount = expectedShareholderCount
  if (expectedHorizonMonths) facts.expectedHorizonMonths = expectedHorizonMonths
  if (expectedStartMonth) facts.expectedStartMonth = expectedStartMonth
  if (record.requiresForecastSummary === true) facts.requiresForecastSummary = true
  if (record.requiresSandboxComputation === true) facts.requiresSandboxComputation = true
  if (record.requiresOrderedEntityFacts === true) facts.requiresOrderedEntityFacts = true
  if (requiredActionCapabilities.length > 0) facts.requiredActionCapabilities = [...new Set(requiredActionCapabilities)]
  if (forbiddenActions.length > 0) facts.forbiddenActions = [...new Set(forbiddenActions)]
  return facts
}

export function mergeAgentGoalFacts(...items: AgentGoalFacts[]): AgentGoalFacts {
  const forbiddenActions = new Set<NonNullable<AgentGoalFacts['forbiddenActions']>[number]>()
  const requiredActionCapabilities = new Set<NonNullable<AgentGoalFacts['requiredActionCapabilities']>[number]>()
  const merged: AgentGoalFacts = {}
  for (const item of items) {
    const facts = sanitizeAgentGoalFacts(item)
    if (facts.workspaceName) merged.workspaceName = facts.workspaceName
    if (facts.expectedMemberCount) merged.expectedMemberCount = facts.expectedMemberCount
    if (facts.expectedShareholderCount) merged.expectedShareholderCount = facts.expectedShareholderCount
    if (facts.expectedHorizonMonths) merged.expectedHorizonMonths = facts.expectedHorizonMonths
    if (facts.expectedStartMonth) merged.expectedStartMonth = facts.expectedStartMonth
    if (facts.requiresForecastSummary) merged.requiresForecastSummary = true
    if (facts.requiresSandboxComputation) merged.requiresSandboxComputation = true
    if (facts.requiresOrderedEntityFacts) merged.requiresOrderedEntityFacts = true
    for (const capability of facts.requiredActionCapabilities ?? []) requiredActionCapabilities.add(capability)
    for (const action of facts.forbiddenActions ?? []) forbiddenActions.add(action)
  }
  if (requiredActionCapabilities.size > 0) merged.requiredActionCapabilities = [...requiredActionCapabilities]
  if (forbiddenActions.size > 0) merged.forbiddenActions = [...forbiddenActions]
  return merged
}

export function goalFactsFromRunEvent(row: Row<'agent_run_events'>): AgentGoalFacts {
  const data = parseJson<Record<string, unknown>>(row.data_json, {})
  if (row.event_type === 'tool_catalog_ready') {
    return sanitizeAgentGoalFacts(data.goalFacts)
  }
  if (row.event_type === 'runtime_evidence_required') {
    return sanitizeAgentGoalFacts(data.requiredGoalFacts)
  }
  return {}
}

export async function readRuntimeGoalFacts(db: Kysely<Database>, runId: string): Promise<AgentGoalFacts> {
  const [goals, events] = await Promise.all([
    db
      .selectFrom('agent_goals')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('agent_run_events')
      .selectAll()
      .where('run_id', '=', runId)
      .where('event_type', 'in', ['tool_catalog_ready', 'runtime_evidence_required'])
      .orderBy('sequence_no', 'asc')
      .execute(),
  ])
  const goalFacts = goals.map((goal) => {
    const contract = parseJson<{ facts?: unknown }>(goal.contract_json, {})
    return sanitizeAgentGoalFacts(contract.facts)
  })
  return mergeAgentGoalFacts(...goalFacts, ...events.map(goalFactsFromRunEvent))
}
