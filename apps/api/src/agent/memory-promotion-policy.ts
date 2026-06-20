import { createHash } from 'node:crypto'
import { containsSecretLikeContent, normalizeSecretSafeText } from '@agentic-os/core'
import type { Row } from '../db/schema.js'
import { utcNow } from '../core/time.js'

export type AgentMemoryLane =
  | 'working'
  | 'session'
  | 'semantic'
  | 'procedural'
  | 'episodic'
  | 'diagnostic'
  | 'archived'

export type AgentMemoryStatus =
  | 'candidate'
  | 'active'
  | 'promoted'
  | 'archived'
  | 'rejected'
  | 'expired'
  | 'superseded'

export type AgentMemoryKind =
  | 'preference'
  | 'fact'
  | 'business_fact'
  | 'business_rule'
  | 'workflow'
  | 'episode'
  | 'correction'
  | 'diagnostic'

export type MemoryCandidateDecision =
  | 'store_candidate'
  | 'activate'
  | 'promote'
  | 'archive'
  | 'reject'
  | 'expire'
  | 'merge'
  | 'diagnostic_only'

export type MemoryPolicyInput = {
  kind: AgentMemoryKind
  scopeType: string
  memoryType: string
  lane?: AgentMemoryLane
  status?: AgentMemoryStatus
  injectable?: boolean
  sourceKind?: string | null
  key: string
  value: string
  confidence: number
  evidenceScore?: number | null
  expiresAt?: string | null
}

export type MemoryPolicyDecision = {
  kind: AgentMemoryKind
  lane: AgentMemoryLane
  status: AgentMemoryStatus
  injectable: boolean
  normalizedHash: string
  evidenceScore: number
  sourceKind: string
  expiresAt: string | null
  decision: MemoryCandidateDecision
  reason: string
  scoreBreakdown: {
    usefulness: number
    stability: number
    specificity: number
    safety: number
    evidence: number
    novelty: number
  }
}

const PROMPT_INJECTABLE_LANES = new Set<AgentMemoryLane>(['working', 'semantic', 'procedural'])
const PROMPT_INJECTABLE_STATUSES = new Set<AgentMemoryStatus>(['active', 'promoted'])
const NON_INJECTABLE_STATUSES = new Set<AgentMemoryStatus>(['candidate', 'archived', 'rejected', 'expired', 'superseded'])

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 40)
}

export function normalizedMemoryHash(input: Pick<MemoryPolicyInput, 'kind' | 'scopeType' | 'key' | 'value'>) {
  const normalized = normalizeSecretSafeText(`${input.kind}:${input.scopeType}:${input.key}:${input.value}`, 800)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  return stableHash(normalized)
}

export function deriveMemoryLane(input: Pick<MemoryPolicyInput, 'kind' | 'memoryType' | 'lane' | 'sourceKind' | 'key' | 'value'>): AgentMemoryLane {
  if (input.lane) return input.lane
  if (input.kind === 'diagnostic' || input.sourceKind === 'evaluator_result' || input.key.startsWith('agent.evaluator.finding.')) return 'diagnostic'
  if (input.key.startsWith('agent.goal.completed.')) return 'episodic'
  if (input.key.startsWith('workspace.recent_related_entity.')) return 'working'
  if (input.memoryType === 'semantic' || input.memoryType === 'procedural' || input.memoryType === 'working' || input.memoryType === 'episodic') return input.memoryType
  if (input.kind === 'preference' || input.kind === 'business_fact' || input.kind === 'business_rule') return 'semantic'
  if (input.kind === 'workflow') return 'procedural'
  if (input.kind === 'episode' || input.kind === 'correction') return 'episodic'
  return 'semantic'
}

export function deriveMemoryStatus(input: Pick<MemoryPolicyInput, 'status' | 'kind' | 'lane' | 'memoryType' | 'sourceKind'> & { lane: AgentMemoryLane }): AgentMemoryStatus {
  if (input.status) return input.status
  if (input.lane === 'diagnostic') return 'active'
  if (input.lane === 'working') return 'active'
  if (input.lane === 'episodic') return 'archived'
  if (input.memoryType === 'semantic' || input.memoryType === 'procedural' || input.lane === 'semantic' || input.lane === 'procedural') return 'promoted'
  return 'candidate'
}

export function isMemoryPromptInjectable(row: Row<'agent_memories'>, options: { threadId?: string | null; now?: string } = {}) {
  const lane = row.lane as AgentMemoryLane
  const status = row.status as AgentMemoryStatus
  if (Number(row.injectable) !== 1) return false
  if (!PROMPT_INJECTABLE_LANES.has(lane)) return false
  if (!PROMPT_INJECTABLE_STATUSES.has(status)) return false
  if (NON_INJECTABLE_STATUSES.has(status)) return false
  if (lane === 'working') {
    if (!options.threadId || row.thread_id !== options.threadId) return false
    if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(options.now ?? utcNow())) return false
  }
  return true
}

export function decideMemoryCandidate(input: MemoryPolicyInput): MemoryPolicyDecision {
  const lane = deriveMemoryLane(input)
  const status = deriveMemoryStatus({ ...input, lane })
  const sourceKind =
    input.sourceKind ??
    (lane === 'diagnostic'
      ? 'evaluator_result'
      : lane === 'episodic'
        ? 'confirmed_action'
        : lane === 'working'
          ? 'working_context'
          : 'manual_memory')
  const safety = containsSecretLikeContent(input.value) ? 0 : 1
  const evidence = clamp01(input.evidenceScore ?? (sourceKind === 'manual_memory' ? 0.9 : sourceKind === 'confirmed_action' ? 0.75 : 0.45))
  const stability =
    lane === 'semantic' || lane === 'procedural'
      ? 0.85
      : lane === 'working'
        ? 0.25
        : lane === 'diagnostic'
          ? 0.1
          : 0.35
  const specificity = normalizeSecretSafeText(input.value, 600).length >= 12 ? 0.8 : 0.35
  const usefulness = lane === 'semantic' || lane === 'procedural' ? 0.8 : lane === 'working' ? 0.55 : 0.35
  const novelty = 0.7
  const injectable =
    input.injectable ??
    (safety === 1 &&
      PROMPT_INJECTABLE_LANES.has(lane) &&
      PROMPT_INJECTABLE_STATUSES.has(status) &&
      sourceKind !== 'evaluator_result')

  let decision: MemoryCandidateDecision = 'store_candidate'
  let reason = 'stored as governed candidate'
  if (safety === 0) {
    decision = 'reject'
    reason = 'secret-like content is not eligible for memory'
  } else if (lane === 'diagnostic') {
    decision = 'diagnostic_only'
    reason = 'diagnostics are retained for audit but never injected into ordinary planning context'
  } else if (lane === 'episodic') {
    decision = 'archive'
    reason = 'episode is searchable evidence but not prompt-injectable by default'
  } else if (lane === 'working') {
    decision = 'activate'
    reason = 'working memory is scoped to the current thread and expiry'
  } else if (status === 'promoted') {
    decision = 'promote'
    reason = 'stable semantic/procedural memory is eligible for relevant recall'
  }

  return {
    kind: input.kind,
    lane,
    status,
    injectable,
    normalizedHash: normalizedMemoryHash(input),
    evidenceScore: evidence,
    sourceKind,
    expiresAt: input.expiresAt ?? null,
    decision,
    reason,
    scoreBreakdown: { usefulness, stability, specificity, safety, evidence, novelty },
  }
}
