import type { Kysely } from 'kysely'
import {
  createCostItem,
  createEmployee,
  createMember,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
  hydrateModelConfig,
  projectModel,
  type CostCategory,
  type CostItem,
  type Employee,
  type EmploymentType,
  type ModelConfig,
  type Shareholder,
  type StageCostItem,
  type StageCostMode,
  type TeamMember,
} from '@xox/domain'
import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import type { Settings } from '../core/settings.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { exportWorkspaceBundle, getWorkspaceDraft } from '../modules/workspace.js'
import { listEntries, listPeriods, listSubjectsForPeriod } from '../modules/ledger.js'
import { redactSecretLikeContent } from './memory.js'
import { planWithRuntimeAdapter } from './runtime/adapter-router.js'
import type { RuntimePlanError, RuntimePlanResult, RuntimeStreamEvent } from './runtime/runtime-adapter.js'
import { assertAgentRunLease } from './run-lease.js'
import { agentThreadEvents } from './thread-events.js'
import { projectAgentTools } from './tool-projector.js'
import { extractWorkspaceBundleArtifact, type ParsedWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'
import { addRunEvent } from './run-events.js'
import { addAgentActionRequest, addAgentPlanStep, type AgentActionDraft } from './action-requests.js'
import { answerWorkspaceDataQuestion } from './data-agent.js'
import { cloneModelConfig, getConfigPath, setConfigPath } from './config-patch.js'
import { buildAgentContextPack } from './context-pack.js'
import {
  accountForbiddenRead,
  buildPlannedItemFromRuntimeStep,
  isActionDraft,
  type ActionDraftBuilderHandlers,
  type PlannedItem,
  type ReadDraft,
  type RuntimePlannerStep,
} from './action-draft-builder.js'
import {
  buildPublishReleaseDraft,
  planDeleteVersionAction,
  planPromoteVersionAction,
  planPublishVersionAction,
  planResetDraftAction,
  planRollbackVersionAction,
  planSaveSnapshotAction,
  planShareAction,
} from './version-action-drafts.js'

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

function accountActionRequested(message: string) {
  return /(注销|删除账号|退出登录|登录|注册|改密码|密码)/.test(message)
}

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

type LedgerSubject = Awaited<ReturnType<typeof listSubjectsForPeriod>>[number]
type LedgerEntry = Awaited<ReturnType<typeof listEntries>>[number]

type SubjectLookup =
  | { status: 'found'; subject: LedgerSubject }
  | { status: 'missing' | 'ambiguous'; message: string }

type EntryLookup =
  | { status: 'found'; entry: LedgerEntry; period: Awaited<ReturnType<typeof periodForMonth>> }
  | { status: 'missing' | 'ambiguous'; message: string; period: Awaited<ReturnType<typeof periodForMonth>> | null }

function normalizedLookup(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function moneyAmount(value: unknown) {
  const number = finiteNumber(value)
  return number === null ? null : Math.round(number * 100) / 100
}

function isoFromDateLike(value: unknown) {
  const raw = asNonEmptyString(value)
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00.000Z`).toISOString()
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function subjectMatches(subject: LedgerSubject, key?: unknown, name?: unknown) {
  const subjectKey = asNonEmptyString(key)
  if (subjectKey && subject.subjectKey === subjectKey) return true
  const subjectName = asNonEmptyString(name)
  if (!subjectName) return false
  const normalized = normalizedLookup(subjectName)
  return normalizedLookup(subject.subjectName) === normalized || normalizedLookup(subject.subjectName).includes(normalized)
}

async function resolveLedgerSubject(ctx: PlannerContext, periodId: string, step: RuntimePlannerStep, direction?: 'income' | 'expense'): Promise<SubjectLookup> {
  const subjects = await listSubjectsForPeriod(ctx.db, ctx.workspace, periodId)
  const expectedType = direction === 'income' ? 'revenue' : direction === 'expense' ? 'cost' : null
  const matches = subjects.filter((subject) => {
    if (expectedType && subject.subjectType !== expectedType) return false
    return subjectMatches(subject, step.subjectKey ?? step.newSubjectKey, step.subjectName ?? step.newSubjectName)
  })
  if (matches.length === 1) return { status: 'found', subject: matches[0]! }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      message: `找到多个匹配科目：${matches.map((subject) => `${subject.subjectName}(${subject.subjectKey})`).join('、')}。请补充更精确的科目名或 subjectKey。`,
    }
  }
  return {
    status: 'missing',
    message: `没有找到匹配科目。当前可用科目有：${subjects.filter((subject) => !expectedType || subject.subjectType === expectedType).map((subject) => subject.subjectName).join('、')}。`,
  }
}

function resolveRelatedEntity(config: ModelConfig, step: RuntimePlannerStep, preferredType?: 'teamMember' | 'employee' | null) {
  const relatedEntityId = asNonEmptyString(step.relatedEntityId)
  const relatedEntityName = asNonEmptyString(step.relatedEntityName) ?? asNonEmptyString(step.newRelatedEntityName)
  const requestedType = step.relatedEntityType === 'teamMember' || step.relatedEntityType === 'employee' ? step.relatedEntityType : preferredType ?? null

  if (requestedType === 'teamMember') {
    const member = findTeamMember(config, { memberId: relatedEntityId, memberName: relatedEntityName })
    return member ? { type: 'teamMember' as const, id: member.id, name: member.name } : null
  }
  if (requestedType === 'employee') {
    const employee = findEmployee(config, { employeeId: relatedEntityId, employeeName: relatedEntityName })
    return employee ? { type: 'employee' as const, id: employee.id, name: employee.name } : null
  }

  if (relatedEntityId || relatedEntityName) {
    const member = findTeamMember(config, { memberId: relatedEntityId, memberName: relatedEntityName })
    if (member) return { type: 'teamMember' as const, id: member.id, name: member.name }
    const employee = findEmployee(config, { employeeId: relatedEntityId, employeeName: relatedEntityName })
    if (employee) return { type: 'employee' as const, id: employee.id, name: employee.name }
  }
  return null
}

function requiredRelatedType(subject: LedgerSubject) {
  if (subject.subjectKey === 'cost.member.base_pay' || subject.subjectKey === 'cost.member.travel') return 'teamMember' as const
  if (subject.subjectKey === 'cost.employee.base_pay' || subject.subjectKey === 'cost.employee.per_event') return 'employee' as const
  return null
}

function ledgerNavigation(periodId: string, reason: string, focusRecordId?: string | null): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: periodId },
    ...(focusRecordId ? { focusRecordId } : {}),
    reason,
  }
}

async function planGenericLedgerCreateFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const monthLabel = asNonEmptyString(step.monthLabel)
  const direction = step.direction === 'income' || step.direction === 'expense' ? step.direction : null
  const amount = moneyAmount(step.amount)
  if (!monthLabel || !direction || amount === null || amount <= 0) {
    return {
      title: '需要补充入账信息',
      message: '通用入账需要月份、收入/支出方向、金额和科目。请补充缺失信息。',
      status: 'info',
      navigation: { type: 'navigation', route: { mainTab: 'bookkeeping', secondaryTab: 'entries' }, reason: '入账动作需要打开记账工作台。' },
    } satisfies ReadDraft
  }
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const subjectLookup = await resolveLedgerSubject(ctx, period.id, step, direction)
  if (subjectLookup.status !== 'found') {
    return {
      title: subjectLookup.status === 'ambiguous' ? '需要指定唯一科目' : '没有找到科目',
      message: subjectLookup.message,
      status: subjectLookup.status === 'ambiguous' ? 'info' : 'failed',
      navigation: ledgerNavigation(period.id, '入账动作需要打开本期账本并选中目标账期。'),
    } satisfies ReadDraft
  }

  const { config } = await currentDraftConfig(ctx)
  const requiredType = requiredRelatedType(subjectLookup.subject)
  const related = resolveRelatedEntity(config, step, requiredType)
  if (requiredType && !related) {
    return {
      title: '需要指定归属对象',
      message: `“${subjectLookup.subject.subjectName}”需要指定${requiredType === 'teamMember' ? '成员' : '员工'}。`,
      status: 'info',
      navigation: ledgerNavigation(period.id, '按人支出需要打开本期账本并选中目标账期。'),
    } satisfies ReadDraft
  }
  if ((step.relatedEntityName || step.relatedEntityId) && !related) {
    return {
      title: '没有找到归属对象',
      message: `没有找到匹配“${step.relatedEntityName ?? step.relatedEntityId}”的成员或员工。`,
      status: 'failed',
      navigation: ledgerNavigation(period.id, '入账动作需要打开本期账本并选中目标账期。'),
    } satisfies ReadDraft
  }

  const occurredAt = isoFromDateLike(step.occurredAt) ?? periodOccurrenceDate(config, period)
  const details = [
    { label: '期间', value: period.monthLabel },
    { label: '方向', value: direction === 'income' ? '收入' : '支出' },
    { label: '科目', value: subjectLookup.subject.subjectName },
    { label: '金额', value: `${amount}` },
    { label: '发生日', value: occurredAt.slice(0, 10) },
    ...(related ? [{ label: '归属对象', value: related.name }] : []),
    ...(step.counterparty ? [{ label: '对方单位', value: String(step.counterparty) }] : []),
    ...(step.description ? [{ label: '备注', value: String(step.description) }] : []),
  ]

  return {
    kind: 'ledger.create_entry',
    title: direction === 'income' ? '确认收入入账' : '确认支出入账',
    summary: `${period.monthLabel}${related ? ` ${related.name}` : ''} ${subjectLookup.subject.subjectName} ${amount} 元入账。`,
    targetLabel: `${period.monthLabel} / ${subjectLookup.subject.subjectName}`,
    riskLevel: 'medium',
    details,
    navigation: ledgerNavigation(period.id, '入账动作需要打开本期账本并选中目标账期。'),
    payload: {
      ledgerPeriodId: period.id,
      direction,
      amount,
      occurredAt,
      ...(step.counterparty ? { counterparty: String(step.counterparty) } : {}),
      ...(step.description ? { description: String(step.description) } : {}),
      ...(related ? { relatedEntityType: related.type, relatedEntityId: related.id, relatedEntityName: related.name } : {}),
      allocations: [{
        subjectKey: subjectLookup.subject.subjectKey,
        subjectName: subjectLookup.subject.subjectName,
        subjectType: subjectLookup.subject.subjectType,
        amount,
      }],
    },
  } satisfies AgentActionDraft
}

async function postedAmountBySubjectAndEntity(ctx: PlannerContext, periodId: string) {
  const entries = await listEntries(ctx.db, ctx.workspace, periodId)
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.status !== 'posted') continue
    for (const allocation of entry.allocations) {
      const key = `${allocation.subjectKey}:${entry.relatedEntityId ?? ''}`
      totals.set(key, Math.round(((totals.get(key) ?? 0) + allocation.amount) * 100) / 100)
    }
  }
  return totals
}

async function planPlannedMemberIncomeBatch(ctx: PlannerContext, step: RuntimePlannerStep) {
  const monthLabel = asNonEmptyString(step.monthLabel)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const { config } = await currentDraftConfig(ctx)
  const month = projectModel(config).scenarios.find((scenario) => scenario.key === 'base')?.months.find((item) => item.monthIndex === period.monthIndex)
  if (!month) return null
  const posted = await postedAmountBySubjectAndEntity(ctx, period.id)
  const actions: PlannedItem[] = []
  for (const member of month.members) {
    const postedOffline = posted.get(`revenue.offline_sales:${member.memberId}`) ?? 0
    const postedOnline = posted.get(`revenue.online_sales:${member.memberId}`) ?? 0
    const plannedOfflineUnits = Math.max(0, member.monthlyUnits - postedOffline / Math.max(config.operating.offlineUnitPrice, 1))
    const plannedOnlineUnits = Math.max(0, member.monthlyUnits * month.onlineSalesFactor - postedOnline / Math.max(config.operating.onlineUnitPrice, 1))
    const action = await planLedgerCreateFromFields(ctx, {
      monthLabel,
      memberName: member.name,
      offlineUnits: Math.round(plannedOfflineUnits * 100) / 100,
      onlineUnits: Math.round(plannedOnlineUnits * 100) / 100,
    })
    if (action) actions.push(action)
  }
  return actions.length > 0 ? actions : [{
    title: '没有待入账成员收入',
    message: `${monthLabel}没有可按计划补入的成员收入。`,
    status: 'info',
    navigation: ledgerNavigation(period.id, '一键入账需要打开本期账本并选中目标账期。'),
  } satisfies ReadDraft]
}

function relatedExpenseRowsForMonth(config: ModelConfig, monthIndex: number, subject: LedgerSubject) {
  const month = projectModel(config).scenarios.find((scenario) => scenario.key === 'base')?.months.find((item) => item.monthIndex === monthIndex)
  if (!month) return []
  if (subject.subjectKey === 'cost.member.base_pay') return month.members.map((member) => ({ type: 'teamMember' as const, id: member.memberId, name: member.name, amount: member.basePayCost }))
  if (subject.subjectKey === 'cost.member.travel') return month.members.map((member) => ({ type: 'teamMember' as const, id: member.memberId, name: member.name, amount: member.travelCost }))
  if (subject.subjectKey === 'cost.employee.base_pay') return month.employees.map((employee) => ({ type: 'employee' as const, id: employee.employeeId, name: employee.name, amount: employee.basePayCost }))
  if (subject.subjectKey === 'cost.employee.per_event') return month.employees.map((employee) => ({ type: 'employee' as const, id: employee.employeeId, name: employee.name, amount: employee.perEventCost }))
  return []
}

async function planPlannedRelatedExpenseBatch(ctx: PlannerContext, step: RuntimePlannerStep) {
  const monthLabel = asNonEmptyString(step.monthLabel)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const subjectLookup = await resolveLedgerSubject(ctx, period.id, step, 'expense')
  if (subjectLookup.status !== 'found') {
    return {
      title: subjectLookup.status === 'ambiguous' ? '需要指定唯一科目' : '没有找到科目',
      message: subjectLookup.message,
      status: subjectLookup.status === 'ambiguous' ? 'info' : 'failed',
      navigation: ledgerNavigation(period.id, '按人支出一键入账需要打开本期账本。'),
    } satisfies ReadDraft
  }
  const { config } = await currentDraftConfig(ctx)
  const rows = relatedExpenseRowsForMonth(config, period.monthIndex, subjectLookup.subject)
  const posted = await postedAmountBySubjectAndEntity(ctx, period.id)
  const actions: PlannedItem[] = []
  for (const row of rows) {
    const amount = Math.round(Math.max(0, row.amount - (posted.get(`${subjectLookup.subject.subjectKey}:${row.id}`) ?? 0)) * 100) / 100
    if (amount <= 0) continue
    const action = await planGenericLedgerCreateFromStep(ctx, {
      intent: 'ledger.create_entry',
      monthLabel,
      direction: 'expense',
      subjectKey: subjectLookup.subject.subjectKey,
      amount,
      relatedEntityType: row.type,
      relatedEntityId: row.id,
    } as RuntimePlannerStep)
    if (action) actions.push(action)
  }
  return actions.length > 0 ? actions : [{
    title: '没有待入账按人支出',
    message: `${monthLabel}${subjectLookup.subject.subjectName}没有可按计划补入的支出。`,
    status: 'info',
    navigation: ledgerNavigation(period.id, '按人支出一键入账需要打开本期账本。'),
  } satisfies ReadDraft]
}

function entryIncludesKeyword(entry: LedgerEntry, keyword: string) {
  const normalized = normalizedLookup(keyword)
  const haystack = [
    entry.counterparty,
    entry.description,
    entry.relatedEntityName,
    entry.direction === 'income' ? '收入' : '支出',
    entry.status === 'voided' ? '已作废' : '已过账',
    ...entry.allocations.flatMap((allocation) => [allocation.subjectKey, allocation.subjectName]),
  ]
  return haystack.some((item) => item && normalizedLookup(item).includes(normalized))
}

async function findLedgerEntryForStep(
  ctx: PlannerContext,
  step: RuntimePlannerStep,
  desiredStatus: 'posted' | 'voided',
): Promise<EntryLookup> {
  const monthLabel = asNonEmptyString(step.monthLabel)
  const period = monthLabel ? await periodForMonth(ctx, monthLabel) : null
  if (!period) return { status: 'missing', message: '需要指定账本月份。', period: null }
  const entries = await listEntries(ctx.db, ctx.workspace, period.id)
  const entryId = asNonEmptyString(step.entryId)
  if (entryId) {
    const entry = entries.find((item) => item.id === entryId)
    if (!entry) return { status: 'missing', message: `没有找到分录 ${entryId}。`, period }
    if (entry.status !== desiredStatus) return { status: 'missing', message: `分录状态不是${desiredStatus === 'posted' ? '已过账' : '已作废'}。`, period }
    return { status: 'found', entry, period }
  }

  const amount = moneyAmount(step.amount)
  const occurredOn = asNonEmptyString(step.occurredOn)
  const subjectKey = asNonEmptyString(step.subjectKey)
  const subjectName = asNonEmptyString(step.subjectName)
  const relatedEntityName = asNonEmptyString(step.relatedEntityName) ?? asNonEmptyString(step.memberName) ?? asNonEmptyString(step.employeeName)
  const keyword = asNonEmptyString(step.keyword)
  const direction = step.direction === 'income' || step.direction === 'expense' ? step.direction : null

  const candidates = entries.filter((entry) => {
    if (entry.entryOrigin === 'derived') return false
    if (entry.status !== desiredStatus) return false
    if (direction && entry.direction !== direction) return false
    if (amount !== null && Math.abs(entry.amount - amount) >= 0.005) return false
    if (occurredOn && entry.occurredAt.slice(0, 10) !== occurredOn) return false
    if (relatedEntityName && normalizedLookup(entry.relatedEntityName ?? '') !== normalizedLookup(relatedEntityName)) return false
    if (subjectKey && !entry.allocations.some((allocation) => allocation.subjectKey === subjectKey)) return false
    if (subjectName && !entry.allocations.some((allocation) => normalizedLookup(allocation.subjectName).includes(normalizedLookup(subjectName)))) return false
    if (keyword && !entryIncludesKeyword(entry, keyword)) return false
    return true
  })

  if (candidates.length === 1) return { status: 'found', entry: candidates[0]!, period }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      message: `找到 ${candidates.length} 笔匹配分录：${candidates.slice(0, 5).map((entry) => `${entry.occurredAt.slice(0, 10)} ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '分录'} ${entry.amount}元`).join('；')}。请补充 entryId、金额、日期、科目或对象。`,
      period,
    }
  }
  return { status: 'missing', message: '没有找到匹配的账本分录。请补充更精确的金额、日期、科目、对象或 entryId。', period }
}

async function planLedgerVoidFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const lookup = await findLedgerEntryForStep(ctx, step, 'posted')
  if (lookup.status !== 'found') {
    return {
      title: lookup.status === 'ambiguous' ? '需要唯一定位分录' : '没有找到可作废分录',
      message: lookup.message,
      status: lookup.status === 'ambiguous' ? 'info' : 'failed',
      navigation: lookup.period ? ledgerNavigation(lookup.period.id, '作废分录需要打开本期账本。') : { type: 'navigation', route: { mainTab: 'bookkeeping', secondaryTab: 'entries' }, reason: '作废分录需要打开账本。' },
    } satisfies ReadDraft
  }
  const { entry, period } = lookup
  if (!period) return null
  return {
    kind: 'ledger.void_entry',
    title: '确认作废分录',
    summary: `作废${period.monthLabel} ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'} 的 ${entry.amount} 元分录，关联派生分录会同步作废。`,
    targetLabel: `${period.monthLabel} / ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'}`,
    riskLevel: 'high',
    details: [
      { label: '期间', value: period.monthLabel },
      { label: '发生日', value: entry.occurredAt.slice(0, 10) },
      { label: '金额', value: `${entry.amount}` },
      { label: '对象', value: entry.relatedEntityName ?? '-' },
      { label: '科目', value: entry.allocations.map((allocation) => allocation.subjectName).join(' / ') },
    ],
    navigation: ledgerNavigation(period.id, '作废分录需要打开本期账本并定位记录。', entry.id),
    payload: { entryId: entry.id },
  } satisfies AgentActionDraft
}

async function planLedgerRestoreFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const lookup = await findLedgerEntryForStep(ctx, step, 'voided')
  if (lookup.status !== 'found') {
    return {
      title: lookup.status === 'ambiguous' ? '需要唯一定位分录' : '没有找到已作废分录',
      message: lookup.message,
      status: lookup.status === 'ambiguous' ? 'info' : 'failed',
      navigation: lookup.period ? ledgerNavigation(lookup.period.id, '恢复分录需要打开本期账本。') : { type: 'navigation', route: { mainTab: 'bookkeeping', secondaryTab: 'entries' }, reason: '恢复分录需要打开账本。' },
    } satisfies ReadDraft
  }
  const { entry, period } = lookup
  if (!period) return null
  return {
    kind: 'ledger.restore_entry',
    title: '确认取消作废分录',
    summary: `恢复${period.monthLabel} ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'} 的 ${entry.amount} 元分录，关联派生分录会同步恢复。`,
    targetLabel: `${period.monthLabel} / ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'}`,
    riskLevel: 'high',
    details: [
      { label: '期间', value: period.monthLabel },
      { label: '发生日', value: entry.occurredAt.slice(0, 10) },
      { label: '金额', value: `${entry.amount}` },
      { label: '对象', value: entry.relatedEntityName ?? '-' },
    ],
    navigation: ledgerNavigation(period.id, '恢复分录需要打开本期账本并定位记录。', entry.id),
    payload: { entryId: entry.id },
  } satisfies AgentActionDraft
}

