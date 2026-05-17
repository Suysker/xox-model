import type { Kysely } from 'kysely'
import { hydrateModelConfig, projectModel } from '@xox/domain'
import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import type { CurrentUser } from '../modules/auth.js'
import { exportWorkspaceBundle } from '../modules/workspace.js'
import { redactSecretLikeContent } from './memory.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { RuntimePlanError, RuntimePlanResult, RuntimeStreamEvent } from './runtime/runtime-adapter.js'
import { assertAgentRunLease } from './run-lease.js'
import { agentThreadEvents } from './thread-events.js'
import { AGENT_TOOL_REGISTRY } from './tool-catalog.js'
import { extractWorkspaceBundleArtifact, type ParsedWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'
import { addRunEvent } from './run-events.js'
import { addAgentActionRequest, addAgentPlanStep, type AgentActionDraft } from './action-requests.js'
import { answerWorkspaceDataQuestion } from './data-agent.js'
import { cloneModelConfig, getConfigPath, setConfigPath } from './config-patch.js'
import { buildAgentContextPack } from './context-pack.js'
import {
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
  type ReadDraft,
  type RuntimePlannerStep,
} from './action-draft-builder.js'
import {
  currentDraftConfig,
} from './action-draft-utils.js'
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

export type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  abortSignal?: AbortSignal
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}

const PROVIDER_STREAM_DELTA_LIMIT = 240
const PROVIDER_STREAM_PREVIEW_LIMIT = 700

function modelToolCallRequiredRead(error?: RuntimePlanError | null): ReadDraft {
  if (error?.kind === 'missing_api_key') {
    return {
      title: '模型 API key 未配置',
      message: '当前已选择真实模型 provider，但没有可用 API key。请在模型配置里重新填写该 provider 的 API key；如果刚从 qwen 切到 DeepSeek，不要留空沿用旧 key。',
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_http_error') {
    const authFailed = error.statusCode === 401 || error.statusCode === 403
    return {
      title: authFailed ? '模型服务认证失败' : '模型服务请求失败',
      message: authFailed
        ? `模型服务认证失败：模型服务返回 HTTP ${error.statusCode}，当前保存的 API key 可能不是这个 provider 的 key，或已经失效。请重新保存 DeepSeek/Qwen/Doubao 对应的 API key。${error.message ? ` Provider 提示：${error.message}` : ''}`
        : `模型服务返回 HTTP ${error.statusCode ?? '错误'}。请检查 base URL、model 名称和 provider 配置。${error.message ? ` Provider 提示：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  if (error?.kind === 'provider_network_error') {
    return {
      title: '无法连接模型服务',
      message: `无法连接当前 provider 的 Chat Completions 接口。请检查 base URL 是否可访问，以及本地代理/网络设置。${error.message ? ` 错误：${error.message}` : ''}`,
      status: 'failed',
    }
  }

  return {
    title: '模型没有返回内容',
    message: '模型这轮没有返回可展示内容，也没有调用工具。系统没有生成任何写入动作；请换一种说法重试。',
    status: 'info',
  }
}

function providerAssistantTextRead(text: string): ReadDraft {
  const message = redactSecretLikeContent(text).trim().slice(0, 4000)
  return {
    title: '模型回复',
    message: message || '模型这轮没有返回可展示内容。',
    status: 'executed',
  }
}

function safeProviderStreamValue(value: string, maxLength: number) {
  return redactSecretLikeContent(value).slice(0, maxLength)
}

function providerStreamEventPayload(event: RuntimeStreamEvent): Record<string, unknown> {
  if (event.kind === 'stream_started') {
    return {
      kind: event.kind,
      provider: safeProviderStreamValue(event.provider, 80),
      model: safeProviderStreamValue(event.model, 120),
      source: event.source,
    }
  }
  if (event.kind === 'content_delta') {
    return {
      kind: event.kind,
      delta: safeProviderStreamValue(event.delta, PROVIDER_STREAM_DELTA_LIMIT),
      preview: safeProviderStreamValue(event.preview, PROVIDER_STREAM_PREVIEW_LIMIT),
    }
  }
  if (event.kind === 'tool_call_delta') {
    return {
      kind: event.kind,
      toolCallIndex: event.toolCallIndex,
      ...(event.toolName ? { toolName: safeProviderStreamValue(event.toolName, 120) } : {}),
      ...(event.argumentsDelta ? { argumentsDelta: safeProviderStreamValue(event.argumentsDelta, PROVIDER_STREAM_DELTA_LIMIT) } : {}),
      ...(event.argumentsPreview ? { argumentsPreview: safeProviderStreamValue(event.argumentsPreview, PROVIDER_STREAM_PREVIEW_LIMIT) } : {}),
    }
  }
  return {
    kind: event.kind,
    contentLength: event.contentLength,
    toolCallCount: event.toolCallCount,
  }
}

async function addProviderStreamRunEvent(ctx: PlannerContext, event: RuntimeStreamEvent) {
  const data = providerStreamEventPayload(event)
  if (event.kind === 'stream_started') {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_started',
      title: 'Provider 流已打开',
      message: `正在接收 ${data.provider} / ${data.model} 的流式输出。`,
      status: 'running',
      data,
    })
    return
  }
  if (event.kind === 'content_delta') {
    const delta = typeof data.delta === 'string' && data.delta.trim().length > 0 ? data.delta : '正在输出回答内容。'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_delta',
      title: '模型输出片段',
      message: delta,
      status: 'running',
      data,
    })
    return
  }
  if (event.kind === 'tool_call_delta') {
    const toolName = typeof data.toolName === 'string' ? data.toolName : '工具调用'
    const preview = typeof data.argumentsPreview === 'string' && data.argumentsPreview.trim().length > 0
      ? data.argumentsPreview
      : '正在组装工具参数。'
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'provider_stream_delta',
      title: '工具调用片段',
      message: `${toolName}: ${preview}`,
      status: 'running',
      data,
    })
    return
  }
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'provider_stream_completed',
    title: 'Provider 流已结束',
    message: `模型流已结束，累计内容 ${event.contentLength} 字符，工具调用 ${event.toolCallCount} 个。`,
    status: 'completed',
    data,
  })
}

