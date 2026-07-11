import type { AgentActionDraft } from './host-profile/xox-runtime-items.js'
import type { AgentTurnContext } from './host-profile/xox-runtime-items.js'
import { getWorkspaceDraft, listVersions } from '../modules/workspace.js'

function versionPanelNavigation(reason: string) {
  return {
    type: 'navigation' as const,
    route: { mainTab: 'dashboard' as const, secondaryTab: 'overview' as const },
    panel: 'workspace' as const,
    reason,
  }
}

export function buildPublishReleaseDraft(ctx: AgentTurnContext, createShare: boolean) {
  return {
    kind: 'workspace.publish_release',
    title: createShare ? '确认发布并创建分享链接' : '确认发布正式版本',
    summary: createShare ? '发布当前草稿为不可变正式版本，并为该版本创建只读分享链接。' : '发布当前草稿为不可变正式版本。',
    targetLabel: ctx.workspace.name,
    riskLevel: 'high',
    details: [
      { label: '工作区', value: ctx.workspace.name },
      { label: '分享链接', value: createShare ? '发布后创建' : '不创建' },
    ],
    navigation: versionPanelNavigation('发布版本属于版本管理动作，需要打开版本管理面板。'),
    payload: { kind: 'release', createShare },
  } satisfies AgentActionDraft
}

export async function planSaveSnapshotAction(ctx: AgentTurnContext) {
  return {
    kind: 'workspace.save_snapshot',
    title: '确认保存草稿快照',
    summary: '将当前草稿保存为可恢复快照，不影响当前正式发布版。',
    targetLabel: ctx.workspace.name,
    riskLevel: 'low',
    details: [{ label: '工作区', value: ctx.workspace.name }],
    navigation: versionPanelNavigation('保存快照属于版本管理动作，需要打开版本管理面板。'),
    payload: { kind: 'snapshot' },
  } satisfies AgentActionDraft
}

export async function planResetDraftAction(ctx: AgentTurnContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  return {
    kind: 'workspace.reset_draft',
    title: '确认重置当前草稿',
    summary: '用默认模型覆盖当前草稿。历史版本不会被删除。',
    targetLabel: ctx.workspace.name,
    riskLevel: 'high',
    details: [
      { label: '工作区', value: ctx.workspace.name },
      { label: '当前修订', value: `${draft.revision}` },
    ],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'inputs', secondaryTab: 'revenue' },
      panel: 'workspace',
      reason: '重置草稿会覆盖当前输入，需要打开版本管理面板。',
    },
    payload: { revision: draft.revision },
  } satisfies AgentActionDraft
}

async function versionFromInput(ctx: AgentTurnContext, versionNo?: number | null, versionName?: string | null) {
  const versions = await listVersions(ctx.db, ctx.workspace)
  if (versionNo) return versions.find((item) => item.version_no === versionNo) ?? null
  if (versionName) return versions.find((item) => item.name === versionName || item.name.includes(versionName)) ?? null
  return versions.length === 1 ? versions[0]! : null
}

function buildRollbackVersionDraft(ctx: AgentTurnContext, version: Awaited<ReturnType<typeof versionFromInput>>) {
  if (!version) return null
  return {
    kind: 'workspace.rollback_version',
    title: '确认恢复版本到草稿',
    summary: `用“${version.name}”覆盖当前草稿，历史版本不会被改写。`,
    targetLabel: version.name,
    riskLevel: 'high',
    details: [
      { label: '版本', value: version.name },
      { label: '版本号', value: `${version.version_no}` },
    ],
    navigation: versionPanelNavigation('恢复版本会覆盖当前草稿，需要打开版本管理面板。'),
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

export async function planRollbackVersionAction(
  ctx: AgentTurnContext,
  input?: { versionNo?: number | null; versionName?: string | null },
) {
  const version = await versionFromInput(ctx, input?.versionNo, input?.versionName)
  return buildRollbackVersionDraft(ctx, version)
}

export async function planPromoteVersionAction(ctx: AgentTurnContext, input?: { versionNo?: number; versionName?: string }) {
  const version = await versionFromInput(ctx, input?.versionNo, input?.versionName)
  if (!version) return null
  return {
    kind: 'workspace.promote_version',
    title: '确认将快照发布为正式版',
    summary: `先用“${version.name}”覆盖当前草稿，再发布为新的不可变正式版本。历史版本不会被改写。`,
    targetLabel: version.name,
    riskLevel: 'high',
    details: [
      { label: '来源版本', value: version.name },
      { label: '版本号', value: `${version.version_no}` },
      { label: '审计说明', value: '执行会产生一次恢复草稿和一次发布版本记录。' },
    ],
    navigation: versionPanelNavigation('快照发布属于版本管理动作，需要打开版本管理面板。'),
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

export async function planDeleteVersionAction(ctx: AgentTurnContext, input?: { versionNo?: number; versionName?: string }) {
  const version = await versionFromInput(ctx, input?.versionNo, input?.versionName)
  if (!version) return null
  return {
    kind: 'workspace.delete_version',
    title: '确认删除版本',
    summary: `删除“${version.name}”。如果该版本已发布、已分享或被账期引用，系统会拒绝执行。`,
    targetLabel: version.name,
    riskLevel: 'high',
    details: [
      { label: '版本', value: version.name },
      { label: '版本号', value: `${version.version_no}` },
    ],
    navigation: versionPanelNavigation('删除版本属于版本管理动作，需要打开版本管理面板。'),
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

export async function planShareAction(ctx: AgentTurnContext, input?: { versionNo?: number; versionName?: string; revoke?: boolean }) {
  if (!input) return null
  const revoke = Boolean(input.revoke)
  const version = await versionFromInput(ctx, input.versionNo, input.versionName)
  if (!version) return null
  return {
    kind: revoke ? 'share.revoke' : 'share.create',
    title: revoke ? '确认撤销分享链接' : '确认创建分享链接',
    summary: revoke ? `撤销“${version.name}”当前有效分享链接。` : `为“${version.name}”创建只读分享链接。`,
    targetLabel: version.name,
    riskLevel: revoke ? 'medium' : 'high',
    details: [
      { label: '版本', value: version.name },
      { label: '版本号', value: `${version.version_no}` },
    ],
    navigation: versionPanelNavigation('分享链接属于版本管理动作，需要打开版本管理面板。'),
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}
