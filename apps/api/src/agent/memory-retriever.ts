import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { utcNow } from '../core/time.js'
import { redactSecretLikeContent } from './memory-safety.js'
import { addMemoryEvent } from './memory-events.js'
import { touchAgentMemories } from './memory.js'
import { isMemoryPromptInjectable, type AgentMemoryLane, type AgentMemoryStatus } from './memory-promotion-policy.js'

export type AgentMemoryRetrievalResult = {
  memory: Row<'agent_memories'>
  score: number
  reasons: string[]
}

type SearchableMemoryStatus = AgentMemoryStatus

const SEARCHABLE_STATUSES = new Set<SearchableMemoryStatus>(['candidate', 'active', 'promoted', 'archived', 'expired', 'superseded'])
const CJK_CHAR = /[\u3400-\u9fff]/
const WORD_OR_CJK = /[a-z0-9_]+|[\u3400-\u9fff]/gi
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

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

function tokenize(value: string) {
  const normalized = normalize(value)
  const raw = normalized.match(WORD_OR_CJK) ?? []
  const words = raw.filter((token) => !CJK_CHAR.test(token) && token.length >= 2)
  const cjkChars = raw.filter((token) => CJK_CHAR.test(token))
  const cjkBigrams = cjkChars.slice(0, -1).map((char, index) => `${char}${cjkChars[index + 1]}`)
  return unique([...words, ...cjkChars, ...cjkBigrams])
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
  const queryTokens = tokenize(query)
  const memoryTokens = new Set(tokenize(`${row.key} ${row.kind} ${row.scope_type} ${row.memory_type} ${row.lane} ${row.value}`))
  const overlap = queryTokens.filter((token) => memoryTokens.has(token))
  const lexical = queryTokens.length > 0 ? overlap.length / queryTokens.length : 0
  const phrase = normalize(row.value).includes(normalize(query)) && query.trim().length >= 3 ? 0.18 : 0
  const keyHit = normalize(row.key).includes(normalize(query)) && query.trim().length >= 3 ? 0.12 : 0
  const confidence = Math.max(0, Math.min(1, row.confidence)) * 0.18
  const score = lexical * 0.5 + phrase + keyHit + confidence + statusBoost(row) + typeBoost(row) + scopeBoost(row) + ageBoost(row)
  const reasons = [
    overlap.length > 0 ? `token_overlap:${overlap.slice(0, 6).join(',')}` : null,
    phrase > 0 ? 'phrase_match' : null,
    keyHit > 0 ? 'key_match' : null,
    row.status === 'candidate' ? 'candidate_memory' : `${row.status}_memory`,
    row.injectable ? 'injectable' : 'non_injectable',
    row.lane,
    row.memory_type,
  ].filter((item): item is string => Boolean(item))
  return { memory: row, score: Number(score.toFixed(4)), reasons }
}

// Inspired by OpenClaw's MIT-licensed memory MMR utility. This local version
// reranks DB-backed SaaS memory rows instead of filesystem snippets.
function jaccard(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function applyMmr(results: AgentMemoryRetrievalResult[], lambda = 0.72) {
  if (results.length <= 2) return results
  const remaining = [...results]
  const selected: AgentMemoryRetrievalResult[] = []
  const tokens = new Map<string, Set<string>>()
  for (const result of results) tokens.set(result.memory.id, new Set(tokenize(`${result.memory.key} ${result.memory.value}`)))
  while (remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!
      const candidateTokens = tokens.get(candidate.memory.id) ?? new Set<string>()
      const maxSimilarity = selected.reduce((max, item) => Math.max(max, jaccard(candidateTokens, tokens.get(item.memory.id) ?? new Set<string>())), 0)
      const score = lambda * candidate.score - (1 - lambda) * maxSimilarity
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!)
  }
  return selected
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
  const ranked = applyMmr(input.forPrompt ? applyPromptLaneBudgets(scored) : scored)
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
}) {
  if (input.memories.length === 0) return []
  await touchAgentMemories(input.db, input.memories)
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
