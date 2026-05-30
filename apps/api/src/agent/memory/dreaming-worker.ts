import type { Kysely } from 'kysely'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { listPromotionCandidatesFromSignals } from './recall-signals.js'

export async function runMemoryDreamingSweep(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId?: string | null
  runId?: string | null
  limit?: number
}) {
  const candidates = await listPromotionCandidatesFromSignals({
    db: input.db,
    workspace: input.workspace,
    user: input.user,
    limit: input.limit ?? 20,
  })
  const now = utcNow()
  const id = newId()
  const candidateIds = candidates.map((candidate) => candidate.memoryId)
  if (candidateIds.length === 0) return null
  await input.db.insertInto('agent_memory_dream_reports').values({
    id,
    workspace_id: input.workspace.id,
    user_id: input.user.id,
    thread_id: input.threadId ?? null,
    run_id: input.runId ?? null,
    status: 'review',
    title: 'OpenClaw-style memory dreaming sweep',
    summary: `发现 ${candidateIds.length} 条达到 OpenClaw-style recall/promotion 信号阈值的记忆候选，等待人工或策略复核。`,
    candidate_ids_json: JSON.stringify(candidateIds),
    promoted_ids_json: JSON.stringify([]),
    score_json: JSON.stringify(candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      score: candidate.score,
      components: candidate.components,
      recallCount: candidate.recallCount,
      uniqueQueries: candidate.uniqueQueries,
    }))),
    created_at: now,
    updated_at: now,
  }).execute()
  return input.db.selectFrom('agent_memory_dream_reports').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
