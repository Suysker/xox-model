import type { Kysely } from 'kysely'
import type { AgentRunEvent, AgentRunEventStatus, AgentRuntimeChannel } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { agentThreadEvents } from './thread-events.js'

const runEventQueues = new Map<string, Promise<void>>()
const MAX_SEQUENCE_RETRIES = 5

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

function isRunEventSequenceConflict(error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''
  const message = error instanceof Error ? error.message : String(error)
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (message.includes('UNIQUE constraint failed') &&
      message.includes('agent_run_events.run_id') &&
      message.includes('agent_run_events.sequence_no'))
  )
}

async function waitForRunEventTurn<T>(runId: string, work: () => Promise<T>): Promise<T> {
  const previous = runEventQueues.get(runId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => undefined).then(() => gate)
  runEventQueues.set(runId, next)

  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release()
    if (runEventQueues.get(runId) === next) {
      runEventQueues.delete(runId)
    }
  }
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
  const row = await waitForRunEventTurn(input.runId, async () => {
    for (let attempt = 0; attempt < MAX_SEQUENCE_RETRIES; attempt += 1) {
      try {
        return await insertRunEvent(db, input)
      } catch (error) {
        if (!isRunEventSequenceConflict(error) || attempt === MAX_SEQUENCE_RETRIES - 1) throw error
      }
    }
    throw new Error('Unable to append agent run event after sequence retries')
  })
  agentThreadEvents.publish(input.threadId, 'run_trace')
  return row
}

export async function listSerializedRunEvents(db: Kysely<Database>, runId: string): Promise<AgentRunEvent[]> {
  const rows = await db.selectFrom('agent_run_events').selectAll().where('run_id', '=', runId).orderBy('sequence_no', 'asc').execute()
  return rows.map(serializeRunEvent)
}
