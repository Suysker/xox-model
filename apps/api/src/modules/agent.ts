import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import { hydrateModelConfig, projectModel, type ModelConfig } from '@xox/domain'
import type {
  AgentActionRequest,
  AgentActionUpdatePayload,
  AgentNavigationEvent,
  AgentPlannerSource,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentThreadEvent,
} from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import { requireCurrentUser, type CurrentUser } from './auth.js'
import {
  exportWorkspaceBundle,
  getWorkspaceDraft,
  getWorkspaceForUser,
  listVersions,
} from './workspace.js'
import { listEntries, listPeriods, listSubjectsForPeriod } from './ledger.js'
import {
  archiveAgentMemory,
  compactThreadContextIfNeeded,
  loadAgentRuntimeContext,
  listAgentMemories,
  rememberFromUserMessage,
  redactSecretLikeContent,
  serializeMemory,
} from '../agent/memory.js'
import { planWithRuntimeAdapter } from '../agent/runtime/adapter-router.js'
import type { RuntimePlanResult } from '../agent/runtime/runtime-adapter.js'
import {
  AgentRunLeaseLostError,
  assertAgentRunLease,
  claimAgentRunLease,
  claimRecoverableAgentRuns,
  refreshAgentRunLease,
  startAgentRunLeaseHeartbeat,
} from '../agent/run-lease.js'
import { agentThreadEvents, type AgentThreadEventSignal } from '../agent/thread-events.js'
import { buildAgentWritableConfigContext } from '../agent/tool-coverage.js'
import { extractWorkspaceBundleArtifact, type ParsedWorkspaceBundleArtifact } from '../agent/workspace-bundle-artifact.js'
import { addRunEvent, listSerializedRunEvents, serializeRunEvent } from '../agent/run-events.js'
import {
  addAgentActionRequest,
  addAgentPlanStep,
  cancelAgentActionRequest,
  confirmAgentActionRequest,
  updateAgentActionRequest,
  type AgentActionDraft,
} from '../agent/action-requests.js'
import { answerWorkspaceDataQuestion } from '../agent/data-agent.js'
import { cloneModelConfig, getConfigPath, setConfigPath } from '../agent/config-patch.js'
import {
  addMessage,
  buildThreadState,
  buildThreadSummary,
  getOrCreateThread,
  getThreadForUser,
  serializeAction,
  serializeMessage,
  serializePlanStep,
  touchThreadAfterRun,
} from '../agent/thread-store.js'