async function allocationInputsForUpdate(ctx: PlannerContext, periodId: string, entry: LedgerEntry, step: RuntimePlannerStep, amount: number) {
  if (Array.isArray(step.allocations) && step.allocations.length > 0) {
    const allocations = []
    for (const raw of step.allocations) {
      const allocationAmount = moneyAmount(raw.amount)
      if (allocationAmount === null || allocationAmount <= 0) continue
      const subjectLookup = await resolveLedgerSubject(ctx, periodId, {
        ...step,
        subjectKey: raw.subjectKey,
        subjectName: raw.subjectName,
      } as RuntimePlannerStep, entry.direction)
      if (subjectLookup.status !== 'found') return subjectLookup
      allocations.push({ ...subjectLookup.subject, amount: allocationAmount })
    }
    return { status: 'found' as const, allocations }
  }

  if (step.newSubjectKey || step.newSubjectName) {
    const subjectLookup = await resolveLedgerSubject(ctx, periodId, {
      ...step,
      subjectKey: step.newSubjectKey,
      subjectName: step.newSubjectName,
    } as RuntimePlannerStep, entry.direction)
    if (subjectLookup.status !== 'found') return subjectLookup
    return { status: 'found' as const, allocations: [{ ...subjectLookup.subject, amount }] }
  }

  if (entry.allocations.length === 1) {
    return { status: 'found' as const, allocations: [{ ...entry.allocations[0]!, amount }] }
  }

  const originalTotal = Math.max(entry.amount, 0.01)
  return {
    status: 'found' as const,
    allocations: entry.allocations.map((allocation) => ({
      ...allocation,
      amount: Math.round((allocation.amount / originalTotal) * amount * 100) / 100,
    })),
  }
}

