import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { createProductDefaultModel, hydrateModelConfig, projectModel, type ModelConfig } from '@xox/domain'
import type {
  AgentActionKind,
  AgentActionRequest,
  AgentActionUpdatePayload,
  AgentMessage,
  AgentNavigationEvent,
  AgentPlannerSource,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentRunRecord,
  AgentThreadState,
  AgentThreadSummary,
} from '@xox/contracts'
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
  exportWorkspaceBundle,
  getWorkspaceDraft,
  getWorkspaceForUser,
  importWorkspaceBundle,
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
import { buildAgentWritableConfigContext } from '../agent/tool-coverage.js'
import { extractWorkspaceBundleArtifact, type ParsedWorkspaceBundleArtifact } from '../agent/workspace-bundle-artifact.js'
import { assertActionDraftAllowed, assertActionExecutionAllowed, assertActionUpdateAllowed, coerceAgentActionKind } from '../agent/tool-policy.js'

type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
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

type RuntimePlannerStep = RuntimePlanResult['steps'][number]

function serializeAction(row: Row<'agent_action_requests'>): AgentActionRequest {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: coerceAgentActionKind(row.kind),
    status: row.status as AgentActionRequest['status'],
    title: row.title,
    summary: row.summary,
    targetLabel: row.target_label,
    riskLevel: row.risk_level as AgentActionRequest['riskLevel'],
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

function serializePlanStep(row: Row<'agent_plan_steps'>): AgentPlanStep {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    actionRequestId: row.action_request_id,
    sequence: row.sequence_no,
    title: row.title,
    description: row.description,
    status: row.status as AgentPlanStepStatus,
    navigation: row.navigation_json ? parseJson<AgentNavigationEvent | null>(row.navigation_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageRole(value: string): AgentMessage['role'] {
  return value === 'assistant' || value === 'system' ? value : 'user'
}

function serializeMessage(row: Row<'agent_messages'>): AgentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: messageRole(row.role),
    content: row.content,
    createdAt: row.created_at,
  }
}

function plannerSource(value: string | null): AgentPlannerSource | null {
  return value === 'openai_agents' || value === 'openai_compatible_tool_calls' || value === 'rules'
    ? value
    : null
}

function runStatus(value: string): AgentRunRecord['status'] {
  return value === 'completed' || value === 'failed' ? value : 'running'
}

function serializeRun(row: Row<'agent_runs'>): AgentRunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: runStatus(row.status),
    planner: plannerSource(row.planner_source),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function threadTitleFromMessage(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized || 'Agent 对话'
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

async function getThreadForUser(db: Kysely<Database>, workspace: Row<'workspaces'>, user: CurrentUser, threadId: string) {
  const thread = await db.selectFrom('agent_threads').selectAll().where('id', '=', threadId).executeTakeFirst()
  if (!thread) throw notFound('Agent thread not found')
  if (thread.workspace_id !== workspace.id || thread.user_id !== user.id) throw forbidden()
  return thread
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

async function buildThreadSummary(db: Kysely<Database>, thread: Row<'agent_threads'>): Promise<AgentThreadSummary> {
  const [lastMessage, latestRun, pendingActions] = await Promise.all([
    db
      .selectFrom('agent_messages')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('agent_action_requests')
      .select('id')
      .where('thread_id', '=', thread.id)
      .where('status', '=', 'pending')
      .execute(),
  ])
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    lastMessage: lastMessage?.content ?? null,
    lastMessageAt: lastMessage?.created_at ?? null,
    latestRunStatus: latestRun ? runStatus(latestRun.status) : null,
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    pendingActionCount: pendingActions.length,
  }
}

async function buildThreadState(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  threadId: string,
): Promise<AgentThreadState> {
  const thread = await getThreadForUser(db, workspace, user, threadId)
  const [messages, runs, actions] = await Promise.all([
    db.selectFrom('agent_messages').selectAll().where('thread_id', '=', thread.id).orderBy('created_at', 'asc').execute(),
    db
      .selectFrom('agent_runs')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .execute(),
  ])
  const latestRun = runs[0] ?? null
  const planSteps = latestRun
    ? await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', latestRun.id).orderBy('sequence_no', 'asc').execute()
    : []
  const navigationEvents = planSteps
    .map((step) => (step.navigation_json ? parseJson<AgentNavigationEvent | null>(step.navigation_json, null) : null))
    .filter((event): event is AgentNavigationEvent => Boolean(event))

  return {
    thread: await buildThreadSummary(db, thread),
    messages: messages.map(serializeMessage),
    runs: runs.map(serializeRun),
    planner: latestRun ? plannerSource(latestRun.planner_source) : null,
    navigationEvents,
    planSteps: planSteps.map(serializePlanStep),
    actionRequests: actions.map(serializeAction),
  }
}

async function addActionRequest(ctx: PlannerContext, draft: ActionDraft) {
  assertActionDraftAllowed(draft)
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

function money(value: number) {
  return `¥${Math.round(value).toLocaleString('zh-CN')}`
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function normalizeDataMetrics(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
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

async function planDataQueryRead(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { config } = await currentDraftConfig(ctx)
  const projection = projectModel(config)
  const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null
  if (!baseScenario) return null

  const scope = step.scope === 'workspace_summary' || step.scope === 'period_summary' || step.scope === 'member_summary' || step.scope === 'top_months'
    ? step.scope
    : 'workspace_summary'
  const metrics = normalizeDataMetrics(step.metrics)

  if (scope === 'period_summary') {
    const period = step.monthLabel ? await periodForMonth(ctx, step.monthLabel) : null
    if (!period) return null
    const periods = await listPeriods(ctx.db, ctx.workspace)
    const summary = periods.find((item) => item.id === period.id) ?? periods.find((item) => item.monthLabel === period.monthLabel) ?? null
    const month = baseScenario.months.find((item) => item.monthIndex === period.monthIndex) ?? null
    const plannedRevenue = summary?.plannedRevenue ?? month?.grossSales ?? 0
    const plannedCost = summary?.plannedCost ?? month?.totalCost ?? 0
    const actualRevenue = summary?.actualRevenue ?? 0
    const actualCost = summary?.actualCost ?? 0
    const plannedProfit = plannedRevenue - plannedCost
    const actualProfit = actualRevenue - actualCost
    const includeActual = metrics.length === 0 || metrics.some((metric) => metric.startsWith('actual'))
    const parts = [
      `${period.monthLabel}计划收入 ${money(plannedRevenue)}`,
      `计划成本 ${money(plannedCost)}`,
      `计划利润 ${money(plannedProfit)}`,
      ...(includeActual ? [`实际收入 ${money(actualRevenue)}`, `实际成本 ${money(actualCost)}`, `实际利润 ${money(actualProfit)}`] : []),
    ]
    const route: AgentNavigationEvent['route'] = includeActual
      ? { mainTab: 'variance', secondaryTab: 'analysis', selectedPeriodId: period.id }
      : { mainTab: 'dashboard', secondaryTab: 'months', selectedPeriodId: period.id }
    return {
      title: '回答单月数据问题',
      message: `${parts.join('，')}。本次只读取当前工作区数据，未修改业务数据。`,
      navigation: {
        type: 'navigation',
        route,
        reason: '数据问答需要打开对应月份的分析页面，便于核对口径。',
      },
      status: 'executed',
    } satisfies ReadDraft
  }

  if (scope === 'member_summary') {
    const memberName = typeof step.memberName === 'string' ? step.memberName : null
    const member = memberName ? config.teamMembers.find((item) => item.name === memberName || item.id === memberName) ?? null : null
    if (!member) return null
    const targetMonths = step.monthLabel
      ? baseScenario.months.filter((month) => month.label === step.monthLabel)
      : baseScenario.months
    const totals = targetMonths.reduce(
      (sum, month) => {
        const item = month.members.find((candidate) => candidate.memberId === member.id)
        if (!item) return sum
        return {
          revenue: sum.revenue + item.grossSales,
          commission: sum.commission + item.commissionCost,
          contribution: sum.contribution + item.companyNetContribution,
        }
      },
      { revenue: 0, commission: 0, contribution: 0 },
    )
    const label = step.monthLabel ? `${step.monthLabel}${member.name}` : `${member.name}全周期`
    return {
      title: '回答成员数据问题',
      message: `${label}计划收入 ${money(totals.revenue)}，计划提成 ${money(totals.commission)}，公司净贡献 ${money(totals.contribution)}。本次只读取当前工作区数据，未修改业务数据。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'members' },
        reason: '成员数据问答需要打开成员分析页面，便于核对口径。',
      },
      status: 'executed',
    } satisfies ReadDraft
  }

  if (scope === 'top_months') {
    const metric = metrics[0] ?? 'plannedProfit'
    const metricValue = (month: (typeof baseScenario.months)[number]) => {
      if (metric === 'plannedRevenue') return month.grossSales
      if (metric === 'plannedCost') return month.totalCost
      if (metric === 'cash') return month.cumulativeCash
      return month.monthlyProfit
    }
    const order = step.order === 'asc' ? 'asc' : 'desc'
    const limit = Math.min(6, Math.max(1, Math.round(typeof step.limit === 'number' ? step.limit : 3)))
    const ranked = baseScenario.months
      .map((month) => ({ month, value: metricValue(month) }))
      .sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value))
      .slice(0, limit)
    return {
      title: '回答月份排行问题',
      message: `按${metric === 'plannedRevenue' ? '计划收入' : metric === 'plannedCost' ? '计划成本' : metric === 'cash' ? '累计现金' : '计划利润'}${order === 'asc' ? '升序' : '降序'}，前 ${limit} 个月份是：${ranked.map((item) => `${item.month.label} ${money(item.value)}`).join('；')}。本次只读取当前工作区数据，未修改业务数据。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'months' },
        reason: '月份排行问答需要打开按月分析页面，便于核对口径。',
      },
      status: 'executed',
    } satisfies ReadDraft
  }

  return {
    title: '回答工作区数据问题',
    message: `基准场景总收入 ${money(baseScenario.grossSales)}，总成本 ${money(baseScenario.totalCost)}，总利润 ${money(baseScenario.totalProfit)}，期末现金 ${money(baseScenario.netCashAfterInvestment)}，投资回报率 ${pct(baseScenario.roi)}，回本周期 ${baseScenario.paybackMonthLabel ?? '未回本'}。本次只读取当前工作区数据，未修改业务数据。`,
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      reason: '工作区数据问答需要打开经营总览页面，便于核对口径。',
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
  } satisfies ActionDraft
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
  })
}

async function plannedItemFromRuntimeStep(ctx: PlannerContext, step: RuntimePlannerStep): Promise<PlannedItem | null> {
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
    } satisfies ActionDraft
  }
  if (step.intent === 'ledger.void_entry') return planLedgerVoid(ctx)
  if (step.intent === 'data.query_workspace') return planDataQueryRead(ctx, step)
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
  await assertActionExecutionAllowed(db, workspace, user, action)
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
  } else if (action.kind === 'workspace.import_bundle') {
    result = await importWorkspaceBundle(db, { workspace, actor: user, bundle: payload.bundle })
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

  app.post('/api/v1/agent/messages', async (request, reply) => {
    let runId: string | null = null
    let activeThread: Row<'agent_threads'> | null = null
    try {
      const body = request.body as { threadId?: string | null; message?: string }
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
        .values({ id: runId, thread_id: thread.id, user_id: user.id, status: 'running', planner_source: null, created_at: now, completed_at: null })
        .execute()
      const userMessage = await addMessage(db, thread.id, 'user', message)
      await rememberFromUserMessage({ db, workspace, user, threadId: thread.id, messageId: userMessage.id, message })
      const planned = await planResponse({ db, settings, user, workspace, threadId: thread.id, runId, message })
      const assistantMessage = await addMessage(db, thread.id, 'assistant', planned.assistant)
      await compactThreadContextIfNeeded({ db, workspace, user, threadId: thread.id })
      await db.updateTable('agent_runs').set({ status: 'completed', planner_source: planned.plannerSource, completed_at: utcNow() }).where('id', '=', runId).execute()
      await db
        .updateTable('agent_threads')
        .set({
          title: thread.title === 'Agent 对话' ? threadTitleFromMessage(message) : thread.title,
          updated_at: utcNow(),
        })
        .where('id', '=', thread.id)
        .execute()
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
      if (runId && activeThread) {
        await db.updateTable('agent_runs').set({ status: 'failed', completed_at: utcNow() }).where('id', '=', runId).execute().catch(() => undefined)
        await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', activeThread.id).execute().catch(() => undefined)
      }
      return reply.send(error)
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
      const action = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', actionRequestId).executeTakeFirst()
      if (!action) throw notFound('Agent action request not found')
      const result = await executeAction(db, settings, user, action)
      const updated = await db.selectFrom('agent_action_requests').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()
      const planSteps = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', action.run_id).orderBy('sequence_no', 'asc').execute()
      const assistant = await addMessage(db, action.thread_id, 'assistant', `已执行：${action.title}`)
      await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
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
      await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
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
      assertActionUpdateAllowed(coerceAgentActionKind(action.kind), {
        ...(update.risk_level ? { riskLevel: update.risk_level as never } : {}),
        ...(body.navigation ? { navigation: body.navigation } : {}),
      })
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
      await db.updateTable('agent_threads').set({ updated_at: utcNow() }).where('id', '=', action.thread_id).execute()
      const planSteps = await db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', action.run_id).orderBy('sequence_no', 'asc').execute()
      return { actionRequest: serializeAction(updated), planSteps: planSteps.map(serializePlanStep) }
    } catch (error) {
      const { sendError } = await import('../core/http.js')
      return sendError(reply, error)
    }
  })
}