type PlannerContext = {
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

type ReadDraft = {
  title: string
  message: string
  navigation?: AgentNavigationEvent | null
  status?: AgentPlanStepStatus
}

type PlannedItem = AgentActionDraft | ReadDraft

type RuntimePlannerStep = RuntimePlanResult['steps'][number]
const activeRunControllers = new Map<string, AbortController>()

type AgentRunQueueState = {
  draining: boolean
  scheduled: boolean
  stopped: boolean
  interval: NodeJS.Timeout | null
}

const agentRunQueueStates = new WeakMap<Kysely<Database>, AgentRunQueueState>()

function getAgentRunQueueState(db: Kysely<Database>) {
  let state = agentRunQueueStates.get(db)
  if (!state) {
    state = { draining: false, scheduled: false, stopped: false, interval: null }
    agentRunQueueStates.set(db, state)
  }
  return state
}

function accountActionRequested(message: string) {
  return /(注销|删除账号|退出登录|登录|注册|改密码|密码)/.test(message)
}

function accountForbiddenRead(): ReadDraft {
  return {
    title: '账号动作需要手动完成',
    message: '账号登录、退出、注销、删除账号和密码类动作不能由 Agent 自动执行，请在账号入口手动操作。',
    status: 'info',
  }
}

function modelToolCallRequiredRead(): ReadDraft {
  return {
    title: '模型未返回工具调用',
    message: '已配置真实模型规划，但本轮没有返回可执行 tool_call。为避免用本地规则或正则冒充模型调用，我没有生成写入动作；请补充指令或重试。',
    status: 'failed',
  }
}

function configuredModelPlannerSource(settings: Settings): Extract<AgentPlannerSource, 'openai_agents' | 'openai_compatible_tool_calls'> | null {
  if (settings.llmProvider === 'rules') return null
  return settings.llmProvider === 'openai' ? 'openai_agents' : 'openai_compatible_tool_calls'
}

function monthLabelFromMessage(message: string) {
  const match = message.match(/(\d{1,2})\s*月/)
  if (!match) return null
  const month = Number(match[1])
  return Number.isFinite(month) && month >= 1 && month <= 12 ? `${month}月` : null
}

function periodOccurrenceDate(config: ModelConfig, period: { monthIndex: number }) {
  const startMonth = Math.min(12, Math.max(1, Math.round(config.planning.startMonth || 1)))
  const monthOffset = startMonth - 1 + period.monthIndex - 1
  const year = new Date(utcNow()).getUTCFullYear() + Math.floor(monthOffset / 12)
  const month = monthOffset % 12
  return new Date(Date.UTC(year, month, 1, 12, 0, 0)).toISOString()
}

function numberAfter(label: string, message: string) {
  const match = message.match(new RegExp(`${label}\\s*(?:变成|改成|到|为)?\\s*(\\d+(?:\\.\\d+)?)`))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function countBeforeUnit(label: string, message: string) {
  const match = message.match(new RegExp(`${label}\\s*(\\d+(?:\\.\\d+)?)\\s*张`))
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) ? value : 0
}

async function periodForMonth(ctx: PlannerContext, monthLabel: string) {
  const periods = await listPeriods(ctx.db, ctx.workspace)
  return periods.find((period) => period.monthLabel === monthLabel) ?? periods[0] ?? null
}

async function currentDraftConfig(ctx: PlannerContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  return {
    draft,
    config: hydrateModelConfig(parseJson<unknown>(draft.config_json, null)),
  }
}

function memberFromMessage(config: ModelConfig, message: string) {
  return config.teamMembers.find((member) => message.includes(member.name)) ?? null
}

function isActionDraft(item: PlannedItem): item is AgentActionDraft {
  return Boolean((item as AgentActionDraft).kind)
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

function readOnlyForecastRequested(message: string) {
  return /如果|会怎样|预测|试算/.test(message) && !/(保存|修改|写入|更新|应用)/.test(message.replace('如果', ''))
}

async function planLedgerCreate(ctx: PlannerContext) {
  if (!/(记|入账|过账)/.test(ctx.message) || !/(成员|线下|线上|张)/.test(ctx.message)) {
    return null
  }

  const monthLabel = monthLabelFromMessage(ctx.message)
  if (!monthLabel) return null
  const { config } = await currentDraftConfig(ctx)
  const member = memberFromMessage(config, ctx.message)
  if (!member) return null

  return planLedgerCreateFromFields(ctx, {
    monthLabel,
    memberName: member.name,
    offlineUnits: countBeforeUnit('线下', ctx.message),
    onlineUnits: countBeforeUnit('线上', ctx.message),
  })
}

async function planLedgerCreateFromFields(
  ctx: PlannerContext,
  input: { monthLabel: string; memberName: string; offlineUnits?: number; onlineUnits?: number },
) {
  const period = await periodForMonth(ctx, input.monthLabel)
  if (!period) return null
  const { config } = await currentDraftConfig(ctx)
  const member = config.teamMembers.find((item) => item.name === input.memberName || item.id === input.memberName)
  if (!member) return null

  const offlineUnits = Number(input.offlineUnits ?? 0)
  const onlineUnits = Number(input.onlineUnits ?? 0)
  const offlineAmount = Math.round(offlineUnits * config.operating.offlineUnitPrice * 100) / 100
  const onlineAmount = Math.round(onlineUnits * config.operating.onlineUnitPrice * 100) / 100
  const amount = Math.round((offlineAmount + onlineAmount) * 100) / 100
  if (amount <= 0) return null
  const occurredAt = periodOccurrenceDate(config, period)

  const subjects = await listSubjectsForPeriod(ctx.db, ctx.workspace, period.id)
  const subjectMap = new Map(subjects.map((subject) => [subject.subjectKey, subject]))
  const allocations = [
    offlineAmount > 0 && subjectMap.get('revenue.offline_sales')
      ? { ...subjectMap.get('revenue.offline_sales')!, amount: offlineAmount }
      : null,
    onlineAmount > 0 && subjectMap.get('revenue.online_sales')
      ? { ...subjectMap.get('revenue.online_sales')!, amount: onlineAmount }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))

  return {
    kind: 'ledger.create_entry',
    title: '确认成员收入入账',
    summary: `${input.monthLabel}为${member.name}记录收入 ${amount} 元，系统会自动计提成员提成。`,
    targetLabel: `${period.monthLabel} / ${member.name}`,
    riskLevel: 'medium',
    details: [
      { label: '期间', value: period.monthLabel },
      { label: '成员', value: member.name },
      { label: '线下张数', value: `${offlineUnits}` },
      { label: '线上张数', value: `${onlineUnits}` },
      { label: '入账金额', value: `${amount}` },
      { label: '发生日', value: occurredAt.slice(0, 10) },
    ],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: period.id },
      reason: '记账动作需要打开本期账本并选中目标账期。',
    },
    payload: {
      ledgerPeriodId: period.id,
      direction: 'income',
      amount,
      relatedEntityType: 'teamMember',
      relatedEntityId: member.id,
      relatedEntityName: member.name,
      occurredAt,
      allocations,
    },
  } satisfies AgentActionDraft
}

async function planOnlineFactor(ctx: PlannerContext) {
  if (!ctx.message.includes('线上系数')) return null
  const monthLabel = monthLabelFromMessage(ctx.message)
  const factor = numberAfter('线上系数', ctx.message)
  if (!monthLabel || factor === null) return null
  const mode = readOnlyForecastRequested(ctx.message) ? 'forecast' : 'write'
  return planOnlineFactorFromFields(ctx, { monthLabel, factor, mode })
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

async function planPublish(ctx: PlannerContext) {
  if (!/发布(?!版)|正式版本/.test(ctx.message)) return null
  const createShare = /分享|链接/.test(ctx.message)
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '发布版本属于版本管理动作，需要打开版本管理面板。',
    },
    payload: { kind: 'release', createShare },
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

async function planSnapshot(ctx: PlannerContext) {
  if (!/保存.*快照|快照|保存当前版本/.test(ctx.message)) return null
  return {
    kind: 'workspace.save_snapshot',
    title: '确认保存草稿快照',
    summary: '将当前草稿保存为可恢复快照，不影响当前正式发布版。',
    targetLabel: ctx.workspace.name,
    riskLevel: 'low',
    details: [{ label: '工作区', value: ctx.workspace.name }],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '保存快照属于版本管理动作，需要打开版本管理面板。',
    },
    payload: { kind: 'snapshot' },
  } satisfies AgentActionDraft
}

