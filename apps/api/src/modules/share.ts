import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { hydrateModelConfig, type ModelResult } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { forbidden, notFound, unprocessable } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import type { CurrentUser } from './auth.js'
import { serializeShare } from './workspace.js'

function issueShareToken() {
  return randomBytes(36).toString('base64url')
}

export async function createVersionShare(
  db: Kysely<Database>,
  input: { workspace: Row<'workspaces'>; actor: CurrentUser; versionId: string },
) {
  const version = await db.selectFrom('workspace_versions').selectAll().where('id', '=', input.versionId).executeTakeFirst()
  if (!version) throw notFound('Version not found')
  if (version.workspace_id !== input.workspace.id) throw forbidden()
  if (version.kind !== 'release') throw unprocessable('Only release versions can be shared')

  const existing = await db
    .selectFrom('workspace_version_shares')
    .selectAll()
    .where('version_id', '=', version.id)
    .executeTakeFirst()
  const now = utcNow()
  if (existing && existing.revoked_at === null) {
    return existing
  }

  if (existing) {
    const token = issueShareToken()
    await db
      .updateTable('workspace_version_shares')
      .set({ share_token: token, revoked_at: null, updated_at: now })
      .where('id', '=', existing.id)
      .execute()
    await recordAudit(db, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: 'version_share_reissued',
      entityType: 'workspace_version_share',
      entityId: existing.id,
      meta: { versionId: version.id },
    })
    return db.selectFrom('workspace_version_shares').selectAll().where('id', '=', existing.id).executeTakeFirstOrThrow()
  }

  const shareId = newId()
  await db
    .insertInto('workspace_version_shares')
    .values({
      id: shareId,
      workspace_id: input.workspace.id,
      version_id: version.id,
      share_token: issueShareToken(),
      created_by: input.actor.id,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  await recordAudit(db, {
    workspaceId: input.workspace.id,
    actorId: input.actor.id,
    action: 'version_shared',
    entityType: 'workspace_version_share',
    entityId: shareId,
    meta: { versionId: version.id },
  })
  return db.selectFrom('workspace_version_shares').selectAll().where('id', '=', shareId).executeTakeFirstOrThrow()
}

export async function revokeVersionShare(
  db: Kysely<Database>,
  input: { workspace: Row<'workspaces'>; actor: CurrentUser; versionId: string },
) {
  const version = await db.selectFrom('workspace_versions').selectAll().where('id', '=', input.versionId).executeTakeFirst()
  if (!version) throw notFound('Version not found')
  if (version.workspace_id !== input.workspace.id) throw forbidden()
  const share = await db
    .selectFrom('workspace_version_shares')
    .selectAll()
    .where('version_id', '=', version.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (!share) throw notFound('Share link not found')

  await db
    .updateTable('workspace_version_shares')
    .set({ revoked_at: utcNow(), updated_at: utcNow() })
    .where('id', '=', share.id)
    .execute()
  await recordAudit(db, {
    workspaceId: input.workspace.id,
    actorId: input.actor.id,
    action: 'version_share_revoked',
    entityType: 'workspace_version_share',
    entityId: share.id,
    meta: { versionId: version.id },
  })
}

export async function getPublicSharePayload(db: Kysely<Database>, shareToken: string) {
  const row = await db
    .selectFrom('workspace_version_shares')
    .innerJoin('workspace_versions', 'workspace_versions.id', 'workspace_version_shares.version_id')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_version_shares.workspace_id')
    .select([
      'workspace_version_shares.id as share_id',
      'workspace_version_shares.share_token as share_token',
      'workspace_version_shares.created_at as shared_at',
      'workspaces.id as workspace_id',
      'workspaces.name as workspace_name',
      'workspace_versions.id as version_id',
      'workspace_versions.name as version_name',
      'workspace_versions.version_no as version_no',
      'workspace_versions.kind as version_kind',
      'workspace_versions.created_at as version_created_at',
      'workspace_versions.payload_json as payload_json',
      'workspace_versions.result_json as result_json',
    ])
    .where('workspace_version_shares.share_token', '=', shareToken)
    .where('workspace_version_shares.revoked_at', 'is', null)
    .executeTakeFirst()

  if (!row) throw notFound('Share link not found')

  return {
    shareId: row.share_id,
    shareToken: row.share_token,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    versionId: row.version_id,
    versionName: row.version_name,
    versionNo: row.version_no,
    versionKind: row.version_kind,
    createdAt: row.version_created_at,
    sharedAt: row.shared_at,
    config: hydrateModelConfig(parseJson<unknown>(row.payload_json, null)),
    result: parseJson<ModelResult>(row.result_json, { scenarios: [] }),
  }
}

export { serializeShare }
