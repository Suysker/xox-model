import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { unprocessable } from '../core/http.js'
import type { CurrentUser } from '../modules/auth.js'
import {
  deleteVersion,
  getWorkspaceDraft,
  importWorkspaceBundle,
  publishVersion,
  rollbackToVersion,
  saveDraft,
} from '../modules/workspace.js'
import {
  createActualEntry,
  restoreEntry,
  setPeriodStatus,
  updateActualEntry,
  voidEntry,
} from '../modules/ledger.js'
import { createVersionShare, revokeVersionShare } from '../modules/share.js'

export async function executeAgentTool(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  action: Row<'agent_action_requests'>,
) {
  const payload = parseJson<any>(action.payload_json, {})

  if (action.kind === 'ledger.create_entry') {
    return createActualEntry(db, { workspace, actor: user, ...payload })
  }
  if (action.kind === 'ledger.update_entry') {
    return updateActualEntry(db, { workspace, actor: user, entryId: payload.entryId, ...payload })
  }
  if (action.kind === 'ledger.void_entry') {
    await voidEntry(db, workspace, payload.entryId, user.id)
    return { ok: true }
  }
  if (action.kind === 'ledger.restore_entry') {
    await restoreEntry(db, workspace, payload.entryId, user.id)
    return { ok: true }
  }
  if (action.kind === 'ledger.lock_period') {
    return setPeriodStatus(db, workspace, payload.periodId, user.id, 'locked')
  }
  if (action.kind === 'ledger.unlock_period') {
    return setPeriodStatus(db, workspace, payload.periodId, user.id, 'open')
  }
  if (action.kind === 'workspace.update_draft') {
    return saveDraft(db, { workspace, actor: user, revision: payload.revision, workspaceName: payload.workspaceName, config: hydrateModelConfig(payload.config) })
  }
  if (action.kind === 'workspace.save_snapshot') {
    return publishVersion(db, { workspace, actor: user, kind: 'snapshot' })
  }
  if (action.kind === 'workspace.publish_release') {
    const version = await publishVersion(db, { workspace, actor: user, kind: 'release' })
    if (!payload.createShare) return { version }
    return { version, share: await createVersionShare(db, { workspace: { ...workspace, active_version_id: version.id }, actor: user, versionId: version.id }) }
  }
  if (action.kind === 'workspace.rollback_version') {
    return rollbackToVersion(db, { workspace, actor: user, versionId: payload.versionId })
  }
  if (action.kind === 'workspace.delete_version') {
    await deleteVersion(db, workspace, payload.versionId)
    return { ok: true }
  }
  if (action.kind === 'workspace.reset_draft') {
    const draft = await getWorkspaceDraft(db, workspace)
    return saveDraft(db, { workspace, actor: user, revision: draft.revision, workspaceName: '默认工作区', config: createProductDefaultModel() })
  }
  if (action.kind === 'workspace.import_bundle') {
    return importWorkspaceBundle(db, { workspace, actor: user, bundle: payload.bundle })
  }
  if (action.kind === 'share.create') {
    return createVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
  }
  if (action.kind === 'share.revoke') {
    await revokeVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
    return { ok: true }
  }

  throw unprocessable(`Unsupported agent action: ${action.kind}`)
}