async function planResetDraft(ctx: PlannerContext) {
  if (!/重置.*草稿|重置工作区|恢复默认/.test(ctx.message)) return null
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

async function planRollback(ctx: PlannerContext) {
  if (!/恢复|回滚/.test(ctx.message)) return null
  const versionNo = numberAfter('版本', ctx.message) ?? numberAfter('发布版', ctx.message)
  const versions = await listVersions(ctx.db, ctx.workspace)
  const version = versionNo
    ? versions.find((item) => item.version_no === versionNo)
    : versions.find((item) => ctx.message.includes(item.name))
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '恢复版本会覆盖当前草稿，需要打开版本管理面板。',
    },
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

async function versionFromMessage(ctx: PlannerContext, message: string, versionNo?: number | null, versionName?: string | null) {
  const versions = await listVersions(ctx.db, ctx.workspace)
  if (versionNo) return versions.find((item) => item.version_no === versionNo) ?? null
  if (versionName) return versions.find((item) => item.name === versionName || item.name.includes(versionName)) ?? null
  const inferredNo = numberAfter('版本', message) ?? numberAfter('发布版', message) ?? numberAfter('快照', message)
  if (inferredNo) return versions.find((item) => item.version_no === inferredNo) ?? null
  return versions.find((item) => message.includes(item.name)) ?? versions[0] ?? null
}

async function planDeleteVersion(ctx: PlannerContext) {
  if (!/删除.*版本|删除.*快照|删掉.*版本|删掉.*快照/.test(ctx.message)) return null
  const version = await versionFromMessage(ctx, ctx.message)
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '删除版本属于版本管理动作，需要打开版本管理面板。',
    },
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

async function planShare(ctx: PlannerContext, input?: { versionNo?: number; versionName?: string; revoke?: boolean }) {
  const wantsShare = /分享|链接/.test(ctx.message)
  const revoke = input?.revoke ?? /撤销|取消|关闭|移除/.test(ctx.message)
  if (!wantsShare && !input) return null
  if (/发布(?!版)|正式版本/.test(ctx.message)) return null
  const version = await versionFromMessage(ctx, ctx.message, input?.versionNo, input?.versionName)
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
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      panel: 'workspace',
      reason: '分享链接属于版本管理动作，需要打开版本管理面板。',
    },
    payload: { versionId: version.id },
  } satisfies AgentActionDraft
}

async function planLedgerVoid(ctx: PlannerContext) {
  if (!/作废|撤销入账|取消入账/.test(ctx.message)) return null
  const monthLabel = monthLabelFromMessage(ctx.message)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const { config } = await currentDraftConfig(ctx)
  const member = memberFromMessage(config, ctx.message)
  const entries = await listEntries(ctx.db, ctx.workspace, period.id)
  const candidates = entries.filter((entry) => {
    if (entry.status !== 'posted' || entry.entryOrigin === 'derived') return false
    if (member && entry.relatedEntityId !== member.id) return false
    return true
  })
  const entry = candidates[0]
  if (!entry) return null
  return {
    kind: 'ledger.void_entry',
    title: '确认作废分录',
    summary: `作废${period.monthLabel}${member ? ` ${member.name}` : ''} 的 ${entry.amount} 元分录，关联派生分录会同步作废。`,
    targetLabel: `${period.monthLabel} / ${member?.name ?? '账本分录'}`,
    riskLevel: 'high',
    details: [
      { label: '期间', value: period.monthLabel },
      { label: '金额', value: `${entry.amount}` },
      { label: '对象', value: entry.relatedEntityName ?? '-' },
    ],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: period.id },
      focusRecordId: entry.id,
      reason: '作废分录需要打开本期账本并定位记录。',
    },
    payload: { entryId: entry.id },
  } satisfies AgentActionDraft
}

async function planPeriodLock(ctx: PlannerContext) {
  const lock = /锁定/.test(ctx.message)
  const unlock = /解锁/.test(ctx.message)
  if (!lock && !unlock) return null
  const monthLabel = monthLabelFromMessage(ctx.message)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  return {
    kind: lock ? 'ledger.lock_period' : 'ledger.unlock_period',
    title: lock ? '确认锁定账期' : '确认解锁账期',
    summary: lock ? `锁定 ${monthLabel} 后将禁止新增、修改和作废分录。` : `解锁 ${monthLabel} 后可以继续修改已过账记录。`,
    targetLabel: monthLabel,
    riskLevel: 'high',
    details: [{ label: '账期', value: monthLabel }],
    navigation: {
      type: 'navigation',
      route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: period.id },
      reason: '锁账动作需要打开本期账本并选中目标账期。',
    },
    payload: { periodId: period.id },
  } satisfies AgentActionDraft
}

