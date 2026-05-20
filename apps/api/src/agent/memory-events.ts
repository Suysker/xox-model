import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'

export type AgentMemoryEventType = 'captured' | 'recalled' | 'injected' | 'promoted' | 'rejected' | 'archived' | 'expired'

export async function addMemoryEvent(
  db: Kysely<Database>,
  input: {
    memoryId?: string | null
    workspaceId: string
    userId: string
    threadId?: string | null
    runId?: string | null
    eventType: AgentMemoryEventType
    evidence?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  },
) {
  const id = newId()
  await db
    .insertInto('agent_memory_events')
    .values({
      id,
      memory_id: input.memoryId ?? null,
      workspace_id: input.workspaceId,
      user_id: input.userId,
      thread_id: input.threadId ?? null,
      run_id: input.runId ?? null,
      event_type: input.eventType,
      evidence_json: input.evidence ? jsonString(input.evidence) : null,
      metadata_json: input.metadata ? jsonString(input.metadata) : null,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_memory_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function countMemoryEvents(db: Kysely<Database>, memoryId: string, eventType: AgentMemoryEventType) {
  const row = await db
    .selectFrom('agent_memory_events')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('memory_id', '=', memoryId)
    .where('event_type', '=', eventType)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

export function serializeMemoryEvent(row: Row<'agent_memory_events'>) {
  return {
    id: row.id,
    memoryId: row.memory_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    threadId: row.thread_id,
    runId: row.run_id,
    eventType: row.event_type,
    evidence: row.evidence_json ? parseJson<Record<string, unknown> | null>(row.evidence_json, null) : null,
    metadata: row.metadata_json ? parseJson<Record<string, unknown> | null>(row.metadata_json, null) : null,
    createdAt: row.created_at,
  }
}
