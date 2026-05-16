import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'

export async function recordAudit(
  db: Kysely<Database>,
  input: {
    workspaceId?: string | null
    actorId?: string | null
    action: string
    status?: string
    entityType?: string | null
    entityId?: string | null
    meta?: unknown
  },
) {
  await db
    .insertInto('audit_logs')
    .values({
      id: newId(),
      workspace_id: input.workspaceId ?? null,
      actor_id: input.actorId ?? null,
      action: input.action,
      status: input.status ?? 'success',
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      meta_json: input.meta === undefined ? null : jsonString(input.meta),
      created_at: utcNow(),
    })
    .execute()
}
