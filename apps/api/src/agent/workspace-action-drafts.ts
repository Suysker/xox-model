import { hydrateModelConfig, projectModel } from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import { exportWorkspaceBundle } from '../modules/workspace.js'
import type { AgentActionDraft } from './action-requests.js'
import type { ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'
import { currentDraftConfig } from './action-draft-utils.js'
import { cloneModelConfig, getConfigPath, setConfigPath } from './config-patch.js'
import type { PlannerContext } from './planning-context.js'

function modelWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'revenue' },
    reason,
  }
}

function workspacePanelNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'dashboard', secondaryTab: 'overview' },
    panel: 'workspace',
    reason,
  }
}

export async function planOnlineFactorFromFields(
  ctx: PlannerContext,
  input: { monthLabel: string; factor: number; mode: 'forecast' | 'write' },
) {
  const { draft, config } = await currentDraftConfig(ctx)
  const monthIndex = config.months.findIndex((month) => month.label === input.monthLabel)
  if (monthIndex < 0) return null
  const nextConfig = {
    ...config,
    months: config.months.map((month, index) => (index === monthIndex ? { ...month, onlineSalesFactor: input.factor } : month)),
  }
  const projected = projectModel(nextConfig)
  const baseMonth = projected.scenarios.find((scenario) => scenario.key === 'base')?.months[monthIndex]
  const navigation = modelWorkbenchNavigation('线上系数属于收入引擎设置，先打开调模型页面供核对。')

  if (input.mode === 'forecast') {
    return {
      title: '试算线上系数',
      message: `${input.monthLabel}线上系数试算为 ${input.factor} 时，基准场景该月收入约 ${Math.round(baseMonth?.grossSales ?? 0)} 元，利润约 ${Math.round(baseMonth?.monthlyProfit ?? 0)} 元。未修改草稿。`,
      navigation,
      status: 'executed' as const,
    } satisfies ReadDraft
  }

  return {
    kind: 'workspace.update_draft',
    title: '确认修改线上系数',
    summary: `将${input.monthLabel}线上系数改为 ${input.factor} 并保存到当前草稿。`,
    targetLabel: input.monthLabel,
    riskLevel: 'medium',
    details: [
      { label: '月份', value: input.monthLabel },
      { label: '原线上系数', value: `${config.months[monthIndex]?.onlineSalesFactor ?? 0}` },
      { label: '新线上系数', value: `${input.factor}` },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
    },
  } satisfies AgentActionDraft
}

export async function planWorkspacePatch(
  ctx: PlannerContext,
  patches: Array<{ path: string; value: unknown; label?: string }>,
) {
  if (patches.length === 0) return null
  const { draft, config } = await currentDraftConfig(ctx)
  const nextConfig = cloneModelConfig(config)
  const details = []

  for (const patch of patches) {
    const oldValue = getConfigPath(nextConfig, patch.path)
    setConfigPath(nextConfig, patch.path, patch.value)
    details.push({
      label: patch.label ?? patch.path,
      value: `${JSON.stringify(oldValue)} -> ${JSON.stringify(patch.value)}`,
    })
  }

  const normalized = hydrateModelConfig(nextConfig)
  return {
    kind: 'workspace.update_draft',
    title: '确认修改模型草稿',
    summary: `将 ${patches.length} 项模型输入保存到当前草稿。`,
    targetLabel: ctx.workspace.name,
    riskLevel: 'medium',
    details: details.slice(0, 8),
    navigation: modelWorkbenchNavigation('模型草稿修改需要打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches,
    },
  } satisfies AgentActionDraft
}

export function planWorkspaceRename(ctx: PlannerContext, workspaceName: unknown) {
  const nextName = typeof workspaceName === 'string' ? workspaceName.trim() : ''
  if (!nextName) return null
  if (nextName === ctx.workspace.name) {
    return {
      title: '工作区名称未变化',
      message: `当前工作区已经叫“${nextName}”。`,
      status: 'info',
      navigation: workspacePanelNavigation('工作区改名需要打开版本管理面板供核对。'),
    } satisfies ReadDraft
  }
  return {
    kind: 'workspace.rename',
    title: '确认修改工作区名称',
    summary: `将工作区从“${ctx.workspace.name}”改名为“${nextName}”。`,
    targetLabel: nextName,
    riskLevel: 'medium',
    details: [
      { label: '原名称', value: ctx.workspace.name },
      { label: '新名称', value: nextName },
    ],
    navigation: workspacePanelNavigation('工作区改名需要打开版本管理面板供核对。'),
    payload: { workspaceName: nextName },
  } satisfies AgentActionDraft
}

export async function planExportBundleRead(ctx: PlannerContext) {
  const bundle = await exportWorkspaceBundle(ctx.db, ctx.workspace)
  return {
    title: '导出工作区 Bundle',
    message: `已生成当前工作区 bundle：${bundle.workspaceName}，包含 ${bundle.snapshots.length} 个历史版本。完整 JSON 可通过 /api/v1/workspace/bundle 获取；本次 Agent 未修改业务数据。`,
    navigation: workspacePanelNavigation('导出工作区属于版本管理动作，需要打开版本管理面板。'),
    status: 'executed',
  } satisfies ReadDraft
}

export function planImportBundleFromValue(ctx: PlannerContext, rawBundle: unknown) {
  if (!rawBundle || typeof rawBundle !== 'object') return null
  const bundle = rawBundle as { workspaceName?: unknown; currentConfig?: unknown; snapshots?: unknown[] }
  if (typeof bundle.workspaceName !== 'string' || !bundle.currentConfig) return null
  return {
    kind: 'workspace.import_bundle',
    title: '确认导入工作区 Bundle',
    summary: `用导入 bundle “${bundle.workspaceName}” 的当前模型覆盖当前草稿。历史版本不会导入。`,
    targetLabel: bundle.workspaceName,
    riskLevel: 'high',
    details: [
      { label: '导入工作区', value: bundle.workspaceName },
      { label: '历史版本', value: `${Array.isArray(bundle.snapshots) ? bundle.snapshots.length : 0} 个（本次不导入）` },
    ],
    navigation: workspacePanelNavigation('导入 bundle 会覆盖当前草稿，需要打开版本管理面板。'),
    payload: { bundle },
  } satisfies AgentActionDraft
}

export function planWorkspacePatchFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  return step.patches ? planWorkspacePatch(ctx, step.patches) : null
}
