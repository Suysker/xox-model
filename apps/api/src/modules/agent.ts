import { Agent } from '@openai/agents'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig, projectModel, type ModelConfig } from '@xox/domain'
import type { AgentActionKind, AgentActionUpdatePayload, AgentNavigationEvent, AgentPlanStepStatus } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import { requireCurrentUser, type CurrentUser } from './auth.js'
import {
  deleteVersion,
  getWorkspaceDraft,
  getWorkspaceForUser,
  listVersions,
  rollbackToVersion,
  saveDraft,
  publishVersion,
} from './workspace.js'
import {
  createActualEntry,
  listEntries,
  listPeriods,
  listSubjectsForPeriod,
  restoreEntry,
  setPeriodStatus,
  updateActualEntry,
  voidEntry,
} from './ledger.js'
import { createVersionShare, revokeVersionShare } from './share.js'

const operatorAgent = new Agent({
  name: 'xox-operator',
  instructions:
    'You are the xox-model operating agent. Use tools to navigate visibly, preview write actions, and wait for user confirmation before mutating state.',
})

type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
}

type ActionDraft = {
  kind: AgentActionKind
  title: string
  summary: string
  targetLabel: string
  riskLevel: 'low' | 'medium' | 'high'
  details: Array<{ label: string; value: string }>
  navigation: AgentNavigationEvent
  payload: unknown
}

type ReadDraft = {
  title: string
  message: string
  navigation?: AgentNavigationEvent | null
  status?: AgentPlanStepStatus
}

type PlannedItem = ActionDraft | ReadDraft

type DeepSeekPlannerStep = {
  intent?: string
  monthLabel?: string
  memberName?: string
  offlineUnits?: number
  onlineUnits?: number
  onlineSalesFactor?: number
  mode?: 'forecast' | 'write'
  versionNo?: number
  versionName?: string
  createShare?: boolean
  locked?: boolean
  mainTab?: 'dashboard' | 'inputs' | 'bookkeeping' | 'variance'
  secondaryTab?: string
  patches?: Array<{ path: string; value: unknown; label?: string }>
}

function serializeAction(row: Row<'agent_action_requests'>) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    targetLabel: row.target_label,
    riskLevel: row.risk_level,
    details: parseJson<Array<{ label: string; value: string }>>(row.details_json, []),
    navigation: parseJson<AgentNavigationEvent>(row.navigation_json, {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      reason: '默认打开经营总览。',
    }),
    payload: parseJson<unknown>(row.payload_json, null),
    createdAt: row.created_at,
    executedAt: row.executed_at,
    errorMessage: row.error_message,
  }
}

function serializePlanStep(row: Row<'agent_plan_steps'>) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    actionRequestId: row.action_request_id,
    sequence: row.sequence_no,
    title: row.title,
    description: row.description,
    status: row.status,
    navigation: row.navigation_json ? parseJson<AgentNavigationEvent | null>(row.navigation_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeMessage(row: Row<'agent_messages'>) {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }
}

