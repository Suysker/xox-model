import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { rankShortTermPromotionCandidates, type ShortTermRecallSignal } from '@xox/agent-memory-core'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import { parseJson } from '../../db/database.js'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'

function queryHash(query: string) {
  return createHash('sha256').update(query.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 32)
}

function uniqueLimited(values: string[], limit: number) {
  return [...new Set(values)].slice(-limit)
}

export async function recordMemoryRecallSignals(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  query: string
  retrieval: Array<{ memory: Row<'agent_memories'>; score: number; reasons: string[] }>
}) {
  const now = utcNow()
  const day = now.slice(0, 10)
  const hash = queryHash(input.query)
  for (const item of input.retrieval) {
    const memory = item.memory
    if (memory.workspace_id !== input.workspace.id || memory.user_id !== input.user.id) continue
    if (memory.lane === 'diagnostic' || memory.status === 'archived' || memory.status === 'expired') continue

    const existing = await input.db
      .selectFrom('agent_memory_recall_signals')
      .selectAll()
      .where('workspace_id', '=', input.workspace.id)
      .where('user_id', '=', input.user.id)
      .where('memory_id', '=', memory.id)
      .executeTakeFirst()
    if (!existing) {
      await input.db.insertInto('agent_memory_recall_signals').values({
        id: newId(),
        memory_id: memory.id,
        workspace_id: input.workspace.id,
        user_id: input.user.id,
        recall_count: 1,
        total_score: item.score,
        max_score: item.score,
        query_hashes_json: JSON.stringify([hash]),
        recall_days_json: JSON.stringify([day]),
        first_recalled_at: now,
        last_recalled_at: now,
        promoted_at: null,
        metadata_json: JSON.stringify({ lastReasons: item.reasons }),
      }).execute()
      continue
    }

    const queryHashes = uniqueLimited([...parseJson<string[]>(existing.query_hashes_json, []), hash], 32)
    const recallDays = uniqueLimited([...parseJson<string[]>(existing.recall_days_json, []), day], 32)
    await input.db
      .updateTable('agent_memory_recall_signals')
      .set({
        recall_count: existing.recall_count + 1,
        total_score: existing.total_score + item.score,
        max_score: Math.max(existing.max_score, item.score),
        query_hashes_json: JSON.stringify(queryHashes),
        recall_days_json: JSON.stringify(recallDays),
        last_recalled_at: now,
        metadata_json: JSON.stringify({ lastReasons: item.reasons }),
      })
      .where('id', '=', existing.id)
      .execute()
  }
}

export async function listPromotionCandidatesFromSignals(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  limit?: number
}) {
  const rows = await input.db
    .selectFrom('agent_memory_recall_signals')
    .innerJoin('agent_memories', 'agent_memories.id', 'agent_memory_recall_signals.memory_id')
    .select([
      'agent_memory_recall_signals.id as signal_id',
      'agent_memory_recall_signals.memory_id as memory_id',
      'agent_memory_recall_signals.recall_count as recall_count',
      'agent_memory_recall_signals.total_score as total_score',
      'agent_memory_recall_signals.max_score as max_score',
      'agent_memory_recall_signals.query_hashes_json as query_hashes_json',
      'agent_memory_recall_signals.recall_days_json as recall_days_json',
      'agent_memory_recall_signals.first_recalled_at as first_recalled_at',
      'agent_memory_recall_signals.last_recalled_at as last_recalled_at',
      'agent_memory_recall_signals.promoted_at as signal_promoted_at',
      'agent_memories.value as value',
    ])
    .where('agent_memory_recall_signals.workspace_id', '=', input.workspace.id)
    .where('agent_memory_recall_signals.user_id', '=', input.user.id)
    .where('agent_memories.injectable', '=', 1)
    .where('agent_memories.lane', '!=', 'diagnostic')
    .execute()

  const signals: ShortTermRecallSignal[] = rows.map((row) => ({
    memoryId: row.memory_id,
    snippet: row.value,
    recallCount: row.recall_count,
    totalScore: row.total_score,
    maxScore: row.max_score,
    uniqueQueries: parseJson<string[]>(row.query_hashes_json, []).length,
    recallDays: parseJson<string[]>(row.recall_days_json, []),
    firstRecalledAt: row.first_recalled_at,
    lastRecalledAt: row.last_recalled_at,
    promotedAt: row.signal_promoted_at,
  }))
  return rankShortTermPromotionCandidates({ signals, limit: input.limit ?? 20 })
}
