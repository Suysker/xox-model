import type { Kysely } from 'kysely'
import {
  buildForecastLineItems,
  hydrateModelConfig,
  projectModel,
  type ModelConfig,
  type ModelResult,
} from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { conflict, forbidden, notFound } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import type { CurrentUser } from './auth.js'

export async function getWorkspaceForUser(db: Kysely<Database>, user: CurrentUser) {
  const workspace = await db
    .selectFrom('workspaces')
    .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
    .selectAll('workspaces')
    .where('workspace_members.user_id', '=', user.id)
    .executeTakeFirst()

  if (!workspace) {
    throw notFound('Workspace not found')
  }

  return workspace
}

export async function getWorkspaceDraft(db: Kysely<Database>, workspace: Row<'workspaces'>) {
  const draft = await db.selectFrom('workspace_drafts').selectAll().where('workspace_id', '=', workspace.id).executeTakeFirst()
  if (!draft) {
    throw notFound('Draft not found')
  }

  return draft
}

export function draftContext(draft: Row<'workspace_drafts'>) {
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const result = draft.result_json ? parseJson<ModelResult>(draft.result_json, projectModel(config)) : projectModel(config)
  return { config, result }
}

export function serializeDraft(workspace: Row<'workspaces'>, draft: Row<'workspace_drafts'>) {
  const { config, result } = draftContext(draft)
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    revision: draft.revision,
    config,
    result,
    lastAutosavedAt: draft.last_autosaved_at,
  }
}

export async function saveDraft(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    actor: CurrentUser
    revision: number
    workspaceName: string
    config: ModelConfig
  },
) {
  const draft = await getWorkspaceDraft(db, input.workspace)
  if (draft.revision !== input.revision) {
    await recordAudit(db, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: 'workspace.draft_autosave',
      status: 'failed',
      entityType: 'workspace_draft',
      entityId: input.workspace.id,
      meta: { expectedRevision: input.revision, actualRevision: draft.revision, reason: 'revision_conflict' },
    })
    throw conflict('Draft revision conflict')
  }

  const now = utcNow()
  const result = projectModel(input.config)
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('workspaces')
      .set({ name: input.workspaceName, updated_at: now })
      .where('id', '=', input.workspace.id)
      .execute()
    await trx
      .updateTable('workspace_drafts')
      .set({
        revision: draft.revision + 1,
        config_json: jsonString(input.config),
        result_json: jsonString(result),
        last_autosaved_at: now,
        updated_by: input.actor.id,
        updated_at: now,
      })
      .where('workspace_id', '=', input.workspace.id)
      .execute()
    await syncPeriodsWithCurrentDraft(trx, input.workspace.id, result)
    await trx
      .insertInto('workspace_events')
      .values({
        id: newId(),
        workspace_id: input.workspace.id,
        actor_id: input.actor.id,
        event_type: 'draft_autosaved',
        meta_json: jsonString({ revision: draft.revision + 1 }),
        created_at: now,
      })
      .execute()
    await recordAudit(trx, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: 'workspace.draft_autosave',
      entityType: 'workspace_draft',
      entityId: input.workspace.id,
      meta: { revision: draft.revision + 1 },
    })
  })

  const workspace = await db.selectFrom('workspaces').selectAll().where('id', '=', input.workspace.id).executeTakeFirstOrThrow()
  const nextDraft = await getWorkspaceDraft(db, workspace)
  return serializeDraft(workspace, nextDraft)
}

async function nextVersionNumber(db: Kysely<Database>, workspaceId: string) {
  const row = await db
    .selectFrom('workspace_versions')
    .select(({ fn }) => fn.max<number>('version_no').as('max_version_no'))
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst()
  return (row?.max_version_no ?? 0) + 1
}

export async function listVersions(db: Kysely<Database>, workspace: Row<'workspaces'>) {
  return db
    .selectFrom('workspace_versions')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .orderBy('version_no', 'desc')
    .execute()
}