function planNavigationOnly(message: string): { message: string; navigation: AgentNavigationEvent } | null {
  if (/记实际|记账|账本/.test(message)) {
    return {
      message: '已打开记实际页面。',
      navigation: { type: 'navigation', route: { mainTab: 'bookkeeping', secondaryTab: 'entries' }, reason: '用户要求打开记账工作台。' },
    }
  }
  if (/看偏差|预实|偏差/.test(message)) {
    return {
      message: '已打开偏差复盘页面。',
      navigation: { type: 'navigation', route: { mainTab: 'variance', secondaryTab: 'analysis' }, reason: '用户要求查看预实偏差。' },
    }
  }
  if (/调模型|收入|成本|资金/.test(message)) {
    return {
      message: '已打开调模型页面。',
      navigation: { type: 'navigation', route: { mainTab: 'inputs', secondaryTab: message.includes('成本') ? 'cost' : message.includes('资金') ? 'capital' : 'revenue' }, reason: '用户要求打开模型输入工作台。' },
    }
  }
  if (/看测算|总览|预测/.test(message)) {
    return {
      message: '已打开经营总览页面。',
      navigation: { type: 'navigation', route: { mainTab: 'dashboard', secondaryTab: 'overview' }, reason: '用户要求查看测算总览。' },
    }
  }
  return null
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

async function planExportBundle(ctx: PlannerContext) {
  if (!/导出/.test(ctx.message) || !/(工作区|bundle|Bundle|JSON)/.test(ctx.message)) return null
  return planExportBundleRead(ctx)
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

async function planImportBundle(ctx: PlannerContext) {
  if (!/导入/.test(ctx.message) || !/(工作区|bundle|Bundle|JSON)/.test(ctx.message)) return null
  return planImportBundleFromValue(ctx, ctx.providedWorkspaceBundle?.bundle)
}

async function callRuntimePlanner(ctx: PlannerContext): Promise<RuntimePlanResult | null> {
  const { config } = await currentDraftConfig(ctx)
  const periods = await listPeriods(ctx.db, ctx.workspace)
  const versions = await listVersions(ctx.db, ctx.workspace)
  const runtimeContext = await loadAgentRuntimeContext({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
  })
  const context = {
    months: config.months.map((month, index) => ({ label: month.label, index, id: month.id })),
    teamMembers: config.teamMembers.map((member) => ({ id: member.id, name: member.name })),
    versions: versions.map((version) => ({ versionNo: version.version_no, name: version.name, kind: version.kind })),
    periods: periods.map((period) => ({ id: period.id, monthLabel: period.monthLabel })),
    tenantScopedMemory: runtimeContext.memories.map((memory) => ({
      kind: memory.kind,
      key: memory.key,
      value: memory.value,
    })),
    contextSummary: runtimeContext.contextSummary,
    recentMessages: runtimeContext.recentMessages.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 500),
    })),
    writableConfig: buildAgentWritableConfigContext(config),
    ...(ctx.providedWorkspaceBundle
      ? {
          providedArtifacts: {
            workspaceBundle: ctx.providedWorkspaceBundle.summary,
          },
        }
      : {}),
  }

  return planWithRuntimeAdapter({
    settings: ctx.settings,
    message: redactSecretLikeContent(ctx.message),
    context,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  })
}

