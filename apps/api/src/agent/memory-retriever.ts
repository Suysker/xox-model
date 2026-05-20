import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { utcNow } from '../core/time.js'
import { redactSecretLikeContent } from './memory-safety.js'
import { countMemoryEvents, addMemoryEvent } from './memory-events.js'
import { touchAgentMemories } from './memory.js'

export type AgentMemoryRetrievalResult = {
  memory: Row<'agent_memories'>
  score: number
  reasons: string[]
}

type SearchableMemoryStatus = 'candidate' | 'active' | 'promoted'

const SEARCHABLE_STATUSES = new Set<SearchableMemoryStatus>(['candidate', 'active', 'promoted'])
const CJK_CHAR = /[\u3400-\u9fff]/
const WORD_OR_CJK = /[a-z0-9_]+|[\u3400-\u9fff]/gi

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
  if (row.memory_type === 'semantic' || row.memory_type === 'procedural') return 0.12
  if (row.memory_type === 'episodic') return 0.04
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
  const memoryTokens = new Set(tokenize(`${row.key} ${row.kind} ${row.scope_type} ${row.memory_type} ${row.value}`))
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
    row.memory_type,
  ].filter((item): item is string => Boolean(item))
  return { memory: row, score: Number(score.toFixed(4)), reasons }
}

export async function retrieveAgentMemories(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  limit?: number
  includeCandidates?: boolean
}): Promise<AgentMemoryRetrievalResult[]> {
  const rows = await input.db
    .selectFrom('agent_memories')
    .selectAll()
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('archived_at', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(80)
    .execute()

  const scored = rows
    .filter((row) => SEARCHABLE_STATUSES.has(row.status as SearchableMemoryStatus))
    .filter((row) => input.includeCandidates !== false || row.status !== 'candidate')
    .map((row) => scoreMemory(row, input.query))
    .filter((result) => result.score >= 0.32 || result.reasons.some((reason) => reason.startsWith('token_overlap:')))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(12, input.limit ?? 6)))

  return scored
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
  const promoted: Row<'agent_memories'>[] = []
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
    const recallCount = await countMemoryEvents(input.db, memory.id, 'recalled')
    if (memory.status !== 'candidate' || recallCount < 2 || memory.confidence < 0.65 || memory.kind === 'episode') continue
    const nextType = memory.kind === 'workflow' ? 'procedural' : 'semantic'
    await input.db
      .updateTable('agent_memories')
      .set({
        status: 'promoted',
        memory_type: nextType,
        promoted_at: utcNow(),
        updated_at: utcNow(),
      })
      .where('id', '=', memory.id)
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .execute()
    await addMemoryEvent(input.db, {
      memoryId: memory.id,
      workspaceId: input.workspace.id,
      userId: input.user.id,
      threadId: input.threadId,
      runId: input.runId,
      eventType: 'promoted',
      evidence: { recallCount, fromType: memory.memory_type, toType: nextType },
      metadata: { reason: 'repeated_scoped_recall' },
    })
    const updated = await input.db.selectFrom('agent_memories').selectAll().where('id', '=', memory.id).executeTakeFirst()
    if (updated) promoted.push(updated)
  }
  return promoted
}