export async function serializeVersion(db: Kysely<Database>, version: Row<'workspace_versions'>) {
  const share = await db
    .selectFrom('workspace_version_shares')
    .selectAll()
    .where('version_id', '=', version.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  return {
    id: version.id,
    name: version.name,
    kind: version.kind as 'snapshot' | 'release',
    versionNo: version.version_no,
    sourceVersionId: version.source_version_id,
    createdAt: version.created_at,
    config: hydrateModelConfig(parseJson<unknown>(version.payload_json, null)),
    activeShare: share ? serializeShare(share) : null,
  }
}

export function serializeShare(share: Row<'workspace_version_shares'>) {
  return {
    id: share.id,
    versionId: share.version_id,
    shareToken: share.share_token,
    sharePath: `/shared/${encodeURIComponent(share.share_token)}`,
    createdAt: share.created_at,
    updatedAt: share.updated_at,
  }
}

export async function publishVersion(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    actor: CurrentUser
    kind: 'snapshot' | 'release'
    name?: string | null | undefined
    note?: string | null | undefined
  },
) {
  const draft = await getWorkspaceDraft(db, input.workspace)
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const result = projectModel(config)
  const versionNo = await nextVersionNumber(db, input.workspace.id)
  const versionId = newId()
  const now = utcNow()

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('workspace_versions')
      .values({
        id: versionId,
        workspace_id: input.workspace.id,
        version_no: versionNo,
        name: input.name ?? (input.kind === 'snapshot' ? `快照 ${versionNo}` : `发布版 ${versionNo}`),
        kind: input.kind,
        note: input.note ?? null,
        baseline_scenario: 'base',
        source_draft_revision: draft.revision,
        source_version_id: input.workspace.active_version_id,
        payload_json: jsonString(config),
        result_json: jsonString(result),
        created_by: input.actor.id,
        created_at: now,
      })
      .execute()

    const lineItems = buildForecastLineItems(config)
    for (const fact of lineItems) {
      await trx
        .insertInto('forecast_line_item_facts')
        .values({
          id: newId(),
          workspace_id: input.workspace.id,
          version_id: versionId,
          scenario_key: fact.scenarioKey,
          month_index: fact.monthIndex,
          month_label: fact.monthLabel,
          subject_key: fact.subjectKey,
          subject_name: fact.subjectName,
          subject_type: fact.subjectType,
          subject_group: fact.subjectGroup,
          entity_type: fact.entityType ?? null,
          entity_id: fact.entityId ?? null,
          planned_amount: fact.plannedAmount,
        })
        .execute()
    }

    for (const scenario of result.scenarios) {
      for (const month of scenario.months) {
        await trx
          .insertInto('forecast_month_facts')
          .values({
            id: newId(),
            workspace_id: input.workspace.id,
            version_id: versionId,
            scenario_key: scenario.key,
            month_index: month.monthIndex,
            month_label: month.label,
            planned_revenue: month.grossSales,
            planned_cost: month.totalCost,
            planned_profit: month.monthlyProfit,
          })
          .execute()
      }
    }

    await syncPeriodsWithCurrentDraft(trx, input.workspace.id, result)
    if (input.kind === 'release') {
      await trx.updateTable('workspaces').set({ active_version_id: versionId, updated_at: now }).where('id', '=', input.workspace.id).execute()
    }
    await trx
      .insertInto('workspace_events')
      .values({
        id: newId(),
        workspace_id: input.workspace.id,
        actor_id: input.actor.id,
        event_type: `version_${input.kind}ed`,
        meta_json: jsonString({ versionId, versionNo }),
        created_at: now,
      })
      .execute()
    await recordAudit(trx, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: `workspace.version_${input.kind}`,
      entityType: 'workspace_version',
      entityId: versionId,
      meta: { versionNo, sourceDraftRevision: draft.revision },
    })
  })

  return db.selectFrom('workspace_versions').selectAll().where('id', '=', versionId).executeTakeFirstOrThrow()
}

