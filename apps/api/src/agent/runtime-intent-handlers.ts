import { answerWorkspaceDataQuestion } from './data-agent.js'
import type { ActionDraftBuilderHandlers } from './action-draft-builder.js'
import type { PlannerContext } from './planning-context.js'
import {
  planGenericLedgerCreateFromStep,
  planLedgerCreateFromFields,
  planLedgerRestoreFromStep,
  planLedgerUpdateFromStep,
  planLedgerVoidFromStep,
  planPeriodLockFromStep,
  planPlannedMemberIncomeBatch,
  planPlannedRelatedExpenseBatch,
} from './ledger-action-drafts.js'
import {
  buildPublishReleaseDraft,
  planDeleteVersionAction,
  planPromoteVersionAction,
  planResetDraftAction,
  planRollbackVersionAction,
  planSaveSnapshotAction,
  planShareAction,
} from './version-action-drafts.js'
import {
  planAddCostItemFromStep,
  planAddEmployeeFromStep,
  planAddShareholderFromStep,
  planAddStageCostTypeFromStep,
  planAddTeamMemberFromStep,
  planDeleteCostItemFromStep,
  planDeleteEmployeeFromStep,
  planDeleteShareholderFromStep,
  planDeleteStageCostTypeFromStep,
  planDeleteTeamMemberFromStep,
} from './model-structure-action-drafts.js'
import {
  planExportBundleRead,
  planImportBundleFromValue,
  planOnlineFactorFromFields,
  planWorkspacePatchFromStep,
  planWorkspaceRename,
} from './workspace-action-drafts.js'

function numericAlias(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'number') continue
    if (Number.isFinite(value)) return value
  }
  return null
}

export const runtimeIntentHandlers: ActionDraftBuilderHandlers<PlannerContext> = {
  'ledger.create_member_income': (ctx, step) => step.monthLabel && step.memberName
    ? planLedgerCreateFromFields(ctx, {
        monthLabel: step.monthLabel,
        memberName: step.memberName,
        offlineUnits: step.offlineUnits ?? 0,
        onlineUnits: step.onlineUnits ?? 0,
      })
    : null,
  'ledger.create_entry': planGenericLedgerCreateFromStep,
  'ledger.create_planned_member_income_batch': planPlannedMemberIncomeBatch,
  'ledger.create_planned_related_expense_batch': planPlannedRelatedExpenseBatch,
  'ledger.set_period_lock': planPeriodLockFromStep,
  'ledger.update_entry': planLedgerUpdateFromStep,
  'ledger.restore_entry': planLedgerRestoreFromStep,
  'ledger.void_entry': planLedgerVoidFromStep,
  'workspace.update_online_factor': (ctx, step) => {
    const factor = numericAlias(step.onlineSalesFactor, step.newFactor, step.factor, step.onlineFactor)
    return step.monthLabel && factor !== null
      ? planOnlineFactorFromFields(ctx, {
          monthLabel: step.monthLabel,
          factor,
          mode: step.mode === 'forecast' ? 'forecast' : 'write',
        })
      : null
  },
  'team_member.add': planAddTeamMemberFromStep,
  'team_member.delete': planDeleteTeamMemberFromStep,
  'employee.add': planAddEmployeeFromStep,
  'employee.delete': planDeleteEmployeeFromStep,
  'shareholder.add': planAddShareholderFromStep,
  'shareholder.delete': planDeleteShareholderFromStep,
  'cost_item.add': planAddCostItemFromStep,
  'cost_item.delete': planDeleteCostItemFromStep,
  'stage_cost_type.add': planAddStageCostTypeFromStep,
  'stage_cost_type.delete': planDeleteStageCostTypeFromStep,
  'workspace.patch_config': planWorkspacePatchFromStep,
  'workspace.rename': (ctx, step) => planWorkspaceRename(ctx, step.workspaceName),
  'workspace.save_snapshot': planSaveSnapshotAction,
  'workspace.publish_release': (ctx, step) => buildPublishReleaseDraft(ctx, Boolean(step.createShare)),
  'workspace.rollback_version': (ctx, step) => planRollbackVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.promote_version': (ctx, step) => planPromoteVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.delete_version': (ctx, step) => planDeleteVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.reset_draft': planResetDraftAction,
  'workspace.export_bundle': planExportBundleRead,
  'workspace.import_bundle': (ctx, step) => {
    const rawBundle = step.bundle && typeof step.bundle === 'object'
      ? step.bundle
      : ctx.providedWorkspaceBundle?.bundle
    return planImportBundleFromValue(ctx, rawBundle)
  },
  'share.create': (ctx, step) => planShareAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
    revoke: false,
  }),
  'share.revoke': (ctx, step) => planShareAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
    revoke: true,
  }),
  'data.query_workspace': answerWorkspaceDataQuestion,
}
