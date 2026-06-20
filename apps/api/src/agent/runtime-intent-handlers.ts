import {
  buildToolSurfaceDiscoveryObservation,
  buildToolSurfaceManifestSearchObservation,
} from '@agentic-os/core'
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
  planOperatingModelFromStep,
  planWorkspacePatchFromStep,
  planWorkspaceRename,
} from './workspace-action-drafts.js'
import { rememberAgentMemory, redactSecretLikeContent } from './memory.js'
import { runMemoryGetTool, runMemorySearchTool } from './memory/memory-tools.js'
import { planSandboxRunCode } from './sandbox-service.js'
import { AGENT_TOOL_REGISTRY } from './tool-catalog.js'
import { buildToolManifests } from './tool-surface-manifest.js'
import type { ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'

function numericAlias(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'number') continue
    if (Number.isFinite(value)) return value
  }
  return null
}

function stringAlias(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

async function rememberFromToolCall(ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const value = typeof step.value === 'string' ? step.value : ''
  const input = {
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    value,
    ...(typeof step.kind === 'string' ? { kind: step.kind } : {}),
    ...(typeof step.key === 'string' ? { key: step.key } : {}),
    ...(typeof step.confidence === 'number' ? { confidence: step.confidence } : {}),
  }
  const result = await rememberAgentMemory(input)
  if (result.memory) {
    return {
      title: '已保存记忆',
      message: `已保存当前工作区记忆：${redactSecretLikeContent(result.memory.value)}`,
      status: 'executed',
    }
  }
  return {
    title: '未保存记忆',
    message: result.rejectedReason === 'secret'
      ? '这条内容看起来包含 API key、token、密码或验证码，已拒绝写入长期记忆。'
      : '没有识别到可保存的长期记忆内容。',
    status: 'info',
  }
}

async function runToolDiscovery(_ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const input: Parameters<typeof buildToolSurfaceDiscoveryObservation>[0] = {
    manifests: buildToolManifests(AGENT_TOOL_REGISTRY),
  }
  const query = stringAlias(step.query, step.question)
  const toolNames = stringArray(step.toolNames)
  const maxResults = numericAlias(step.maxResults, step.limit)
  if (query) input.query = query
  if (toolNames.length > 0) input.toolNames = toolNames
  if (maxResults !== null) input.maxResults = maxResults

  const observation = buildToolSurfaceDiscoveryObservation(input)
  const displayPreview = observation.matchedToolNames.length > 0
    ? `找到 ${observation.matchedToolNames.length} 个可物化工具：${observation.matchedToolNames.join('、')}`
    : '没有找到匹配的可物化工具。'

  return {
    title: '查找可用工具',
    message: displayPreview,
    readKind: 'tool_observation',
    status: 'executed',
    displayPreview,
    modelContent: JSON.stringify(observation),
    observationStatus: 'completed',
    observationOutcome: 'completed_valid',
  }
}

async function runManifestRg(_ctx: PlannerContext, step: RuntimePlannerStep): Promise<ReadDraft> {
  const input: Parameters<typeof buildToolSurfaceManifestSearchObservation>[0] = {
    manifests: buildToolManifests(AGENT_TOOL_REGISTRY),
  }
  const pattern = stringAlias(step.pattern, step.query)
  const maxMatches = numericAlias(step.maxMatches, step.max_matches, step.limit)
  const contextLines = numericAlias(step.contextLines, step.context_lines)
  const paths = stringArray(step.paths)
  if (pattern) input.pattern = pattern
  if (step.regex === true) input.regex = true
  if (maxMatches !== null) input.maxMatches = maxMatches
  if (contextLines !== null) input.contextLines = contextLines
  if (paths.length > 0) input.paths = paths

  const observation = buildToolSurfaceManifestSearchObservation(input)
  const displayPreview = observation.matches.length > 0
    ? `找到 ${observation.matches.length} 个工具文档匹配。`
    : '没有找到匹配的工具文档。'

  return {
    title: '搜索工具文档',
    message: displayPreview,
    readKind: 'tool_observation',
    status: 'executed',
    displayPreview,
    modelContent: JSON.stringify(observation),
    observationStatus: 'completed',
    observationOutcome: 'completed_valid',
  }
}

export const runtimeIntentHandlers: ActionDraftBuilderHandlers<PlannerContext> = {
  'ledger.create_member_income': (ctx, step) => {
    const memberName = typeof step.memberName === 'string' && step.memberName.trim()
      ? step.memberName.trim()
      : null
    return memberName
      ? planLedgerCreateFromFields(ctx, {
        monthLabel: typeof step.monthLabel === 'string' ? step.monthLabel : null,
        memberName,
        offlineUnits: step.offlineUnits ?? 0,
        onlineUnits: step.onlineUnits ?? 0,
        occurredAt: typeof step.occurredAt === 'string'
          ? step.occurredAt
          : typeof step.date === 'string'
            ? step.date
            : null,
      })
      : null
  },
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
  'workspace.configure_operating_model': planOperatingModelFromStep,
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
  'memory.search': runMemorySearchTool,
  'memory.get': runMemoryGetTool,
  'memory.remember': rememberFromToolCall,
  'data.query_workspace': answerWorkspaceDataQuestion,
  'sandbox.run_code': (ctx, step) => planSandboxRunCode(ctx, step, runtimeIntentHandlers),
  'tool.discover': runToolDiscovery,
  'tool.rg': runManifestRg,
}
