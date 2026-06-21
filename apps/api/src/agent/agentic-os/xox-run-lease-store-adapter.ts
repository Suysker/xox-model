import type { Kysely } from 'kysely'
import {
  AgentServerRunLeaseLostError,
  agentServerRunLeaseExpiresAt,
  assertAgentServerRunLease,
  startAgentServerRunLeaseHeartbeat,
} from '@agentic-os/server'
import type { Settings } from '../../core/settings.js'
import { utcNow } from '../../core/time.js'
import type { Database, Row } from '../../db/schema.js'

export { AgentServerRunLeaseLostError as AgentRunLeaseLostError }

export async function claimAgentRunLease(
  db: Kysely<Database>,
  settings: Settings,
  runId: string,
): Promise<Row<'agent_runs'> | null> {
  const now = utcNow()
  await db
    .updateTable('agent_runs')
    .set({
      worker_id: settings.agentWorkerId,
      lease_expires_at: agentServerRunLeaseExpiresAt(settings.agentRunLeaseTtlMs),
      heartbeat_at: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .where((eb) =>
      eb.or([
        eb('worker_id', 'is', null),
        eb('worker_id', '=', settings.agentWorkerId),
        eb('lease_expires_at', 'is', null),
        eb('lease_expires_at', '<', now),
      ]),
    )
    .execute()

  const row = await db
    .selectFrom('agent_runs')
    .selectAll()
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .where('worker_id', '=', settings.agentWorkerId)
    .executeTakeFirst()
  return row ?? null
}

export async function refreshAgentRunLease(
  db: Kysely<Database>,
  settings: Settings,
  runId: string,
) {
  const now = utcNow()
  await db
    .updateTable('agent_runs')
    .set({
      lease_expires_at: agentServerRunLeaseExpiresAt(settings.agentRunLeaseTtlMs),
      heartbeat_at: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .where('worker_id', '=', settings.agentWorkerId)
    .execute()

  const row = await db
    .selectFrom('agent_runs')
    .select(['status', 'worker_id'])
    .where('id', '=', runId)
    .executeTakeFirst()
  return row?.status === 'running' && row.worker_id === settings.agentWorkerId
}

export async function assertAgentRunLease(
  db: Kysely<Database>,
  settings: Settings,
  runId: string,
) {
  await assertAgentServerRunLease({
    runId,
    refresh: () => refreshAgentRunLease(db, settings, runId),
  })
}

export async function claimRecoverableAgentRuns(
  db: Kysely<Database>,
  settings: Settings,
) {
  const now = utcNow()
  const candidates = await db
    .selectFrom('agent_runs')
    .selectAll()
    .where('status', '=', 'running')
    .where((eb) =>
      eb.or([
        eb('worker_id', 'is', null),
        eb('worker_id', '=', settings.agentWorkerId),
        eb('lease_expires_at', 'is', null),
        eb('lease_expires_at', '<', now),
      ]),
    )
    .orderBy('created_at', 'asc')
    .execute()

  const claimed: Array<Row<'agent_runs'>> = []
  for (const run of candidates) {
    const row = await claimAgentRunLease(db, settings, run.id)
    if (row) claimed.push(row)
  }
  return claimed
}

export function startAgentRunLeaseHeartbeat(
  db: Kysely<Database>,
  settings: Settings,
  runId: string,
) {
  return startAgentServerRunLeaseHeartbeat({
    runId,
    leaseTtlMs: settings.agentRunLeaseTtlMs,
    refresh: () => refreshAgentRunLease(db, settings, runId),
  })
}
