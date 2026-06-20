import type { Kysely } from 'kysely'
import type { AgentRunEvent, AgentRunEventStatus, AgentRuntimeChannel } from '@xox/contracts'
import {
  createAgentServerSequencedRunEventAppender,
  isAgentServerSqliteUniqueConstraintError,
} from '@agentic-os/server'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { agentThreadEvents } from './thread-events.js'

const runEventAppender = createAgentServerSequencedRunEventAppender({
  maxSequenceRetries: 5,
  isSequenceConflict: (error) => isAgentServerSqliteUniqueConstraintError(error, [
    'agent_run_events.run_id',
    'agent_run_events.sequence_no',
  ]),
})

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

function runEventChannel(value: string | null | undefined): AgentRuntimeChannel {
  if (value === 'assistant' || value === 'tool' || value === 'lifecycle') return value
  return 'lifecycle'
}

function inferredRunEventChannel(input: {
  type: string
  data?: Record<string, unknown> | null
}): AgentRuntimeChannel {
  if (input.type === 'assistant_final_message' || input.type === 'final_answer_candidate') return 'assistant'
  if (input.type === 'provider_stream_delta') {
    const kind = input.data?.kind
    if (kind === 'content_delta') return 'assistant'
    if (kind === 'tool_call_delta') return 'tool'
  }
  if (
    input.type === 'provider_tool_call_repaired' ||
    input.type === 'tool_call_started' ||
    input.type === 'tool_call_completed' ||
    input.type === 'tool_call_failed' ||
    input.type === 'action_updated' ||
    input.type === 'action_executed' ||
    input.type === 'action_auto_executed' ||
    input.type === 'action_execution_failed' ||
    input.type === 'action_auto_execution_failed' ||
    input.type === 'action_cancelled'
  ) {
    return 'tool'
  }
  return 'lifecycle'
}

export function serializeRunEvent(row: Row<'agent_run_events'>): AgentRunEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    sequence: row.sequence_no,
    channel: runEventChannel(row.channel),
    type: row.event_type,
    title: row.title,
    message: row.message,
    status: runEventStatus(row.status),
    data: row.data_json ? parseJson<Record<string, unknown> | null>(row.data_json, null) : null,
    createdAt: row.created_at,
  }
}

async function loadRunEventMaxSequence(db: Kysely<Database>, runId: string) {
  const existing = await db
    .selectFrom('agent_run_events')
    .select(({ fn }) => fn.max<number>('sequence_no').as('maxSequence'))
    .where('run_id', '=', runId)
    .executeTakeFirst()
  return Number(existing?.maxSequence ?? 0)
}

async function insertRunEvent(
  db: Kysely<Database>,
  input: {
    threadId: string
    runId: string
    type: string
    title: string
    message: string
    status: AgentRunEventStatus
    channel?: AgentRuntimeChannel | undefined
    data?: Record<string, unknown> | null
  },
  sequence: number,
) {
  const id = newId()
  await db
    .insertInto('agent_run_events')
    .values({
      id,
      thread_id: input.threadId,
      run_id: input.runId,
      sequence_no: sequence,
      channel: input.channel ?? inferredRunEventChannel(input),
      event_type: input.type,
      title: input.title.slice(0, 180),
      message: input.message,
      status: input.status,
      data_json: input.data ? jsonString(input.data) : null,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_run_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
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
    channel?: AgentRuntimeChannel | undefined
    data?: Record<string, unknown> | null
  },
) {
  const row = await runEventAppender.append({
    runId: input.runId,
    loadMaxSequence: () => loadRunEventMaxSequence(db, input.runId),
    insert: ({ sequence }) => insertRunEvent(db, input, sequence),
  })
  agentThreadEvents.publish(input.threadId, 'run_trace')
  return row
}

export async function listSerializedRunEvents(db: Kysely<Database>, runId: string): Promise<AgentRunEvent[]> {
  const rows = await db.selectFrom('agent_run_events').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
  return rows.map(serializeRunEvent)
}