async function plannedItemFromRuntimeStep(ctx: PlannerContext, step: RuntimePlannerStep): Promise<PlannedItem | null> {
  if (step.intent === 'agent.ask_clarification') {
    const question = typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : '我还缺少必要信息，能补充一下吗？'
    const missingFields = Array.isArray(step.missingFields)
      ? step.missingFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
      : []
    const suggestions = Array.isArray(step.suggestions)
      ? step.suggestions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    const suffix = [
      missingFields.length > 0 ? `缺少：${missingFields.join('、')}` : null,
      suggestions.length > 0 ? `可选参考：${suggestions.join('、')}` : null,
    ].filter(Boolean).join('。')
    return {
      title: '需要补充信息',
      message: `${question}${suffix ? `（${suffix}）` : ''}`,
      status: 'info',
    } satisfies ReadDraft
  }
  if (step.intent === 'account.forbidden') {
    return accountForbiddenRead()
  }
  if (step.intent === 'ledger.create_member_income' && step.monthLabel && step.memberName) {
    return planLedgerCreateFromFields(ctx, {
      monthLabel: step.monthLabel,
      memberName: step.memberName,
      offlineUnits: step.offlineUnits ?? 0,
      onlineUnits: step.onlineUnits ?? 0,
    })
  }
  if (step.intent === 'workspace.update_online_factor' && step.monthLabel && typeof step.onlineSalesFactor === 'number') {
    return planOnlineFactorFromFields(ctx, {
      monthLabel: step.monthLabel,
      factor: step.onlineSalesFactor,
      mode: step.mode === 'forecast' || readOnlyForecastRequested(ctx.message) ? 'forecast' : 'write',
    })
  }
  if (step.intent === 'workspace.patch_config' && readOnlyForecastRequested(ctx.message)) return null
  if (step.intent === 'workspace.patch_config' && step.patches) return planWorkspacePatch(ctx, step.patches)
  if (step.intent === 'workspace.save_snapshot') return planSnapshot(ctx)
  if (step.intent === 'workspace.publish_release') {
    return {
      kind: 'workspace.publish_release',
      title: step.createShare ? '确认发布并创建分享链接' : '确认发布正式版本',
      summary: step.createShare ? '发布当前草稿为不可变正式版本，并为该版本创建只读分享链接。' : '发布当前草稿为不可变正式版本。',
      targetLabel: ctx.workspace.name,
      riskLevel: 'high',
      details: [
        { label: '工作区', value: ctx.workspace.name },
        { label: '分享链接', value: step.createShare ? '发布后创建' : '不创建' },
      ],
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'overview' },
        panel: 'workspace',
        reason: '发布版本属于版本管理动作，需要打开版本管理面板。',
      },
      payload: { kind: 'release', createShare: Boolean(step.createShare) },
    } satisfies AgentActionDraft
  }
  if (step.intent === 'workspace.rollback_version') {
    const version = await versionFromMessage(ctx, ctx.message, step.versionNo, step.versionName)
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
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'overview' },
        panel: 'workspace',
        reason: '恢复版本会覆盖当前草稿，需要打开版本管理面板。',
      },
      payload: { versionId: version.id },
    } satisfies AgentActionDraft
  }
  if (step.intent === 'workspace.delete_version') return planDeleteVersion(ctx)
  if (step.intent === 'workspace.reset_draft') return planResetDraft(ctx)
  if (step.intent === 'workspace.export_bundle') {
    return planExportBundleRead(ctx)
  }
  if (step.intent === 'workspace.import_bundle') {
    const rawBundle = step.bundle && typeof step.bundle === 'object'
      ? step.bundle
      : step.useProvidedBundle
        ? ctx.providedWorkspaceBundle?.bundle
        : ctx.providedWorkspaceBundle?.bundle
    return planImportBundleFromValue(ctx, rawBundle)
  }
  if (step.intent === 'share.create') {
    return planShare(ctx, {
      ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
      ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
      revoke: false,
    })
  }
  if (step.intent === 'share.revoke') {
    return planShare(ctx, {
      ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
      ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
      revoke: true,
    })
  }
  if (step.intent === 'ledger.set_period_lock' && step.monthLabel) {
    const period = await periodForMonth(ctx, step.monthLabel)
    if (!period) return null
    const locked = Boolean(step.locked)
    return {
      kind: locked ? 'ledger.lock_period' : 'ledger.unlock_period',
      title: locked ? '确认锁定账期' : '确认解锁账期',
      summary: locked ? `锁定 ${step.monthLabel} 后将禁止新增、修改和作废分录。` : `解锁 ${step.monthLabel} 后可以继续修改已过账记录。`,
      targetLabel: step.monthLabel,
      riskLevel: 'high',
      details: [{ label: '账期', value: step.monthLabel }],
      navigation: {
        type: 'navigation',
        route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: period.id },
        reason: '锁账动作需要打开本期账本并选中目标账期。',
      },
      payload: { periodId: period.id },
    } satisfies AgentActionDraft
  }
  if (step.intent === 'ledger.void_entry') return planLedgerVoid(ctx)
  if (step.intent === 'data.query_workspace') return answerWorkspaceDataQuestion(ctx, step)
  if (step.intent === 'ui.navigate' && step.mainTab) {
    return {
      title: '打开页面',
      message: '已打开相关页面。',
      navigation: {
        type: 'navigation',
        route: { mainTab: step.mainTab, secondaryTab: step.secondaryTab as never },
        reason: '用户要求切换工作台页面。',
      },
      status: 'executed',
    } satisfies ReadDraft
  }
  return null
}

async function localPlannedItems(ctx: PlannerContext): Promise<PlannedItem[]> {
  const items: PlannedItem[] = []
  for (const part of splitRequestedSteps(ctx.message)) {
    if (accountActionRequested(part)) {
      items.push(accountForbiddenRead())
      continue
    }
    const artifact = extractWorkspaceBundleArtifact(part)
    const baseCtx: PlannerContext = { ...ctx, message: part }
    const scopedCtx: PlannerContext = artifact ? { ...baseCtx, providedWorkspaceBundle: artifact } : baseCtx
    const plannedItems = [
      await planLedgerCreate(scopedCtx),
      await planOnlineFactor(scopedCtx),
      await planImportBundle(scopedCtx),
      await planExportBundle(scopedCtx),
      await planSnapshot(scopedCtx),
      await planPublish(scopedCtx),
      await planRollback(scopedCtx),
      await planDeleteVersion(scopedCtx),
      await planShare(scopedCtx),
      await planResetDraft(scopedCtx),
      await planLedgerVoid(scopedCtx),
      await planPeriodLock(scopedCtx),
    ]
    const planned = plannedItems.find(Boolean)
    if (planned) items.push(planned)
  }

  if (items.length > 0) return items
  const navigationOnly = planNavigationOnly(ctx.message)
  return navigationOnly
    ? [{ title: '切换页面', message: navigationOnly.message, navigation: navigationOnly.navigation, status: 'executed' }]
    : []
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
      source = source ?? requiredSource
      items.push(modelToolCallRequiredRead())
      continue
    }
    source =
      result.source === 'openai_agents' || source === 'openai_agents'
        ? 'openai_agents'
        : 'openai_compatible_tool_calls'
    const partItems: PlannedItem[] = []
    for (const step of result.steps) {
      const item = await plannedItemFromRuntimeStep(planningCtx, step)
      if (item) partItems.push(item)
    }
    if (partItems.length > 0) {
      items.push(...partItems)
    } else if (requiredSource) {
      items.push(modelToolCallRequiredRead())
    } else {
      items.push(...(await localPlannedItems(planningCtx)))
    }
  }
  return items.length > 0 ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items } : null
}

