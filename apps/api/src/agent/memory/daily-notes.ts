import type { Kysely } from 'kysely'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { redactSecretLikeContent } from '@agentic-os/core'

export async function storeDailyMemoryNote(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId?: string | null
  runId?: string | null
  noteDate?: string
  title: string
  content: string
  evidence?: Record<string, unknown> | null
}) {
  const content = redactSecretLikeContent(input.content).replace(/\s+/g, ' ').trim().slice(0, 4000)
  if (!content) return null
  const now = utcNow()
  const id = newId()
  await input.db.insertInto('agent_memory_notes').values({
    id,
    workspace_id: input.workspace.id,
    user_id: input.user.id,
    thread_id: input.threadId ?? null,
    run_id: input.runId ?? null,
    note_date: input.noteDate ?? now.slice(0, 10),
    layer: 'daily',
    title: input.title.slice(0, 180),
    content,
    evidence_json: input.evidence ? JSON.stringify(input.evidence) : null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }).execute()
  return input.db.selectFrom('agent_memory_notes').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function listDailyMemoryNotes(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  limit?: number
}) {
  return input.db
    .selectFrom('agent_memory_notes')
    .selectAll()
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('archived_at', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(Math.max(1, Math.min(100, input.limit ?? 30)))
    .execute()
}
