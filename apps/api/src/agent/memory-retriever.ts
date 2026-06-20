import { applyMmr, lexicalRelevance } from '@xox/agent-memory-core'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { utcNow } from '../core/time.js'
import { redactSecretLikeContent } from '@agentic-os/core'
import { addMemoryEvent } from './memory-events.js'
import { touchAgentMemories } from './memory.js'
import { recordMemoryRecallSignals } from './memory/recall-signals.js'
import { isMemoryPromptInjectable, type AgentMemoryLane, type AgentMemoryStatus } from './memory-promotion-policy.js'

export type AgentMemoryRetrievalResult = {
  memory: Row<'agent_memories'>
  score: number
  reasons: string[]
}

type SearchableMemoryStatus = AgentMemoryStatus

const SEARCHABLE_STATUSES = new Set<SearchableMemoryStatus>(['candidate', 'active', 'promoted', 'archived', 'expired', 'superseded'])
const DEFAULT_PROMPT_LANE_LIMITS: Record<string, number> = {
  working: 3,
  semantic: 4,
  procedural: 3,
  episodic: 0,
  diagnostic: 0,
  archived: 0,
}

function normalize(value: string) {
  return redactSecretLikeContent(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

function ageBoost(row: Row<'agent_memories'>) {
  const anchor = Date.parse(row.last_used_at ?? row.updated_at ?? row.created_at)
  if (!Number.isFinite(anchor)) return 0
  const days = Math.max(0, (Date.parse(utcNow()) - anchor) / 86_400_000)
  if (days <= 1) return 0.08
  if (days <= 7) return 0.04
  if (days <= 30) return 0.02
  return 0
}

function statusBoost(row: Row<'agent_memories'>) {
  if (row.status === 'promoted') return 0.16
  if (row.status === 'active') return 0.1
  return 0
}

function typeBoost(row: Row<'agent_memories'>) {
  if (row.lane === 'semantic' || row.lane === 'procedural') return 0.14
  if (row.lane === 'working') return 0.1
  if (row.lane === 'episodic') return 0.02
  return 0
}

function scopeBoost(row: Row<'agent_memories'>) {
  if (row.scope_type === 'workspace') return 0.08
  if (row.scope_type === 'user' || row.scope_type === 'procedural') return 0.04
  if (row.scope_type === 'thread') return 0.02
  return 0
}

function scoreMemory(row: Row<'agent_memories'>, query: string): AgentMemoryRetrievalResult {
  const relevance = lexicalRelevance(query, `${row.key} ${row.kind} ${row.scope_type} ${row.memory_type} ${row.lane} ${row.value}`)
  const keyHit = normalize(row.key).includes(normalize(query)) && query.trim().length >= 3 ? 0.12 : 0
  const confidence = Math.max(0, Math.min(1, row.confidence)) * 0.18
  const score = relevance.score + keyHit + confidence + statusBoost(row) + typeBoost(row) + scopeBoost(row) + ageBoost(row)
  const reasons = [
    ...relevance.reasons,
    keyHit > 0 ? 'key_match' : null,
    row.status === 'candidate' ? 'candidate_memory' : `${row.status}_memory`,
    row.injectable ? 'injectable' : 'non_injectable',
    row.lane,
    row.memory_type,
  ].filter((item): item is string => Boolean(item))
  return { memory: row, score: Number(score.toFixed(4)), reasons }
}

function applyPromptLaneBudgets(results: AgentMemoryRetrievalResult[]) {
  const counts = new Map<string, number>()
  return results.filter((result) => {
    const lane = result.memory.lane as AgentMemoryLane
    const limit = DEFAULT_PROMPT_LANE_LIMITS[lane] ?? 0
    const current = counts.get(lane) ?? 0
    if (current >= limit) return false
    counts.set(lane, current + 1)
    return true
  })
}

export async function retrieveAgentMemories(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  limit?: number
  includeCandidates?: boolean
  includeArchived?: boolean
  includeNonInjectable?: boolean
  includeDiagnostics?: boolean
  forPrompt?: boolean
  threadId?: string | null
}): Promise<AgentMemoryRetrievalResult[]> {
  const rows = await input.db
    .selectFrom('agent_memories')
    .selectAll()
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .orderBy('updated_at', 'desc')
    .limit(80)
    .execute()

  const scored = rows
    .filter((row) => SEARCHABLE_STATUSES.has(row.status as SearchableMemoryStatus))
    .filter((row) => input.includeCandidates === true || row.status !== 'candidate')
    .filter((row) => input.includeArchived === true || !['archived', 'expired', 'superseded'].includes(row.status))
    .filter((row) => input.includeDiagnostics === true || row.lane !== 'diagnostic')
    .filter((row) => input.includeNonInjectable === true || input.forPrompt === true || Number(row.injectable) === 1)
    .filter((row) => !input.forPrompt || isMemoryPromptInjectable(row, { now: utcNow(), ...(input.threadId !== undefined ? { threadId: input.threadId } : {}) }))
    .map((row) => scoreMemory(row, input.query))
    .filter((result) => result.score >= 0.32 || result.reasons.some((reason) => reason.startsWith('token_overlap:')))
    .sort((left, right) => right.score - left.score)
  const ranked = applyMmr(
    (input.forPrompt ? applyPromptLaneBudgets(scored) : scored).map((result) => ({
      ...result,
      id: result.memory.id,
      key: result.memory.key,
      value: result.memory.value,
    })),
  )
    .map(({ id: _id, key: _key, value: _value, ...result }) => result)
    .slice(0, Math.max(1, Math.min(50, input.limit ?? 6)))

  return ranked
}

export async function markAgentMemoriesRecalled(input: {
  db: Kysely<Database>
  memories: Row<'agent_memories'>[]
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  query: string
  retrieval?: Array<{ memoryId: string; score: number; reasons: string[] }>
}) {
  if (input.memories.length === 0) return []
  await touchAgentMemories(input.db, input.memories)
  const retrievalByMemoryId = new Map((input.retrieval ?? []).map((item) => [item.memoryId, item]))
  await recordMemoryRecallSignals({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    query: input.query,
    retrieval: input.memories.map((memory) => {
      const retrieval = retrievalByMemoryId.get(memory.id)
      return {
        memory,
        score: retrieval?.score ?? 0.5,
        reasons: retrieval?.reasons ?? ['recalled'],
      }
    }),
  })
  for (const memory of input.memories) {
    await addMemoryEvent(input.db, {
      memoryId: memory.id,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId,
      runId: input.runId,
      eventType: 'recalled',
      evidence: { query: redactSecretLikeContent(input.query).slice(0, 500) },
      metadata: { memoryType: memory.memory_type, status: memory.status },
    })
  }
  return []
}