export async function rollbackToVersion(
  db: Kysely<Database>,
  input: { workspace: Row<'workspaces'>; actor: CurrentUser; versionId: string },
) {
  const version = await db.selectFrom('workspace_versions').selectAll().where('id', '=', input.versionId).executeTakeFirst()
  if (!version) throw notFound('Version not found')
  if (version.workspace_id !== input.workspace.id) throw forbidden()

  const config = hydrateModelConfig(parseJson<unknown>(version.payload_json, null))
  const result = projectModel(config)
  const draft = await getWorkspaceDraft(db, input.workspace)
  const now = utcNow()
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('workspace_drafts')
      .set({
        revision: draft.revision + 1,
        config_json: jsonString(config),
        result_json: jsonString(result),
        last_autosaved_at: now,
        updated_by: input.actor.id,
        updated_at: now,
      })
      .where('workspace_id', '=', input.workspace.id)
      .execute()
    await syncPeriodsWithCurrentDraft(trx, input.workspace.id, result)
    await trx
      .insertInto('workspace_events')
      .values({
        id: newId(),
        workspace_id: input.workspace.id,
        actor_id: input.actor.id,
        event_type: 'draft_rolled_back',
        meta_json: jsonString({ versionId: version.id, revision: draft.revision + 1 }),
        created_at: now,
      })
      .execute()
    await recordAudit(trx, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: 'workspace.rollback',
      entityType: 'workspace_version',
      entityId: version.id,
      meta: { draftRevision: draft.revision + 1 },
    })
  })

  const nextDraft = await getWorkspaceDraft(db, input.workspace)
  return serializeDraft(input.workspace, nextDraft)
}

export async function deleteVersion(db: Kysely<Database>, workspace: Row<'workspaces'>, versionId: string) {
  const version = await db.selectFrom('workspace_versions').selectAll().where('id', '=', versionId).executeTakeFirst()
  if (!version) throw notFound('Version not found')
  if (version.workspace_id !== workspace.id) throw forbidden()
  if (workspace.active_version_id === version.id) throw conflict('Active release cannot be deleted')
  const activeShare = await db
    .selectFrom('workspace_version_shares')
    .select('id')
    .where('version_id', '=', version.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (activeShare) throw conflict('Version has an active share link')
  const period = await db.selectFrom('ledger_periods').select('id').where('baseline_version_id', '=', version.id).executeTakeFirst()
  if (period) throw conflict('Version is used by a ledger period')

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('forecast_month_facts').where('version_id', '=', version.id).execute()
    await trx.deleteFrom('forecast_line_item_facts').where('version_id', '=', version.id).execute()
    await recordAudit(trx, {
      workspaceId: workspace.id,
      action: 'workspace.version_deleted',
      entityType: 'workspace_version',
      entityId: version.id,
      meta: { versionNo: version.version_no, kind: version.kind },
    })
    await trx.deleteFrom('workspace_versions').where('id', '=', version.id).execute()
  })
}

export async function syncPeriodsWithCurrentDraft(db: Kysely<Database>, workspaceId: string, result: ModelResult) {
  const existing = await db.selectFrom('ledger_periods').selectAll().where('workspace_id', '=', workspaceId).execute()
  const existingByMonth = new Map(existing.map((period) => [period.month_index, period]))
  const scenario = result.scenarios.find((item) => item.key === 'base') ?? result.scenarios[0]
  const months = scenario?.months ?? []
  const now = utcNow()

  for (const period of existing) {
    if (period.baseline_version_id !== null) {
      await db.updateTable('ledger_periods').set({ baseline_version_id: null, updated_at: now }).where('id', '=', period.id).execute()
    }
  }

  for (const month of months) {
    const period = existingByMonth.get(month.monthIndex)
    if (!period) {
      await db
        .insertInto('ledger_periods')
        .values({
          id: newId(),
          workspace_id: workspaceId,
          baseline_version_id: null,
          month_index: month.monthIndex,
          month_label: month.label,
          status: 'open',
          created_at: now,
          updated_at: now,
        })
        .execute()
    } else if (period.month_label !== month.label) {
      await db.updateTable('ledger_periods').set({ month_label: month.label, updated_at: now }).where('id', '=', period.id).execute()
    }
  }
}