async function planLedgerUpdateFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const lookup = await findLedgerEntryForStep(ctx, step, 'posted')
  if (lookup.status !== 'found') {
    return {
      title: lookup.status === 'ambiguous' ? '需要唯一定位分录' : '没有找到可修改分录',
      message: lookup.message,
      status: lookup.status === 'ambiguous' ? 'info' : 'failed',
      navigation: lookup.period ? ledgerNavigation(lookup.period.id, '修改分录需要打开本期账本。') : { type: 'navigation', route: { mainTab: 'bookkeeping', secondaryTab: 'entries' }, reason: '修改分录需要打开账本。' },
    } satisfies ReadDraft
  }
  const { entry, period } = lookup
  if (!period) return null
  const amount = moneyAmount(step.newAmount) ?? moneyAmount(step.amount) ?? entry.amount
  if (amount <= 0) return null
  const allocations = await allocationInputsForUpdate(ctx, period.id, entry, step, amount)
  if (allocations.status !== 'found') {
    return {
      title: allocations.status === 'ambiguous' ? '需要指定唯一科目' : '没有找到科目',
      message: allocations.message,
      status: allocations.status === 'ambiguous' ? 'info' : 'failed',
      navigation: ledgerNavigation(period.id, '修改分录需要打开本期账本。', entry.id),
    } satisfies ReadDraft
  }
  const { config } = await currentDraftConfig(ctx)
  const related = resolveRelatedEntity(config, {
    ...step,
    relatedEntityName: step.newRelatedEntityName ?? step.relatedEntityName ?? entry.relatedEntityName ?? undefined,
    relatedEntityId: step.relatedEntityId ?? entry.relatedEntityId ?? undefined,
    relatedEntityType: step.relatedEntityType ?? entry.relatedEntityType ?? undefined,
  } as RuntimePlannerStep)
  const occurredAt = isoFromDateLike(step.newOccurredAt) ?? entry.occurredAt
  const counterparty = step.counterparty === undefined ? entry.counterparty ?? undefined : asNonEmptyString(step.counterparty) ?? undefined
  const description = step.description === undefined ? entry.description ?? undefined : asNonEmptyString(step.description) ?? undefined

  return {
    kind: 'ledger.update_entry',
    title: '确认修改历史分录',
    summary: `修改${period.monthLabel} ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'}，金额 ${entry.amount} -> ${amount} 元。`,
    targetLabel: `${period.monthLabel} / ${entry.relatedEntityName ?? entry.allocations[0]?.subjectName ?? '账本分录'}`,
    riskLevel: 'medium',
    details: [
      { label: '期间', value: period.monthLabel },
      { label: '分录 ID', value: entry.id },
      { label: '金额', value: `${entry.amount} -> ${amount}` },
      { label: '科目', value: allocations.allocations.map((allocation) => allocation.subjectName).join(' / ') },
      { label: '发生日', value: occurredAt.slice(0, 10) },
      { label: '归属对象', value: related?.name ?? '-' },
    ],
    navigation: ledgerNavigation(period.id, '修改分录需要打开本期账本并定位记录。', entry.id),
    payload: {
      entryId: entry.id,
      amount,
      occurredAt,
      ...(counterparty ? { counterparty } : {}),
      ...(description ? { description } : {}),
      ...(related ? { relatedEntityType: related.type, relatedEntityId: related.id, relatedEntityName: related.name } : {}),
      allocations: allocations.allocations.map((allocation) => ({
        subjectKey: allocation.subjectKey,
        subjectName: allocation.subjectName,
        subjectType: allocation.subjectType,
        amount: allocation.amount,
      })),
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

function memberWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'revenue' },
    reason,
  }
}