function configuredModelPlannerSource(settings: Settings): Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'> | null {
  if (settings.llmProvider === 'rules') return null
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

function splitRequestedSteps(message: string) {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < message.length; index += 1) {
    const char = message[index] ?? ''
    if (inString) {
      current += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      current += char
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      current += char
      continue
    }
    if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1
      current += char
      continue
    }
    if (depth === 0 && /[；;\n]/.test(char)) {
      const part = current.trim()
      if (part) parts.push(part)
      current = ''
      continue
    }
    current += char
  }

  const finalPart = current.trim()
  if (finalPart) parts.push(finalPart)
  return parts.length > 0 ? parts : [message]
}

async function planOnlineFactorFromFields(
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
  const navigation: AgentNavigationEvent = {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'revenue' },
    reason: '线上系数属于收入引擎设置，先打开调模型页面供核对。',
  }

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

async function planWorkspacePatch(
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'inputs', secondaryTab: 'revenue' },
      reason: '模型草稿修改需要打开调模型页面供核对。',
    },
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches,
    },
  } satisfies AgentActionDraft
}

async function planWorkspaceRename(ctx: PlannerContext, workspaceName: unknown) {
  const nextName = typeof workspaceName === 'string' ? workspaceName.trim() : ''
  if (!nextName) return null
  if (nextName === ctx.workspace.name) {
    return {
      title: '工作区名称未变化',
      message: `当前工作区已经叫“${nextName}”。`,
      status: 'info',
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'overview' },
        panel: 'workspace',
        reason: '工作区改名需要打开版本管理面板供核对。',
      },
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '工作区改名需要打开版本管理面板供核对。',
    },
    payload: { workspaceName: nextName },
  } satisfies AgentActionDraft
}

async function planExportBundleRead(ctx: PlannerContext) {
  const bundle = await exportWorkspaceBundle(ctx.db, ctx.workspace)
  return {
    title: '导出工作区 Bundle',
    message: `已生成当前工作区 bundle：${bundle.workspaceName}，包含 ${bundle.snapshots.length} 个历史版本。完整 JSON 可通过 /api/v1/workspace/bundle 获取；本次 Agent 未修改业务数据。`,
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '导出工作区属于版本管理动作，需要打开版本管理面板。',
    },
    status: 'executed',
  } satisfies ReadDraft
}

function planImportBundleFromValue(ctx: PlannerContext, rawBundle: unknown) {
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '导入 bundle 会覆盖当前草稿，需要打开版本管理面板。',
    },
    payload: { bundle },
  } satisfies AgentActionDraft
}

async function callRuntimePlanner(ctx: PlannerContext): Promise<RuntimePlanResult | null> {
  const context = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    ...(ctx.providedWorkspaceBundle ? { providedWorkspaceBundle: ctx.providedWorkspaceBundle } : {}),
  })

  const tools = AGENT_TOOL_REGISTRY.map((entry) => entry.tool)
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_catalog_ready',
    title: '工具目录已提供',
    message: `本轮向模型提供 ${tools.length} 个 provider-native 工具，由模型通过 tool_calls 选择。`,
    status: 'running',
    data: {
      toolCount: tools.length,
      toolNames: AGENT_TOOL_REGISTRY.map((entry) => entry.name),
      toolCapabilities: AGENT_TOOL_REGISTRY.map((entry) => ({
        name: entry.name,
        capability: entry.capability,
        riskLevel: entry.riskLevel,
        confirmationMode: entry.confirmationMode,
        navigationTarget: entry.navigationTarget,
      })),
    },
  })

  return planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    tools,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    onStreamEvent: (event) => addProviderStreamRunEvent(ctx, event),
  })
}

