import type { Kysely, Transaction } from 'kysely'
import type { AgentScope, JsonValue } from '@agentic-os/contracts'
import type {
  AgentLoopCommitResult,
  AgentLoopStateV4,
  AgentLoopTransitionRecordV2,
} from '@agentic-os/core'
import {
  createAgentServerDurableControlPlane,
  AgentServerDurableRunJournal,
  AgentServerDurableRuntimeExecutionStore,
  type AgentServerControlRecord,
  type AgentServerControlRecordBackend,
} from '@agentic-os/server'
import type { Database, Row } from '../../db/schema.js'
import { jsonString, parseJson } from '../../db/database.js'
import { newId } from '../../core/security.js'
import { utcNow } from '../../core/time.js'

export function createXoxHarnessControlInfrastructure(db: Kysely<Database>) {
  const backend = new XoxHarnessControlRecordBackend(db)
  return {
    control: createAgentServerDurableControlPlane(backend),
    runtimeExecutionStore: new AgentServerDurableRuntimeExecutionStore(backend),
    traceJournal: new AgentServerDurableRunJournal(backend),
  }
}

class XoxHarnessControlRecordBackend implements AgentServerControlRecordBackend {
  public constructor(private readonly db: Kysely<Database>) {}

  public async load<T extends JsonValue>(input: {
    scope: AgentScope
    collection: string
    key: string
  }): Promise<AgentServerControlRecord<T> | null> {
    const row = await scopedQuery(this.db, input.scope, input.collection, input.key).executeTakeFirst()
    return row === undefined ? null : fromRow<T>(row, input.scope)
  }

  public async create<T extends JsonValue>(record: AgentServerControlRecord<T>): Promise<'created' | 'existing'> {
    const inserted = await this.db
      .insertInto('agent_harness_control_records')
      .values(toRow(record))
      .onConflict((conflict) => conflict
        .columns(['tenant_id', 'workspace_id', 'user_id', 'collection_name', 'record_key'])
        .doNothing())
      .returning('id')
      .executeTakeFirst()
    return inserted === undefined ? 'existing' : 'created'
  }

  public async compareAndSet<T extends JsonValue>(input: {
    scope: AgentScope
    collection: string
    key: string
    expectedVersion: number
    next: AgentServerControlRecord<T>
  }): Promise<'committed' | 'version_conflict'> {
    const result = await scopedUpdate(this.db, input.scope, input.collection, input.key)
      .where('version_no', '=', input.expectedVersion)
      .set({
        version_no: input.next.version,
        value_json: jsonString(input.next.value),
        updated_at: input.next.updatedAt,
      })
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1 ? 'committed' : 'version_conflict'
  }

  public async list<T extends JsonValue>(input: {
    scope: AgentScope
    collection: string
    limit: number
  }): Promise<Array<AgentServerControlRecord<T>>> {
    const rows = await scopedCollectionQuery(this.db, input.scope, input.collection)
      .orderBy('updated_at', 'asc')
      .orderBy('record_key', 'asc')
      .limit(Math.max(0, Math.trunc(input.limit)))
      .execute()
    return rows.map((row) => fromRow<T>(row, input.scope))
  }

  public async commitLoop(input: {
    expectedStateVersion: number
    state: AgentLoopStateV4
    transition: AgentLoopTransitionRecordV2
  }): Promise<AgentLoopCommitResult> {
    return this.db.transaction().execute(async (transaction) => {
      const transitionCollection = `loop_transition:${input.state.runId}`
      const existingTransition = await scopedQuery(
        transaction,
        input.state.scope,
        transitionCollection,
        input.transition.transitionId,
      ).executeTakeFirst()
      if (existingTransition !== undefined) return 'already_committed'

      const current = await scopedQuery(
        transaction,
        input.state.scope,
        'loop_state',
        input.state.runId,
      ).executeTakeFirst()
      const currentVersion = current?.version_no ?? 0
      if (currentVersion !== input.expectedStateVersion ||
          input.state.stateVersion !== input.expectedStateVersion + 1) {
        return 'version_conflict'
      }

      const now = utcNow()
      if (current === undefined) {
        await transaction.insertInto('agent_harness_control_records').values(toRow({
          scope: input.state.scope,
          collection: 'loop_state',
          key: input.state.runId,
          version: input.state.stateVersion,
          value: input.state as AgentLoopStateV4 & JsonValue,
          createdAt: now,
          updatedAt: now,
        })).execute()
      } else {
        const updated = await scopedUpdate(
          transaction,
          input.state.scope,
          'loop_state',
          input.state.runId,
        )
          .where('version_no', '=', input.expectedStateVersion)
          .set({
            version_no: input.state.stateVersion,
            value_json: jsonString(input.state),
            updated_at: now,
          })
          .executeTakeFirst()
        if (Number(updated.numUpdatedRows) !== 1) return 'version_conflict'
      }

      await transaction.insertInto('agent_harness_control_records').values(toRow({
        scope: input.state.scope,
        collection: transitionCollection,
        key: input.transition.transitionId,
        version: 1,
        value: input.transition as AgentLoopTransitionRecordV2 & JsonValue,
        createdAt: now,
        updatedAt: now,
      })).execute()
      return 'committed'
    })
  }
}

type XoxDb = Kysely<Database> | Transaction<Database>

function scopedCollectionQuery(db: XoxDb, scope: AgentScope, collection: string) {
  return db
    .selectFrom('agent_harness_control_records')
    .selectAll()
    .where('tenant_id', '=', scope.tenantId)
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', scope.userId ?? '')
    .where('collection_name', '=', collection)
}

function scopedQuery(db: XoxDb, scope: AgentScope, collection: string, key: string) {
  return scopedCollectionQuery(db, scope, collection).where('record_key', '=', key)
}

function scopedUpdate(db: XoxDb, scope: AgentScope, collection: string, key: string) {
  return db
    .updateTable('agent_harness_control_records')
    .where('tenant_id', '=', scope.tenantId)
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', scope.userId ?? '')
    .where('collection_name', '=', collection)
    .where('record_key', '=', key)
}

function toRow<T extends JsonValue>(record: AgentServerControlRecord<T>) {
  return {
    id: newId(),
    tenant_id: record.scope.tenantId,
    workspace_id: record.scope.workspaceId,
    user_id: record.scope.userId ?? '',
    collection_name: record.collection,
    record_key: record.key,
    version_no: record.version,
    value_json: jsonString(record.value),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

function fromRow<T extends JsonValue>(
  row: Row<'agent_harness_control_records'>,
  scope: AgentScope,
): AgentServerControlRecord<T> {
  return {
    scope: structuredClone(scope),
    collection: row.collection_name,
    key: row.record_key,
    version: row.version_no,
    value: parseJson<T>(row.value_json, null as T),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