async function planResponse(ctx: PlannerContext) {
  const modelPlan = await modelPlannedItems(ctx)
  const items = modelPlan?.items ?? (await localPlannedItems(ctx))
  const plannerSource: AgentPlannerSource = modelPlan?.source ?? 'rules'
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
    title: failedCount > 0 ? '模型规划需要处理' : '模型工具调用已解析',
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

type CompletedAgentRun = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'>
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
}

function safeRunErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecretLikeContent(message).slice(0, 500) || 'Agent run failed'
}

async function failAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  error: unknown,
) {
  const message = safeRunErrorMessage(error)
  await addMessage(db, thread.id, 'assistant', `运行失败：${message}`).catch(() => undefined)
  await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute().catch(() => undefined)
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_failed',
    title: '运行失败',
    message,
    status: 'failed',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_failed')
}

async function failInterruptedAgentRun(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
) {
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'failed', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await failAgentRun(db, thread, runId, new Error(message))
}

async function cancelRunArtifacts(
  db: Kysely<Database>,
  thread: Row<'agent_threads'>,
  runId: string,
  message: string,
  addAssistantMessage: boolean,
) {
  const now = utcNow()
  await db
    .updateTable('agent_action_requests')
    .set({ status: 'cancelled', error_message: message })
    .where('run_id', '=', runId)
    .where('status', '=', 'pending')
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'cancelled', updated_at: now })
    .where('run_id', '=', runId)
    .where('status', '!=', 'executed')
    .execute()
  await db
    .updateTable('agent_runs')
    .set({ status: 'cancelled', completed_at: now, lease_expires_at: null })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .execute()
  if (addAssistantMessage) await addMessage(db, thread.id, 'assistant', message)
  await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute()
  await addRunEvent(db, {
    threadId: thread.id,
    runId,
    type: 'run_cancelled',
    title: '运行已取消',
    message,
    status: 'cancelled',
  }).catch(() => undefined)
  agentThreadEvents.publish(thread.id, 'run_cancelled')
}

async function completeAgentRun(ctx: PlannerContext & { thread: Row<'agent_threads'> }): Promise<CompletedAgentRun | null> {
  let stopHeartbeat: (() => void) | null = null
  try {
    const claimed = await claimAgentRunLease(ctx.db, ctx.settings, ctx.runId)
    if (!claimed) return null
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'worker_claimed',
      title: 'Worker 已认领',
      message: '后台 worker 已取得 run lease，开始执行。同步调用也会经过同一套 lease guard。',
      status: 'running',
    })
    stopHeartbeat = startAgentRunLeaseHeartbeat(ctx.db, ctx.settings, ctx.runId)
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'model_planning',
      title: '模型规划中',
      message: '正在调用配置的模型，并等待 provider-native tool calls。',
      status: 'running',
      data: { provider: ctx.settings.llmProvider },
    })
    const planned = await planResponse(ctx)
    if (!(await refreshAgentRunLease(ctx.db, ctx.settings, ctx.runId))) return null
    const assistantMessage = await addMessage(ctx.db, ctx.thread.id, 'assistant', planned.assistant)
    await compactThreadContextIfNeeded({ db: ctx.db, workspace: ctx.workspace, user: ctx.user, threadId: ctx.thread.id })
    if (!(await refreshAgentRunLease(ctx.db, ctx.settings, ctx.runId))) return null
    await ctx.db
      .updateTable('agent_runs')
      .set({ status: 'completed', planner_source: planned.plannerSource, completed_at: utcNow(), lease_expires_at: null })
      .where('id', '=', ctx.runId)
      .where('status', '=', 'running')
      .where('worker_id', '=', ctx.settings.agentWorkerId)
      .execute()
    await touchThreadAfterRun(ctx.db, ctx.thread, ctx.message)
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'run_completed',
      title: '运行完成',
      message: planned.actionRows.length > 0 ? '模型规划已完成，等待用户处理确认卡。' : '模型规划和只读回答已完成。',
      status: 'completed',
      data: { actionCount: planned.actionRows.length, planStepCount: planned.planRows.length },
    })
    agentThreadEvents.publish(ctx.thread.id, 'run_completed')
    return {
      plannerSource: planned.plannerSource,
      assistantMessage,
      navigationEvents: planned.navigationEvents,
      actionRows: planned.actionRows,
      planRows: planned.planRows,
    }
  } catch (error) {
    if (error instanceof AgentRunLeaseLostError) return null
    if (!(await refreshAgentRunLease(ctx.db, ctx.settings, ctx.runId).catch(() => false))) {
      return null
    }
    await failAgentRun(ctx.db, ctx.thread, ctx.runId, error)
    throw error
  } finally {
    stopHeartbeat?.()
    activeRunControllers.delete(ctx.runId)
  }
}