async function getOrCreateThread(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, threadId?: string | null) {
  if (threadId) {
    const existing = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
    if (!existing) throw notFound('Agent thread not found')
    if (existing.workspace_id !== workspace.id || existing.user_id !== user.id) throw forbidden()
    return existing
  }

  const now = utcNow()
  const id = newId()
  await db
    .insertInto('agent_threads')
    .values({
      id,
      workspace_id: workspace.id,
      user_id: user.id,
      title: 'Agent 对话',
      created_at: now,
      updated_at: now,
    })
    .execute()
  return db.selectFrom('agent_threads').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function addMessage(db: Kysely<Database>, threadId: string, role: 'user' | 'assistant' | 'system', content: string) {
  const id = newId()
  await db
    .insertInto('agent_messages')
    .values({
      id,
      thread_id: threadId,
      role,
      content,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function addActionRequest(ctx: PlannerContext, draft: ActionDraft) {
  const id = newId()
  const now = utcNow()
  await ctx.db
    .insertInto('agent_action_requests')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      workspace_id: ctx.workspace.id,
      user_id: ctx.user.id,
      kind: draft.kind,
      status: 'pending',
      title: draft.title,
      summary: draft.summary,
      target_label: draft.targetLabel,
      risk_level: draft.riskLevel,
      details_json: jsonString(draft.details),
      navigation_json: jsonString(draft.navigation),
      payload_json: jsonString(draft.payload),
      created_at: now,
      executed_at: null,
      error_message: null,
    })
    .execute()
  return ctx.db.selectFrom('agent_action_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function addPlanStep(
  ctx: PlannerContext,
  input: {
    sequence: number
    title: string
    description: string
    status: AgentPlanStepStatus
    actionRequestId?: string | null
    navigation?: AgentNavigationEvent | null
  },
) {
  const id = newId()
  const now = utcNow()
  await ctx.db
    .insertInto('agent_plan_steps')
    .values({
      id,
      thread_id: ctx.threadId,
      run_id: ctx.runId,
      action_request_id: input.actionRequestId ?? null,
      sequence_no: input.sequence,
      title: input.title,
      description: input.description,
      status: input.status,
      navigation_json: input.navigation ? jsonString(input.navigation) : null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return ctx.db.selectFrom('agent_plan_steps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

function accountActionRequested(message: string) {
  return /(注销|删除账号|退出登录|登录|注册|改密码|密码)/.test(message)
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

function isActionDraft(item: PlannedItem): item is ActionDraft {
  return Boolean((item as ActionDraft).kind)
}

function cloneConfig(config: ModelConfig) {
  return hydrateModelConfig(JSON.parse(JSON.stringify(config)) as unknown)
}

function pathSegments(path: string) {
  return path
    .replace(/^config\./, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function getConfigPath(root: unknown, path: string) {
  let current = root as any
  for (const segment of pathSegments(path)) {
    if (current == null) return undefined
    current = current[segment]
  }
  return current
}

function setConfigPath(root: unknown, path: string, value: unknown) {
  const segments = pathSegments(path)
  if (segments.length === 0) throw unprocessable('Patch path is required')
  let current = root as any
  for (const segment of segments.slice(0, -1)) {
    if (current == null || !(segment in current)) throw unprocessable(`Patch path not found: ${path}`)
    current = current[segment]
  }
  const last = segments.at(-1)!
  if (current == null || !(last in current)) throw unprocessable(`Patch path not found: ${path}`)
  current[last] = value
}

function splitRequestedSteps(message: string) {
  const parts = message
    .split(/(?:\s*(?:然后|接着|随后|再)\s*|[；;\n]+)/)
    .map((part) => part.trim())
    .filter(Boolean)
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
}

async function planPublish(ctx: PlannerContext) {
  if (!/发布|正式版本/.test(ctx.message)) return null
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
  } satisfies ActionDraft
}

async function planWorkspacePatch(
  ctx: PlannerContext,
  patches: Array<{ path: string; value: unknown; label?: string }>,
) {
  if (patches.length === 0) return null
  const { draft, config } = await currentDraftConfig(ctx)
  const nextConfig = cloneConfig(config)
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
}

async function planShare(ctx: PlannerContext, input?: { versionNo?: number; versionName?: string; revoke?: boolean }) {
  const wantsShare = /分享|链接/.test(ctx.message)
  const revoke = input?.revoke ?? /撤销|取消|关闭|移除/.test(ctx.message)
  if (!wantsShare && !input) return null
  if (/发布|正式版本/.test(ctx.message)) return null
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
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
  } satisfies ActionDraft
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

async function callDeepSeekPlanner(ctx: PlannerContext): Promise<DeepSeekPlannerStep[] | null> {
  if (!ctx.settings.deepseekApiKey) return null

  const { config } = await currentDraftConfig(ctx)
  const periods = await listPeriods(ctx.db, ctx.workspace)
  const versions = await listVersions(ctx.db, ctx.workspace)
  const context = {
    months: config.months.map((month, index) => ({ label: month.label, index, id: month.id })),
    teamMembers: config.teamMembers.map((member) => ({ id: member.id, name: member.name })),
    versions: versions.map((version) => ({ versionNo: version.version_no, name: version.name, kind: version.kind })),
    periods: periods.map((period) => ({ id: period.id, monthLabel: period.monthLabel })),
    writableConfigExamples: [
      'operating.offlineUnitPrice',
      'operating.onlineUnitPrice',
      'operating.polaroidLossRate',
      'planning.startMonth',
      'planning.horizonMonths',
      'timelineTemplate.events',
      'timelineTemplate.salesMultiplier',
      'timelineTemplate.onlineSalesFactor',
      'months[0].events',
      'months[0].salesMultiplier',
      'months[0].onlineSalesFactor',
      'teamMembers[0].commissionRate',
      'teamMembers[0].monthlyBasePay',
      'teamMembers[0].perEventTravelCost',
      'shareholders[0].investmentAmount',
      'shareholders[0].dividendRate',
    ],
  }
  const system = [
    '你是 xox-model 的 Agent OS 规划器，只输出 JSON，不要输出解释。',
    '把用户中文指令拆成 steps 数组。一个用户消息可能包含多个动作，按顺序输出。',
    '账号登录、退出、注销、删除账号、改密码一律输出 intent=account.forbidden。',
    '写入动作只做计划，不执行。读取/预测可以输出 forecast 或 ui.navigate。',
    '可用 intent：ledger.create_member_income, ledger.void_entry, workspace.update_online_factor, workspace.patch_config, workspace.save_snapshot, workspace.publish_release, workspace.rollback_version, workspace.delete_version, workspace.reset_draft, share.create, share.revoke, ledger.set_period_lock, ui.navigate, account.forbidden。',
    'workspace.patch_config 使用 dot path 或 months[0].field 路径。只有当专用 intent 不适合时才用 patch_config。',
    '输出格式：{"steps":[{"intent":"...","monthLabel":"3月","memberName":"成员 A","offlineUnits":10,"onlineUnits":2,"mode":"write","onlineSalesFactor":0.3,"createShare":true,"versionNo":1,"locked":true,"patches":[{"path":"planning.horizonMonths","value":18,"label":"规划月份"}]}]}',
  ].join('\n')

  try {
    const response = await fetch(`${ctx.settings.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.settings.deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ctx.settings.deepseekModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `上下文：${JSON.stringify(context)}\n用户指令：${ctx.message}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 1600,
      }),
    })

    if (!response.ok) return null
    const body = (await response.json()) as any
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    const parsed = JSON.parse(content) as { steps?: DeepSeekPlannerStep[] }
    return Array.isArray(parsed.steps) ? parsed.steps : null
  } catch {
    return null
  }
}

async function plannedItemFromDeepSeekStep(ctx: PlannerContext, step: DeepSeekPlannerStep): Promise<PlannedItem | null> {
  if (step.intent === 'account.forbidden') {
    return {
      title: '账号动作需要手动完成',
      message: '账号登录、退出、注销、删除账号和密码类动作不能由 Agent 自动执行，请在账号入口手动操作。',
      status: 'info',
    }
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
    } satisfies ActionDraft
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
    } satisfies ActionDraft
  }
  if (step.intent === 'workspace.delete_version') return planDeleteVersion(ctx)
  if (step.intent === 'workspace.reset_draft') return planResetDraft(ctx)
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
    } satisfies ActionDraft
  }
  if (step.intent === 'ledger.void_entry') return planLedgerVoid(ctx)
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
  if (accountActionRequested(ctx.message)) {
    return [{
      title: '账号动作需要手动完成',
      message: '账号登录、退出、注销、删除账号和密码类动作不能由 Agent 自动执行，请在账号入口手动操作。',
      status: 'info',
    }]
  }

  const items: PlannedItem[] = []
  for (const part of splitRequestedSteps(ctx.message)) {
    const scopedCtx = { ...ctx, message: part }
    const plannedItems = [
      await planLedgerCreate(scopedCtx),
      await planOnlineFactor(scopedCtx),
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

async function modelPlannedItems(ctx: PlannerContext): Promise<PlannedItem[] | null> {
  const items: PlannedItem[] = []
  for (const part of splitRequestedSteps(ctx.message)) {
    const scopedCtx = { ...ctx, message: part }
    const steps = await callDeepSeekPlanner(scopedCtx)
    if (!steps || steps.length === 0) return null
    const partItems: PlannedItem[] = []
    for (const step of steps) {
      const item = await plannedItemFromDeepSeekStep(scopedCtx, step)
      if (item) partItems.push(item)
    }
    if (partItems.length > 0) {
      items.push(...partItems)
    } else {
      items.push(...(await localPlannedItems(scopedCtx)))
    }
  }
  return items.length > 0 ? items : null
}

async function planResponse(ctx: PlannerContext) {
  void operatorAgent

  const modelItems = await modelPlannedItems(ctx)
  const items = modelItems ?? (await localPlannedItems(ctx))
  const plannerSource = modelItems ? 'deepseek' : 'rules'
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const messages: string[] = []

  for (const [index, item] of items.entries()) {
    const sequence = index + 1
    if (isActionDraft(item)) {
      const action = await addActionRequest(ctx, item)
      const step = await addPlanStep(ctx, {
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
    const step = await addPlanStep(ctx, {
      sequence,
      title: item.title,
      description: item.message,
      status: item.status ?? 'info',
      navigation: item.navigation ?? null,
    })
    planRows.push(step)
    messages.push(item.message)
  }

  if (items.length > 0) {
    const actionCount = actionRows.length
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

async function executeAction(db: Kysely<Database>, settings: Settings, user: CurrentUser, action: Row<'agent_action_requests'>) {
  const workspace = await getWorkspaceForUser(db, user)
  if (workspace.id !== action.workspace_id || action.user_id !== user.id) throw forbidden()
  if (action.status !== 'pending') throw conflict('Agent action is not pending')
  const payload = parseJson<any>(action.payload_json, {})
  let result: unknown = null

  if (action.kind === 'ledger.create_entry') {
    result = await createActualEntry(db, { workspace, actor: user, ...payload })
  } else if (action.kind === 'ledger.update_entry') {
    result = await updateActualEntry(db, { workspace, actor: user, entryId: payload.entryId, ...payload })
  } else if (action.kind === 'ledger.void_entry') {
    await voidEntry(db, workspace, payload.entryId, user.id)
    result = { ok: true }
  } else if (action.kind === 'ledger.restore_entry') {
    await restoreEntry(db, workspace, payload.entryId, user.id)
    result = { ok: true }
  } else if (action.kind === 'workspace.update_draft') {
    result = await saveDraft(db, { workspace, actor: user, revision: payload.revision, workspaceName: payload.workspaceName, config: hydrateModelConfig(payload.config) })
  } else if (action.kind === 'workspace.save_snapshot') {
    result = await publishVersion(db, { workspace, actor: user, kind: 'snapshot' })
  } else if (action.kind === 'workspace.publish_release') {
    const version = await publishVersion(db, { workspace, actor: user, kind: 'release' })
    result = { version }
    if (payload.createShare) {
      result = { version, share: await createVersionShare(db, { workspace: { ...workspace, active_version_id: version.id }, actor: user, versionId: version.id }) }
    }
  } else if (action.kind === 'workspace.rollback_version') {
    result = await rollbackToVersion(db, { workspace, actor: user, versionId: payload.versionId })
  } else if (action.kind === 'workspace.delete_version') {
    await deleteVersion(db, workspace, payload.versionId)
    result = { ok: true }
  } else if (action.kind === 'workspace.reset_draft') {
    const draft = await getWorkspaceDraft(db, workspace)
    result = await saveDraft(db, { workspace, actor: user, revision: draft.revision, workspaceName: '默认工作区', config: createProductDefaultModel() })
  } else if (action.kind === 'ledger.lock_period') {
    result = await setPeriodStatus(db, workspace, payload.periodId, user.id, 'locked')
  } else if (action.kind === 'ledger.unlock_period') {
    result = await setPeriodStatus(db, workspace, payload.periodId, user.id, 'open')
  } else if (action.kind === 'share.create') {
    result = await createVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
  } else if (action.kind === 'share.revoke') {
    await revokeVersionShare(db, { workspace, actor: user, versionId: payload.versionId })
    result = { ok: true }
  } else {
    throw unprocessable(`Unsupported agent action: ${action.kind}`)
  }

  await db
    .updateTable('agent_action_requests')
    .set({ status: 'executed', executed_at: utcNow(), error_message: null })
    .where('id', '=', action.id)
    .execute()
  await db
    .updateTable('agent_plan_steps')
    .set({ status: 'executed', updated_at: utcNow() })
    .where('action_request_id', '=', action.id)
    .execute()
  await recordAudit(db, {
    workspaceId: workspace.id,
    actorId: user.id,
    action: 'agent.action_executed',
    entityType: 'agent_action_request',
    entityId: action.id,
    meta: { kind: action.kind, provider: settings.llmProvider },
  })
  return result
}

export function registerAgentRoutes(app: FastifyInstance, db: Kysely<Database>, settings: Settings) {
  app.post('/api/v1/agent/messages', async (request, reply) => {
    try {
      const body = request.body as { threadId?: string | null; message?: string }
      const message = body.message?.trim()
      if (!message) throw unprocessable('Message is required')
      const user = await requireCurrentUser(db, settings, request)
      const workspace = await getWorkspaceForUser(db, user)
      const thread = await getOrCreateThread(db, workspace, user, body.threadId)
      const runId = newId()
      const now = utcNow()
      await db.insertInto('agent_runs').values({ id: runId, thread_id: thread.id, user_id: user.id, status: 'running', created_at: now, completed_at: null }).execute()
      const userMessage = await addMessage(db, thread.id, 'user', message)
      const planned = await planResponse({ db, settings, user, workspace, threadId: thread.id, runId, message })
      const assistantMessage = await addMessage(db, thread.id, 'assistant', planned.assistant)
      await db.updateTable('agent_runs').set({ status: 'completed', completed_at: utcNow() }).where('id', '=', runId).execute()
      await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', thread.id).execute()
      return {
        threadId: thread.id,
        runId,
        planner: planned.plannerSource,
        messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)],
        navigationEvents: planned.navigationEvents,
        planSteps: planned.planRows.map(serializePlanStep),
        actionRequests: planned.actionRows.map(serializeAction),
      }
    } catch (error) {
      return reply.send(error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/confirm', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
      if (!action) throw notFound('Agent action request not found')
      const result = await executeAction(db, settings, user, action)
      const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
      const planSteps = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', action.run_id).orderBy('sequence_no', 'asc').execute()
      const assistant = await addMessage(db, action.thread_id, 'assistant', `已执行：${action.title}`)
      return { actionRequest: serializeAction(updated), result, messages: [serializeMessage(assistant)], planSteps: planSteps.map(serializePlanStep) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/agent/action-requests/:actionRequestId/cancel', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
      if (!action) throw notFound('Agent action request not found')
      if (action.user_id !== user.id) throw forbidden()
      if (action.status !== 'pending') throw conflict('Agent action is not pending')
      await db.updateTable('agent_action_requests').set({ status: 'cancelled' }).where('id', '=', action.id).execute()
      await db.updateTable('agent_plan_steps').set({ status: 'cancelled', updated_at: utcNow() }).where('action_request_id', '=', action.id).execute()
      const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
      const planSteps = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', action.run_id).orderBy('sequence_no', 'asc').execute()
      const assistant = await addMessage(db, action.thread_id, 'assistant', `已取消：${action.title}`)
      return { actionRequest: serializeAction(updated), messages: [serializeMessage(assistant)], planSteps: planSteps.map(serializePlanStep) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })

  app.patch('/api/v1/agent/action-requests/:actionRequestId', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      const { actionRequestId } = request.params as { actionRequestId: string }
      const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
      if (!action) throw notFound('Agent action request not found')
      if (action.user_id !== user.id) throw forbidden()
      if (action.status !== 'pending') throw conflict('Agent action is not pending')
      const body = request.body as AgentActionUpdatePayload
      const update: Partial<Row<'agent_action_requests'>> = {}
      if (typeof body.title === 'string') update.title = body.title.slice(0, 180)
      if (typeof body.summary === 'string') update.summary = body.summary
      if (typeof body.targetLabel === 'string') update.target_label = body.targetLabel.slice(0, 180)
      if (body.riskLevel && ['low', 'medium', 'high'].includes(body.riskLevel)) update.risk_level = body.riskLevel
      if (Array.isArray(body.details)) update.details_json = jsonString(body.details)
      if (body.navigation) update.navigation_json = jsonString(body.navigation)
      if ('payload' in body) update.payload_json = jsonString(body.payload)
      if (Object.keys(update).length === 0) throw unprocessable('No editable fields provided')
      await db.updateTable('agent_action_requests').set(update).where('id', '=', action.id).execute()
      const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
      await db
        .updateTable('agent_plan_steps')
        .set({
          title: updated.title,
          description: updated.summary,
          navigation_json: updated.navigation_json,
          updated_at: utcNow(),
        })
        .where('action_request_id', '=', action.id)
        .execute()
      const planSteps = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', action.run_id).orderBy('sequence_no', 'asc').execute()
      return { actionRequest: serializeAction(updated), planSteps: planSteps.map(serializePlanStep) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })
}
