import type { Kysely } from 'kysely'
import type { AgentRunEvent, AgentRunEventStatus } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { agentThreadEvents } from './thread-events.js'

function runEventStatus(value: string): AgentRunEventStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'info' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return 'info'
}

export function serializeRunEvent(row: Row<'agent_run_events'>): AgentRunEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    sequence: row.sequence_no,
    type: row.event_type,
    title: row.title,
    message: row.message,
    status: runEventStatus(row.status),
    data: row.data_json ? parseJson<Record<string, unknown> | null>(row.data_json, null) : null,
    createdAt: row.created_at,
  }
}

export async function addRunEvent(
  db: Kysely<Database>,
  input: {
    threadId: string
    runId: string
    type: string
    title: string
    message: string
    status: AgentRunEventStatus
    data?: Record<string, unknown> | null
  },
) {
  const existing = await db
    .selectFrom('agent_run_events')
    .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
    .where('run_id', '=', input.runId)
    .executeTakeFirst()
  const sequence = Number(existing?.maxSequence ?? 0) + 1
  const id = newId()
  await db
    .insertInto('agent_run_events')
    .values({
      id,
      thread_id: input.threadId,
      run_id: input.runId,
      sequence_no: sequence,
      event_type: input.type,
      title: input.title.slice(0, 180),
      message: input.message,
      status: input.status,
      data_json: input.data ? jsonString(input.data) : null,
      created_at: utcNow(),
    })
    .execute()
  agentThreadEvents.publish(input.threadId, 'run_trace')
  return db.selectFrom('agent_run_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

export async function listSerializedRunEvents(db: Kysely<Database>, runId: string): Promise<AgentRunEvent[]> {
  const rows = await db.selectFrom('agent_run_events').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
  return rows.map(serializeRunEvent)
}