async function countRunRows(db: Kysely<Database>, table: 'agent_plan_steps' | 'agent_action_requests', runId: string) {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function recoverRunMessage(db: Kysely<Database>, run: Row<'agent_runs'>) {
  const stored = run.input_message?.trim()
  if (stored) return stored
  if (run.input_message_id) {
    const message = await db
      .selectFrom('agent_messages')
      .select('content')
      .where('id', '=', run.input_message_id)
      .where('role', '=', 'user')
      .executeTakeFirst()
    if (message?.content.trim()) return message.content.trim()
  }
  const fallback = await db
    .selectFrom('agent_messages')
    .select('content')
    .where('thread_id', '=', run.thread_id)
    .where('role', '=', 'user')
    .where('created_at', '<=', run.created_at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return fallback?.content.trim() ?? null
}

export async function recoverRunningAgentRuns(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  if (queueState.draining || queueState.stopped) return 0
  queueState.draining = true
  let started = 0
  try {
    const runs = await claimRecoverableAgentRuns(db, settings)

    for (const run of runs) {
      if (activeRunControllers.has(run.id)) continue
      const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', run.thread_id).executeTakeFirst()
      if (!thread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', run.id).execute()
        continue
      }
      const [workspace, user, planStepCount, actionCount] = await Promise.all([
        db.selectFrom('workspaces').selectAll().where('id', '=', thread.workspace_id).executeTakeFirst(),
        db.selectFrom('users').selectAll().where('id', '=', run.user_id).executeTakeFirst(),
        countRunRows(db, 'agent_plan_steps', run.id),
        countRunRows(db, 'agent_action_requests', run.id),
      ])
      if (!workspace || !user || thread.user_id !== run.user_id) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：用户或工作区已不存在。')
        continue
      }
      if (planStepCount > 0 || actionCount > 0) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 在服务重启时已有部分运行产物，系统已取消未执行确认卡以避免重复执行。请重新发送这条指令。')
        continue
      }
      const message = await recoverRunMessage(db, run)
      if (!message) {
        await failInterruptedAgentRun(db, thread, run.id, 'Agent run 无法恢复：缺少原始用户指令。请重新发送这条指令。')
        continue
      }
      agentThreadEvents.publish(thread.id, 'thread_restored')
      const controller = new AbortController()
      activeRunControllers.set(run.id, controller)
      void completeAgentRun({
        db,
        settings,
        user,
        workspace,
        thread,
        threadId: thread.id,
        runId: run.id,
        message,
        abortSignal: controller.signal,
      }).catch(() => undefined)
      started += 1
    }
    return started
  } finally {
    queueState.draining = false
  }
}