const runtimeStepHandlers: ActionDraftBuilderHandlers<PlannerContext> = {
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
  'workspace.update_online_factor': (ctx, step) => step.monthLabel && typeof step.onlineSalesFactor === 'number'
    ? planOnlineFactorFromFields(ctx, {
        monthLabel: step.monthLabel,
        factor: step.onlineSalesFactor,
        mode: step.mode === 'forecast' ? 'forecast' : 'write',
      })
    : null,
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
  'workspace.patch_config': (ctx, step) => {
    return step.patches ? planWorkspacePatch(ctx, step.patches) : null
  },
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

async function modelPlannedItems(ctx: PlannerContext): Promise<{ source: AgentPlannerSource; items: PlannedItem[] } | null> {
  const requiredSource = configuredModelPlannerSource(ctx.settings)
  const items: PlannedItem[] = []
  let source: AgentPlannerSource | null = null
  for (const part of splitRequestedSteps(ctx.message)) {
    const artifact = extractWorkspaceBundleArtifact(part)
    const baseCtx: PlannerContext = { ...ctx, message: part }
    const planningCtx: PlannerContext = artifact ? { ...baseCtx, providedWorkspaceBundle: artifact } : baseCtx
    const runtimeCtx: PlannerContext = artifact ? { ...planningCtx, message: artifact.messageForModel } : planningCtx
    const result = await callRuntimePlanner(runtimeCtx)
    if (!result || result.steps.length === 0) {
      if (!requiredSource) return null
      source = source ?? result?.source ?? requiredSource
      if (result?.assistantText) {
        items.push(providerAssistantTextRead(result.assistantText))
      } else {
        items.push(modelToolCallRequiredRead(result?.error))
      }
      continue
    }
    source =
      result.source === 'openai_agents' || source === 'openai_agents'
        ? 'openai_agents'
        : 'openai_compatible_tool_calls'
    const partItems: PlannedItem[] = []
    for (const step of result.steps) {
      const item = await buildPlannedItemFromRuntimeStep(planningCtx, step, runtimeStepHandlers)
      if (Array.isArray(item)) {
        partItems.push(...item)
      } else if (item) {
        partItems.push(item)
      }
    }
    if (partItems.length > 0) {
      items.push(...partItems)
    } else if (requiredSource) {
      items.push(modelToolCallRequiredRead(result.error))
    }
  }
  return items.length > 0 ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items } : null
}

export async function planResponse(ctx: PlannerContext) {
  const modelPlan = await modelPlannedItems(ctx)
  const items = modelPlan?.items ?? []
  const plannerSource: AgentPlannerSource = modelPlan?.source ?? configuredModelPlannerSource(ctx.settings) ?? 'rules'
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const messages: string[] = []

  await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
  for (const [index, item] of items.entries()) {
    const sequence = index + 1
    await assertAgentRunLease(ctx.db, ctx.settings, ctx.runId)
    if (isActionDraft(item)) {
      const action = await addAgentActionRequest(ctx, item)
      const step = await addAgentPlanStep(ctx, {
        sequence,
        title: item.title,
        description: item.summary,
        status: 'ready',
        actionRequestId: action.id,
        navigation: item.navigation,
      })
      actionRows.push(action)
      planRows.push(step)
      navigationEvents.push(item.navigation)
      continue
    }

    if (item.navigation) navigationEvents.push(item.navigation)
    const step = await addAgentPlanStep(ctx, {
      sequence,
      title: item.title,
      description: item.message,
      status: item.status ?? 'info',
      navigation: item.navigation ?? null,
    })
    planRows.push(step)
    messages.push(item.message)
  }

  const failedCount = planRows.filter((row) => row.status === 'failed').length
  const actionCount = actionRows.length
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_plan_ready',
    title: failedCount > 0 ? '模型规划需要处理' : actionCount > 0 ? '模型工具调用已解析' : '模型回复已生成',
    message:
      items.length > 0
        ? `模型规划生成 ${items.length} 个步骤，其中 ${actionCount} 个写入动作需要确认。`
        : '模型没有生成可执行步骤。',
    status: failedCount > 0 ? 'failed' : actionCount > 0 ? 'blocked' : 'info',
    data: { plannerSource, stepCount: items.length, actionCount, failedCount },
  })
  if (actionCount > 0) {
    await addRunEvent(ctx.db, {
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: 'confirmation_ready',
      title: '确认卡已生成',
      message: `已生成 ${actionCount} 张待确认动作卡，用户可编辑后执行。`,
      status: 'blocked',
      data: { actionCount },
    })
  }
  agentThreadEvents.publish(ctx.threadId, 'plan_ready')
  if (items.length > 0) {
    const assistant =
      actionCount > 0
        ? `我已拆成 ${items.length} 个步骤，其中 ${actionCount} 个写入动作需要你确认。你可以先编辑确认卡，再逐项执行。${messages.length > 0 ? ` ${messages.join(' ')}` : ''}`
        : messages.join(' ')
    return { assistant, navigationEvents, actionRows, planRows, plannerSource }
  }

  return {
    assistant: '我可以操作测算、调模型、记实际、看偏差、版本发布/恢复、分享和锁账。请告诉我要执行的业务动作；写入前我会先给确认卡。',
    navigationEvents: [] as AgentNavigationEvent[],
    actionRows: [] as Row<'agent_action_requests'>[],
    planRows: [] as Row<'agent_plan_steps'>[],
    plannerSource,
  }
}