function finiteNumber(value: unknown) {
  if (value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedCommissionRate(value: unknown) {
  const number = finiteNumber(value)
  if (number === null) return null
  return number > 1 && number <= 100 ? Math.round((number / 100) * 10000) / 10000 : number
}

function isEmploymentType(value: unknown): value is EmploymentType {
  return value === 'salary' || value === 'partTime'
}

function normalizedMemberKey(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

function defaultTeamMemberName(config: ModelConfig) {
  const existing = new Set(config.teamMembers.map((member) => normalizedMemberKey(member.name)))
  let index = config.teamMembers.length + 1
  while (existing.has(normalizedMemberKey(`成员 ${index}`))) index += 1
  return `成员 ${index}`
}

function findTeamMember(config: ModelConfig, input: { memberId?: string | null | undefined; memberName?: string | null | undefined }) {
  const memberId = typeof input.memberId === 'string' ? input.memberId.trim() : ''
  if (memberId) {
    const byId = config.teamMembers.find((member) => member.id === memberId)
    if (byId) return byId
  }

  const memberName = typeof input.memberName === 'string' ? input.memberName.trim() : ''
  if (!memberName) return null
  const normalized = normalizedMemberKey(memberName)
  return config.teamMembers.find((member) => member.id === memberName || normalizedMemberKey(member.name) === normalized) ?? null
}

function applyTeamMemberToolFields(member: TeamMember, step: RuntimePlannerStep) {
  const next: TeamMember = {
    ...member,
    unitsPerEvent: { ...member.unitsPerEvent },
  }
  if (isEmploymentType(step.employmentType)) next.employmentType = step.employmentType

  const monthlyBasePay = finiteNumber(step.monthlyBasePay)
  if (monthlyBasePay !== null) next.monthlyBasePay = monthlyBasePay

  const perEventTravelCost = finiteNumber(step.perEventTravelCost)
  if (perEventTravelCost !== null) next.perEventTravelCost = perEventTravelCost

  if (step.departureMonthIndex === null) {
    next.departureMonthIndex = null
  } else {
    const departureMonthIndex = finiteNumber(step.departureMonthIndex)
    if (departureMonthIndex !== null) next.departureMonthIndex = departureMonthIndex
  }

  const commissionRate = normalizedCommissionRate(step.commissionRate)
  if (commissionRate !== null) next.commissionRate = commissionRate

  const pessimisticUnits = finiteNumber(step.pessimisticUnitsPerEvent)
  if (pessimisticUnits !== null) next.unitsPerEvent.pessimistic = pessimisticUnits

  const baseUnits = finiteNumber(step.baseUnitsPerEvent)
  if (baseUnits !== null) next.unitsPerEvent.base = baseUnits

  const optimisticUnits = finiteNumber(step.optimisticUnitsPerEvent)
  if (optimisticUnits !== null) next.unitsPerEvent.optimistic = optimisticUnits

  return next
}

async function planAddTeamMemberFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = typeof step.newMemberName === 'string' && step.newMemberName.trim()
    ? step.newMemberName.trim()
    : typeof step.memberName === 'string' && step.memberName.trim()
      ? step.memberName.trim()
      : ''
  const name = requestedName || defaultTeamMemberName(config)
  if (config.teamMembers.some((member) => normalizedMemberKey(member.name) === normalizedMemberKey(name))) {
    return {
      title: '成员已存在',
      message: `当前团队里已经有“${name}”。如果要新增同名成员，请先给出一个可区分的姓名或编号。`,
      status: 'failed',
      navigation: memberWorkbenchNavigation('新增成员需要打开团队成员假设供核对。'),
    } satisfies ReadDraft
  }

  const member = applyTeamMemberToolFields(createMember(newId(), { name }), step)
  const nextConfig = cloneModelConfig(config)
  nextConfig.teamMembers = [...nextConfig.teamMembers, member]
  const normalized = hydrateModelConfig(nextConfig)

  return {
    kind: 'workspace.update_draft',
    title: '确认新增团队成员',
    summary: `新增团队成员“${member.name}”，保存后后续测算会把该成员纳入收入、提成和成本计算。`,
    targetLabel: member.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增团队成员' },
      { label: '成员名称', value: member.name },
      { label: '成员数变化', value: `${config.teamMembers.length} -> ${normalized.teamMembers.length}` },
      { label: '合作类型', value: member.employmentType === 'salary' ? '底薪制' : '兼职/分成制' },
      { label: '底薪', value: `${member.monthlyBasePay}` },
      { label: '每场路费', value: `${member.perEventTravelCost}` },
      { label: '提成比例', value: `${member.commissionRate}` },
      { label: '基准场均销量', value: `${member.unitsPerEvent.base}` },
    ],
    navigation: memberWorkbenchNavigation('新增成员属于团队成员假设，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'teamMembers', value: normalized.teamMembers, label: '团队成员列表' }],
    },
  } satisfies AgentActionDraft
}

async function planDeleteTeamMemberFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const target = findTeamMember(config, { memberId: step.memberId, memberName: step.memberName })
  const navigation = memberWorkbenchNavigation('删除成员需要打开团队成员假设供核对。')

  if (!step.memberId && !step.memberName) {
    return {
      title: '需要指定要删除的成员',
      message: `请告诉我要删除哪位成员。当前成员有：${config.teamMembers.map((member) => member.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的成员',
      message: `当前工作区没有匹配“${step.memberName ?? step.memberId}”的成员。当前成员有：${config.teamMembers.map((member) => member.name).join('、')}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  if (config.teamMembers.length <= 1) {
    return {
      title: '不能删除最后一个成员',
      message: '不能删除最后一个成员：当前团队只剩 1 个成员。为了保持模型可计算，Agent 不会生成删除最后一个成员的确认卡。',
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = cloneModelConfig(config)
  nextConfig.teamMembers = nextConfig.teamMembers.filter((member) => member.id !== target.id)
  const normalized = hydrateModelConfig(nextConfig)

  return {
    kind: 'workspace.update_draft',
    title: '确认删除团队成员',
    summary: `删除团队成员“${target.name}”。历史账本分录不会被删除，但后续测算不再包含该成员。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除团队成员' },
      { label: '成员名称', value: target.name },
      { label: '成员 ID', value: target.id },
      { label: '成员数变化', value: `${config.teamMembers.length} -> ${normalized.teamMembers.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本和账本分录不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'teamMembers', value: normalized.teamMembers, label: '团队成员列表' }],
    },
  } satisfies AgentActionDraft
}

function defaultEmployeeName(config: ModelConfig) {
  const existing = new Set(config.employees.map((employee) => normalizedMemberKey(employee.name)))
  let index = config.employees.length + 1
  while (existing.has(normalizedMemberKey(`员工 ${index}`))) index += 1
  return `员工 ${index}`
}

function findEmployee(config: ModelConfig, input: { employeeId?: string | null | undefined; employeeName?: string | null | undefined }) {
  const employeeId = typeof input.employeeId === 'string' ? input.employeeId.trim() : ''
  if (employeeId) {
    const byId = config.employees.find((employee) => employee.id === employeeId)
    if (byId) return byId
  }

  const employeeName = typeof input.employeeName === 'string' ? input.employeeName.trim() : ''
  if (!employeeName) return null
  const normalized = normalizedMemberKey(employeeName)
  return config.employees.find((employee) => employee.id === employeeName || normalizedMemberKey(employee.name) === normalized) ?? null
}

function applyEmployeeToolFields(employee: Employee, step: RuntimePlannerStep) {
  const next: Employee = { ...employee }
  if (typeof step.role === 'string' && step.role.trim()) next.role = step.role.trim()
  const monthlyBasePay = finiteNumber(step.monthlyBasePay)
  if (monthlyBasePay !== null) next.monthlyBasePay = monthlyBasePay
  const perEventCost = finiteNumber(step.perEventCost)
  if (perEventCost !== null) next.perEventCost = perEventCost
  return next
}

async function planAddEmployeeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = typeof step.newEmployeeName === 'string' && step.newEmployeeName.trim()
    ? step.newEmployeeName.trim()
    : typeof step.employeeName === 'string' && step.employeeName.trim()
      ? step.employeeName.trim()
      : ''
  const name = requestedName || defaultEmployeeName(config)
  if (config.employees.some((employee) => normalizedMemberKey(employee.name) === normalizedMemberKey(name))) {
    return {
      title: '员工已存在',
      message: `当前员工列表里已经有“${name}”。如果要新增同名员工，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增员工需要打开运营员工配置供核对。'),
    } satisfies ReadDraft
  }

  const employee = applyEmployeeToolFields(createEmployee(newId(), { name }), step)
  const normalized = hydrateModelConfig({
    ...cloneModelConfig(config),
    employees: [...config.employees, employee],
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认新增员工',
    summary: `新增运营员工“${employee.name}”，保存后员工月薪和场次成本会进入后续测算。`,
    targetLabel: employee.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增员工' },
      { label: '员工名称', value: employee.name },
      { label: '岗位', value: employee.role },
      { label: '员工数变化', value: `${config.employees.length} -> ${normalized.employees.length}` },
      { label: '月固定薪酬', value: `${employee.monthlyBasePay}` },
      { label: '每场补贴', value: `${employee.perEventCost}` },
    ],
    navigation: costWorkbenchNavigation('新增员工属于运营员工配置，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'employees', value: normalized.employees, label: '运营员工列表' }],
    },
  } satisfies AgentActionDraft
}

async function planDeleteEmployeeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = costWorkbenchNavigation('删除员工需要打开运营员工配置供核对。')
  const target = findEmployee(config, { employeeId: step.employeeId, employeeName: step.employeeName })

  if (!step.employeeId && !step.employeeName) {
    return {
      title: '需要指定要删除的员工',
      message: `请告诉我要删除哪位员工。当前员工有：${config.employees.map((employee) => employee.name).join('、') || '暂无员工'}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的员工',
      message: `当前工作区没有匹配“${step.employeeName ?? step.employeeId}”的员工。当前员工有：${config.employees.map((employee) => employee.name).join('、') || '暂无员工'}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const normalized = hydrateModelConfig({
    ...cloneModelConfig(config),
    employees: config.employees.filter((employee) => employee.id !== target.id),
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认删除员工',
    summary: `删除运营员工“${target.name}”。历史账本分录不会被删除，但后续测算不再包含该员工。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除员工' },
      { label: '员工名称', value: target.name },
      { label: '员工 ID', value: target.id },
      { label: '员工数变化', value: `${config.employees.length} -> ${normalized.employees.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本和账本分录不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'employees', value: normalized.employees, label: '运营员工列表' }],
    },
  } satisfies AgentActionDraft
}

const costCategoryKeys: Record<CostCategory, 'monthlyFixedCosts' | 'perEventCosts' | 'perUnitCosts'> = {
  monthlyFixed: 'monthlyFixedCosts',
  perEvent: 'perEventCosts',
  perUnit: 'perUnitCosts',
}

const costCategoryLabels: Record<CostCategory, string> = {
  monthlyFixed: '每月固定成本',
  perEvent: '每场成本',
  perUnit: '每张成本',
}

function isCostCategory(value: unknown): value is CostCategory {
  return value === 'monthlyFixed' || value === 'perEvent' || value === 'perUnit'
}

function isStageCostMode(value: unknown): value is StageCostMode {
  return value === 'monthly' || value === 'perEvent' || value === 'perUnit'
}

function capitalWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'capital' },
    reason,
  }
}

function costWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'cost' },
    reason,
  }
}

function shareholderNameForIndex(index: number) {
  return index >= 1 && index <= 26 ? `股东 ${String.fromCharCode(64 + index)}` : `股东 ${index}`
}

function defaultShareholderName(config: ModelConfig) {
  const existing = new Set(config.shareholders.map((shareholder) => normalizedMemberKey(shareholder.name)))
  let index = config.shareholders.length + 1
  while (existing.has(normalizedMemberKey(shareholderNameForIndex(index)))) index += 1
  return shareholderNameForIndex(index)
}

function findShareholder(config: ModelConfig, input: { shareholderId?: string | null | undefined; shareholderName?: string | null | undefined }) {
  const shareholderId = typeof input.shareholderId === 'string' ? input.shareholderId.trim() : ''
  if (shareholderId) {
    const byId = config.shareholders.find((shareholder) => shareholder.id === shareholderId)
    if (byId) return byId
  }

  const shareholderName = typeof input.shareholderName === 'string' ? input.shareholderName.trim() : ''
  if (!shareholderName) return null
  const normalized = normalizedMemberKey(shareholderName)
  return config.shareholders.find((shareholder) => shareholder.id === shareholderName || normalizedMemberKey(shareholder.name) === normalized) ?? null
}

function applyShareholderToolFields(shareholder: Shareholder, step: RuntimePlannerStep) {
  const next: Shareholder = { ...shareholder }
  const investmentAmount = finiteNumber(step.investmentAmount)
  if (investmentAmount !== null) next.investmentAmount = investmentAmount
  const dividendRate = normalizedCommissionRate(step.dividendRate)
  if (dividendRate !== null) next.dividendRate = dividendRate
  return next
}

async function planAddShareholderFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = typeof step.newShareholderName === 'string' && step.newShareholderName.trim()
    ? step.newShareholderName.trim()
    : typeof step.shareholderName === 'string' && step.shareholderName.trim()
      ? step.shareholderName.trim()
      : ''
  const name = requestedName || defaultShareholderName(config)
  if (config.shareholders.some((shareholder) => normalizedMemberKey(shareholder.name) === normalizedMemberKey(name))) {
    return {
      title: '股东已存在',
      message: `当前股东列表里已经有“${name}”。如果要新增同名股东，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: capitalWorkbenchNavigation('新增股东需要打开股东投资页面供核对。'),
    } satisfies ReadDraft
  }

  const shareholder = applyShareholderToolFields(createShareholder(newId(), { name }), step)
  const nextConfig = hydrateModelConfig({
    ...cloneModelConfig(config),
    shareholders: [...config.shareholders, shareholder],
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认新增股东',
    summary: `新增股东“${shareholder.name}”，保存后投资额和分红比例会进入后续测算。`,
    targetLabel: shareholder.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增股东' },
      { label: '股东名称', value: shareholder.name },
      { label: '股东数变化', value: `${config.shareholders.length} -> ${nextConfig.shareholders.length}` },
      { label: '投资额', value: `${shareholder.investmentAmount}` },
      { label: '分红比例', value: `${shareholder.dividendRate}` },
    ],
    navigation: capitalWorkbenchNavigation('新增股东属于股东投资设置，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'shareholders', value: nextConfig.shareholders, label: '股东列表' }],
    },
  } satisfies AgentActionDraft
}

async function planDeleteShareholderFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = capitalWorkbenchNavigation('删除股东需要打开股东投资页面供核对。')
  const target = findShareholder(config, { shareholderId: step.shareholderId, shareholderName: step.shareholderName })

  if (!step.shareholderId && !step.shareholderName) {
    return {
      title: '需要指定要删除的股东',
      message: `请告诉我要删除哪位股东。当前股东有：${config.shareholders.map((shareholder) => shareholder.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的股东',
      message: `当前工作区没有匹配“${step.shareholderName ?? step.shareholderId}”的股东。当前股东有：${config.shareholders.map((shareholder) => shareholder.name).join('、')}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  if (config.shareholders.length <= 1) {
    return {
      title: '不能删除最后一个股东',
      message: '不能删除最后一个股东：当前资本结构只剩 1 个股东。为了保持投资与分红模型可计算，Agent 不会生成删除最后一个股东的确认卡。',
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = hydrateModelConfig({
    ...cloneModelConfig(config),
    shareholders: config.shareholders.filter((shareholder) => shareholder.id !== target.id),
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认删除股东',
    summary: `删除股东“${target.name}”。历史版本不会被改写，当前草稿的资本结构会更新。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除股东' },
      { label: '股东名称', value: target.name },
      { label: '股东 ID', value: target.id },
      { label: '股东数变化', value: `${config.shareholders.length} -> ${nextConfig.shareholders.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'shareholders', value: nextConfig.shareholders, label: '股东列表' }],
    },
  } satisfies AgentActionDraft
}

function costItemsForCategory(config: ModelConfig, category: CostCategory) {
  return config.operating[costCategoryKeys[category]]
}

function defaultCostItemName(config: ModelConfig, category: CostCategory) {
  const items = costItemsForCategory(config, category)
  const existing = new Set(items.map((item) => normalizedMemberKey(item.name)))
  let index = items.length + 1
  while (existing.has(normalizedMemberKey(`${costCategoryLabels[category]} ${index}`))) index += 1
  return `${costCategoryLabels[category]} ${index}`
}

function setCostItems(config: ModelConfig, category: CostCategory, items: CostItem[]) {
  const nextConfig = cloneModelConfig(config)
  const key = costCategoryKeys[category]
  nextConfig.operating = {
    ...nextConfig.operating,
    [key]: items,
  }
  return hydrateModelConfig(nextConfig)
}

type CostItemLookup =
  | { status: 'found'; category: CostCategory; item: CostItem }
  | { status: 'ambiguous'; matches: Array<{ category: CostCategory; item: CostItem }> }
  | { status: 'missing' }

function findCostItem(config: ModelConfig, input: { category?: CostCategory | null; costItemId?: string | null | undefined; costItemName?: string | null | undefined }): CostItemLookup {
  const categories: CostCategory[] = input.category ? [input.category] : ['monthlyFixed', 'perEvent', 'perUnit']
  const costItemId = typeof input.costItemId === 'string' ? input.costItemId.trim() : ''
  const costItemName = typeof input.costItemName === 'string' ? input.costItemName.trim() : ''
  const normalizedName = normalizedMemberKey(costItemName)
  const matches: Array<{ category: CostCategory; item: CostItem }> = []

  for (const category of categories) {
    for (const item of costItemsForCategory(config, category)) {
      if (costItemId && item.id === costItemId) matches.push({ category, item })
      if (!costItemId && costItemName && (item.id === costItemName || normalizedMemberKey(item.name) === normalizedName)) {
        matches.push({ category, item })
      }
    }
  }

  if (matches.length === 1) return { status: 'found', ...matches[0]! }
  if (matches.length > 1) return { status: 'ambiguous', matches }
  return { status: 'missing' }
}

async function planAddCostItemFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  if (!isCostCategory(step.costCategory)) {
    return {
      title: '需要指定成本归属',
      message: '请说明要新增的是每月固定成本、每场成本还是每张成本。',
      status: 'info',
      navigation: costWorkbenchNavigation('新增基础成本项需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const { draft, config } = await currentDraftConfig(ctx)
  const category = step.costCategory
  const items = costItemsForCategory(config, category)
  const requestedName = typeof step.newCostItemName === 'string' && step.newCostItemName.trim()
    ? step.newCostItemName.trim()
    : typeof step.costItemName === 'string' && step.costItemName.trim()
      ? step.costItemName.trim()
      : ''
  const name = requestedName || defaultCostItemName(config, category)
  if (items.some((item) => normalizedMemberKey(item.name) === normalizedMemberKey(name))) {
    return {
      title: '成本项已存在',
      message: `${costCategoryLabels[category]}里已经有“${name}”。如果要新增同名成本项，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增基础成本项需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const amount = finiteNumber(step.amount) ?? 0
  const item = createCostItem(newId(), { name, amount })
  const nextConfig = setCostItems(config, category, [...items, item])

  return {
    kind: 'workspace.update_draft',
    title: '确认新增基础成本项',
    summary: `新增${costCategoryLabels[category]}“${item.name}”，金额 ${item.amount} 元。`,
    targetLabel: item.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增基础成本项' },
      { label: '成本归属', value: costCategoryLabels[category] },
      { label: '成本名称', value: item.name },
      { label: '金额', value: `${item.amount}` },
      { label: '数量变化', value: `${items.length} -> ${costItemsForCategory(nextConfig, category).length}` },
    ],
    navigation: costWorkbenchNavigation('新增基础成本项属于成本编辑，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: `operating.${costCategoryKeys[category]}`, value: costItemsForCategory(nextConfig, category), label: costCategoryLabels[category] }],
    },
  } satisfies AgentActionDraft
}

async function planDeleteCostItemFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const category = isCostCategory(step.costCategory) ? step.costCategory : null
  const navigation = costWorkbenchNavigation('删除基础成本项需要打开成本编辑页面供核对。')
  if (!step.costItemId && !step.costItemName) {
    return {
      title: '需要指定要删除的成本项',
      message: '请告诉我要删除哪个成本项；如果同名成本项可能存在于多个分类，请同时说明每月固定、每场或每张。',
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  const lookup = findCostItem(config, { category, costItemId: step.costItemId, costItemName: step.costItemName })
  if (lookup.status === 'ambiguous') {
    return {
      title: '需要指定成本项分类',
      message: `找到多个同名成本项：${lookup.matches.map((match) => `${costCategoryLabels[match.category]} / ${match.item.name}`).join('、')}。请补充要删除哪一类。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }
  if (lookup.status === 'missing') {
    return {
      title: '没有找到要删除的成本项',
      message: `当前工作区没有匹配“${step.costItemName ?? step.costItemId}”的基础成本项。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const items = costItemsForCategory(config, lookup.category)
  const nextConfig = setCostItems(config, lookup.category, items.filter((item) => item.id !== lookup.item.id))

  return {
    kind: 'workspace.update_draft',
    title: '确认删除基础成本项',
    summary: `删除${costCategoryLabels[lookup.category]}“${lookup.item.name}”。历史版本不会被改写，当前草稿成本结构会更新。`,
    targetLabel: lookup.item.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除基础成本项' },
      { label: '成本归属', value: costCategoryLabels[lookup.category] },
      { label: '成本名称', value: lookup.item.name },
      { label: '金额', value: `${lookup.item.amount}` },
      { label: '数量变化', value: `${items.length} -> ${costItemsForCategory(nextConfig, lookup.category).length}` },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: `operating.${costCategoryKeys[lookup.category]}`, value: costItemsForCategory(nextConfig, lookup.category), label: costCategoryLabels[lookup.category] }],
    },
  } satisfies AgentActionDraft
}

function defaultStageCostName(config: ModelConfig) {
  const existing = new Set(config.stageCostItems.map((item) => normalizedMemberKey(item.name)))
  let index = config.stageCostItems.length + 1
  while (existing.has(normalizedMemberKey(`专项成本 ${index}`))) index += 1
  return `专项成本 ${index}`
}

function findStageCostItem(config: ModelConfig, input: { stageCostItemId?: string | null | undefined; stageCostItemName?: string | null | undefined }) {
  const stageCostItemId = typeof input.stageCostItemId === 'string' ? input.stageCostItemId.trim() : ''
  if (stageCostItemId) {
    const byId = config.stageCostItems.find((item) => item.id === stageCostItemId)
    if (byId) return byId
  }

  const stageCostItemName = typeof input.stageCostItemName === 'string' ? input.stageCostItemName.trim() : ''
  if (!stageCostItemName) return null
  const normalized = normalizedMemberKey(stageCostItemName)
  return config.stageCostItems.find((item) => item.id === stageCostItemName || normalizedMemberKey(item.name) === normalized) ?? null
}

function syncStageCostItemsForPlanner(config: ModelConfig, stageCostItems: StageCostItem[], defaultValue?: { itemId: string; amount: number; count: number }) {
  const nextConfig = cloneModelConfig(config)
  const addDefault = (values: Array<{ itemId: string; amount?: number; count?: number }>) =>
    defaultValue && !values.some((value) => value.itemId === defaultValue.itemId)
      ? [...values, defaultValue]
      : values

  nextConfig.stageCostItems = stageCostItems
  nextConfig.timelineTemplate = {
    ...nextConfig.timelineTemplate,
    specialCosts: createStageCostValues(stageCostItems, addDefault(nextConfig.timelineTemplate.specialCosts)),
  }
  nextConfig.months = nextConfig.months.map((month) => ({
    ...month,
    specialCosts: createStageCostValues(stageCostItems, addDefault(month.specialCosts)),
  }))
  return hydrateModelConfig(nextConfig)
}

async function planAddStageCostTypeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = typeof step.newStageCostItemName === 'string' && step.newStageCostItemName.trim()
    ? step.newStageCostItemName.trim()
    : typeof step.stageCostItemName === 'string' && step.stageCostItemName.trim()
      ? step.stageCostItemName.trim()
      : ''
  const name = requestedName || defaultStageCostName(config)
  if (config.stageCostItems.some((item) => normalizedMemberKey(item.name) === normalizedMemberKey(name))) {
    return {
      title: '成本类型已存在',
      message: `当前专项成本类型里已经有“${name}”。如果要新增同名类型，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增专项成本类型需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const mode = isStageCostMode(step.costMode) ? step.costMode : 'perEvent'
  const item = createStageCostItem(newId(), { name, mode })
  const amount = finiteNumber(step.amount) ?? 0
  const defaultCount = mode === 'perEvent' ? 0 : 1
  const count = finiteNumber(step.count) ?? defaultCount
  const defaultValue = step.amount !== undefined || step.count !== undefined
    ? { itemId: item.id, amount, count }
    : undefined
  const nextConfig = syncStageCostItemsForPlanner(config, [...config.stageCostItems, item], defaultValue)

  return {
    kind: 'workspace.update_draft',
    title: '确认新增专项成本类型',
    summary: `新增专项成本类型“${item.name}”，计费方式为 ${mode === 'monthly' ? '每月' : mode === 'perEvent' ? '每场' : '每张'}。`,
    targetLabel: item.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增专项成本类型' },
      { label: '成本类型', value: item.name },
      { label: '计费方式', value: mode === 'monthly' ? '每月' : mode === 'perEvent' ? '每场' : '每张' },
      { label: '默认金额', value: `${amount}` },
      { label: '默认数量/系数', value: `${count}` },
      { label: '类型数变化', value: `${config.stageCostItems.length} -> ${nextConfig.stageCostItems.length}` },
    ],
    navigation: costWorkbenchNavigation('新增专项成本类型属于成本编辑，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'stageCostItems', value: nextConfig.stageCostItems, label: '专项成本类型' }],
    },
  } satisfies AgentActionDraft
}

async function planDeleteStageCostTypeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = costWorkbenchNavigation('删除专项成本类型需要打开成本编辑页面供核对。')
  if (!step.stageCostItemId && !step.stageCostItemName) {
    return {
      title: '需要指定要删除的成本类型',
      message: `请告诉我要删除哪个专项成本类型。当前类型有：${config.stageCostItems.map((item) => item.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  const target = findStageCostItem(config, { stageCostItemId: step.stageCostItemId, stageCostItemName: step.stageCostItemName })
  if (!target) {
    return {
      title: '没有找到要删除的成本类型',
      message: `当前工作区没有匹配“${step.stageCostItemName ?? step.stageCostItemId}”的专项成本类型。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = syncStageCostItemsForPlanner(config, config.stageCostItems.filter((item) => item.id !== target.id))

  return {
    kind: 'workspace.update_draft',
    title: '确认删除专项成本类型',
    summary: `删除专项成本类型“${target.name}”，并从模板和所有月份成本表中移除该类型的值。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除专项成本类型' },
      { label: '成本类型', value: target.name },
      { label: '计费方式', value: target.mode === 'monthly' ? '每月' : target.mode === 'perEvent' ? '每场' : '每张' },
      { label: '类型数变化', value: `${config.stageCostItems.length} -> ${nextConfig.stageCostItems.length}` },
      { label: '审计说明', value: '当前草稿的模板和全部月份成本表会同步移除该类型；历史版本不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'stageCostItems', value: nextConfig.stageCostItems, label: '专项成本类型' }],
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
  const context = await buildAgentContextPack({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.threadId,
    ...(ctx.providedWorkspaceBundle ? { providedWorkspaceBundle: ctx.providedWorkspaceBundle } : {}),
  })

  const tools = projectAgentTools({ message: ctx.message })
  await addRunEvent(ctx.db, {
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: 'tool_projection_ready',
    title: '工具投影已生成',
    message: `本轮向模型暴露 ${tools.length} 个任务相关工具。`,
    status: 'running',
    data: {
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.function.name),
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
  'ledger.set_period_lock': async (ctx, step) => {
    if (!step.monthLabel) return null
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
  },
  'ledger.update_entry': planLedgerUpdateFromStep,
  'ledger.restore_entry': planLedgerRestoreFromStep,
  'ledger.void_entry': planLedgerVoidFromStep,
  'workspace.update_online_factor': (ctx, step) => step.monthLabel && typeof step.onlineSalesFactor === 'number'
    ? planOnlineFactorFromFields(ctx, {
        monthLabel: step.monthLabel,
        factor: step.onlineSalesFactor,
        mode: step.mode === 'forecast' || readOnlyForecastRequested(ctx.message) ? 'forecast' : 'write',
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
    if (readOnlyForecastRequested(ctx.message)) return null
    return step.patches ? planWorkspacePatch(ctx, step.patches) : null
  },
  'workspace.rename': (ctx, step) => planWorkspaceRename(ctx, step.workspaceName),
  'workspace.save_snapshot': planSaveSnapshotAction,
  'workspace.publish_release': (ctx, step) => buildPublishReleaseDraft(ctx, Boolean(step.createShare)),
  'workspace.rollback_version': (ctx, step) => planRollbackVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
    requireKeyword: false,
  }),
  'workspace.promote_version': (ctx, step) => planPromoteVersionAction(ctx, {
    ...(step.versionNo !== undefined ? { versionNo: step.versionNo } : {}),
    ...(step.versionName !== undefined ? { versionName: step.versionName } : {}),
  }),
  'workspace.delete_version': planDeleteVersionAction,
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
      await planSaveSnapshotAction(scopedCtx),
      /快照.*发布|发布.*快照|升为.*发布版|发布为正式版/.test(scopedCtx.message)
        ? await planPromoteVersionAction(scopedCtx)
        : null,
      await planPublishVersionAction(scopedCtx),
      await planRollbackVersionAction(scopedCtx),
      await planDeleteVersionAction(scopedCtx),
      await planShareAction(scopedCtx),
      await planResetDraftAction(scopedCtx),
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
    } else {
      items.push(...(await localPlannedItems(planningCtx)))
    }
  }
  return items.length > 0 ? { source: source ?? requiredSource ?? 'openai_compatible_tool_calls', items } : null
}

export async function planResponse(ctx: PlannerContext) {
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