function scheduleAgentRunQueueDrain(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  if (queueState.scheduled || queueState.stopped) return
  queueState.scheduled = true
  const timer = setTimeout(() => {
    queueState.scheduled = false
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, 0)
  timer.unref?.()
}

function startAgentRunQueueWorker(db: Kysely<Database>, settings: Settings) {
  const queueState = getAgentRunQueueState(db)
  queueState.stopped = false
  if (queueState.interval) return () => undefined

  scheduleAgentRunQueueDrain(db, settings)
  queueState.interval = setInterval(() => {
    void recoverRunningAgentRuns(db, settings).catch(() => undefined)
  }, settings.agentRunWorkerPollMs)
  queueState.interval.unref?.()

  return () => {
    queueState.stopped = true
    queueState.scheduled = false
    if (queueState.interval) clearInterval(queueState.interval)
    queueState.interval = null
  }
}

function writeSseEvent(response: ServerResponse, event: string, data: unknown) {
  if (response.destroyed || response.writableEnded) return
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function writeSseComment(response: ServerResponse, comment: string) {
  if (response.destroyed || response.writableEnded) return
  response.write(`: ${comment}\n\n`)
}

async function writeAgentThreadStateEvent(
  response: ServerResponse,
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  threadId: string,
  signal: AgentThreadEventSignal,
) {
  const state = await buildThreadState(db, workspace, user, threadId)
  const event: AgentThreadEvent = {
    type: 'thread_state',
    threadId,
    sequence: signal.sequence,
    reason: signal.reason,
    state,
  }
  writeSseEvent(response, 'thread_state', event)
}

export function registerAgentRoutes(app: FastifyInstance, db: Kysely<Database>, settings: Settings) {
  app.get('/api/v1/agent/threads', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const threads = await db
        .selectFrom('agent_threads')
        .selectAll()
        .where('workspace_id', '=', workspace.id)
        .where('user_id', '=', user.id)
        .orderBy('updated_at', 'desc')
        .limit(30)
        .execute()
      return { threads: await Promise.all(threads.map((thread) => buildThreadSummary(db, thread))) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/threads/:threadId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { threadId } = request.params as { threadId: string }
      return buildThreadState(db, workspace, user, threadId)
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/threads/:threadId/events', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { threadId } = request.params as { threadId: string }
      await getThreadForUser(db, workspace, user, threadId)

      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.flushHeaders?.()

      let closed = false
      let unsubscribe: () => void = () => undefined
      let heartbeat: NodeJS.Timeout | null = null
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }
      const sendState = (signal: AgentThreadEventSignal) => {
        void writeAgentThreadStateEvent(reply.raw, db, workspace, user, threadId, signal).catch((error) => {
          writeSseEvent(reply.raw, 'error', { message: safeRunErrorMessage(error) })
          close()
        })
      }
      unsubscribe = agentThreadEvents.subscribe(threadId, sendState)
      heartbeat = setInterval(() => writeSseComment(reply.raw, 'heartbeat'), 15_000)
      heartbeat.unref?.()

      request.raw.on('close', close)
      request.raw.on('aborted', close)
      sendState({ threadId, sequence: 0, reason: 'thread_restored' })
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/messages', async (request, reply) => {
    let runId: string | null = null
    let activeThread: Row<'agent_threads'> | null = null
    try {
      const body = request.body as { threadId?: string | null; message?: string; background?: boolean }
      const message = body.message?.trim()
      if (!message) throw unprocessable('Message is required')
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const thread = await getOrCreateThread(db, workspace, user, body.threadId)
      activeThread = thread
      runId = newId()
      const now = utcNow()
      await db
        .insertInto('agent_runs')
        .values({
          id: runId,
          thread_id: thread.id,
          user_id: user.id,
          status: 'running',
          input_message_id: null,
          input_message: message,
          planner_source: null,
          worker_id: null,
          lease_expires_at: null,
          heartbeat_at: null,
          created_at: now,
          completed_at: null,
        })
        .execute()
      const userMessage = await addMessage(db, thread.id, 'user', message)
      await db.updateTable('agent_runs').set({ input_message_id: userMessage.id }).where('id', '=', runId).execute()
      const queuedEvent = await addRunEvent(db, {
        threadId: thread.id,
        runId,
        type: 'run_queued',
        title: 'Run 已入队',
        message: body.background === true ? '用户指令已持久化，等待 Agent worker 认领执行。' : '用户指令已持久化，将在当前请求中同步执行。',
        status: 'queued',
        data: { background: body.background === true },
      })
      await rememberFromUserMessage({ db, workspace, user, threadId: thread.id, messageId: userMessage.id, message })

      if (body.background === true) {
        await touchThreadAfterRun(db, thread, message)
        agentThreadEvents.publish(thread.id, 'thread_started')
        scheduleAgentRunQueueDrain(db, settings)
        return {
          threadId: thread.id,
          runId,
          status: 'running' as const,
          planner: null,
          messages: [serializeMessage(userMessage)],
          navigationEvents: [] as AgentNavigationEvent[],
          runEvents: [serializeRunEvent(queuedEvent)],
          planSteps: [] as AgentPlanStep[],
          actionRequests: [] as AgentActionRequest[],
        }
      }

      const claimed = await claimAgentRunLease(db, settings, runId)
      if (!claimed) throw conflict('Agent run could not be claimed by this worker')
      const controller = new AbortController()
      activeRunControllers.set(runId, controller)
      const completed = await completeAgentRun({ db, settings, user, workspace, thread, threadId: thread.id, runId, message, abortSignal: controller.signal })
      if (!completed) return buildThreadState(db, workspace, user, thread.id)
      return {
        threadId: thread.id,
        runId,
        status: 'completed' as const,
        planner: completed.plannerSource,
        messages: [serializeMessage(userMessage), serializeMessage(completed.assistantMessage)],
        navigationEvents: completed.navigationEvents,
        runEvents: await listSerializedRunEvents(db, runId),
        planSteps: completed.planRows.map(serializePlanStep),
        actionRequests: completed.actionRows.map(serializeAction),
      }
    } catch (error) {
      if (runId && activeThread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow(), lease_expires_at: null }).where('id', '=', runId).execute().catch(() => undefined)
        await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', activeThread.id).execute().catch(() => undefined)
        agentThreadEvents.publish(activeThread.id, 'run_failed')
      }
      return reply.send(error)
    }
  })

  app.post('/api/v1/agent/runs/:runId/cancel', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { runId } = request.params as { runId: string }
      const run = await db.selectFrom('agent_runs').selectAll().where('id', '=', runId).executeTakeFirst()
      if (!run) throw notFound('Agent run not found')
      if (run.user_id !== user.id) throw forbidden()
      const thread = await getThreadForUser(db, workspace, user, run.thread_id)
      if (run.status === 'running') {
        activeRunControllers.get(run.id)?.abort()
        await cancelRunArtifacts(db, thread, run.id, '已取消当前 Agent 运行。', true)
        await recordAudit(db, {
          workspaceId: workspace.id,
          actorId: user.id,
          action: 'agent.run_cancelled',
          entityType: 'agent_run',
          entityId: run.id,
          meta: { provider: settings.llmProvider },
        })
      }
      return buildThreadState(db, workspace, user, thread.id)
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/agent/memories', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const memories = await listAgentMemories(db, workspace, user)
      return { memories: memories.map(serializeMemory) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/agent/memories/:memoryId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { memoryId } = request.params as { memoryId: string }
      await archiveAgentMemory(db, workspace, user, memoryId)
      return { ok: true }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/confirm', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await confirmAgentActionRequest(db, settings, user, actionRequestId)
      agentThreadEvents.publish(result.threadId, 'action_executed')
      return {
        actionRequest: serializeAction(result.actionRequest),
        result: result.result,
        messages: result.messages.map(serializeMessage),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/cancel', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await cancelAgentActionRequest(db, workspace, user, actionRequestId)
      agentThreadEvents.publish(result.threadId, 'action_cancelled')
      return {
        actionRequest: serializeAction(result.actionRequest),
        messages: result.messages.map(serializeMessage),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.patch('/api/v1/agent/action-requests/:actionRequestId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const result = await updateAgentActionRequest(db, workspace, user, actionRequestId, request.body as AgentActionUpdatePayload)
      agentThreadEvents.publish(result.threadId, 'action_updated')
      return {
        actionRequest: serializeAction(result.actionRequest),
        runEvents: result.runEvents,
        planSteps: result.planSteps.map(serializePlanStep),
      }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  const stopAgentRunQueueWorker = startAgentRunQueueWorker(db, settings)
  app.addHook('onClose', async () => stopAgentRunQueueWorker())
}
