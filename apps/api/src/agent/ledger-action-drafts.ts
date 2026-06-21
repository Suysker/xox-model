import { projectModel, type ModelConfig } from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import { listEntries, listPeriods, listSubjectsForPeriod } from '../modules/ledger.js'
import { utcNow } from '../core/time.js'
import type { AgentActionDraft } from './agentic-os/xox-action-approval-adapter.js'
import type { PlannedItem, ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'
import {
  currentDraftConfig,
  findEmployee,
  findTeamMember,
  finiteNumber,
  periodForMonth,
  periodOccurrenceDate,
} from './action-draft-utils.js'
import type { PlannerContext } from './planning-context.js'

export async function planLedgerCreateFromFields(
  ctx: PlannerContext,
  input: { monthLabel?: string | null; memberName: string; offlineUnits?: number; onlineUnits?: number; occurredAt?: string | null },
) {
  const { config } = await currentDraftConfig(ctx)
  const explicitOccurredAt = isoFromDateLike(input.occurredAt)
  const monthLabel = input.monthLabel?.trim() || (explicitOccurredAt ? `${new Date(explicitOccurredAt).getUTCMonth() + 1}月` : null)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const member = findTeamMember(config, { memberName: input.memberName })
  if (!member) {
    return {
      title: '需要确认成员',
      message: `当前团队里没有精确匹配“${input.memberName}”的成员。请补充要入账的成员名称或编号。`,
      readKind: 'tool_observation',
      toolName: 'ledger_create_member_income',
      toolArguments: {
        monthLabel,
        memberName: input.memberName,
        offlineUnits: input.offlineUnits ?? 0,
        onlineUnits: input.onlineUnits ?? 0,
        occurredAt: input.occurredAt ?? null,
      },
      modelContent: JSON.stringify({
        status: 'needs_clarification',
        missingFields: ['memberName'],
        requestedMemberName: input.memberName,
        suggestions: config.teamMembers.slice(0, 8).map((item) => item.name),
      }),
      displayPreview: `需要确认成员：${input.memberName}`,
      status: 'info',
      navigation: ledgerNavigation(period.id, '成员收入入账需要打开本期账本并选中目标账期。'),
    } satisfies ReadDraft
  }

  const offlineUnits = Number(input.offlineUnits ?? 0)
  const onlineUnits = Number(input.onlineUnits ?? 0)
  const offlineAmount = Math.round(offlineUnits * config.operating.offlineUnitPrice * 100) / 100
  const onlineAmount = Math.round(onlineUnits * config.operating.onlineUnitPrice * 100) / 100
  const amount = Math.round((offlineAmount + onlineAmount) * 100) / 100
  if (amount <= 0) return null
  const occurredAt = explicitOccurredAt ?? periodOccurrenceDate(config, period)

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
    summary: `${period.monthLabel}为${member.name}记录收入 ${amount} 元，系统会自动计提成员提成。`,
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
    navigation: ledgerNavigation(period.id, '记账动作需要打开本期账本并选中目标账期。'),
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
  if (raw === 'today' || raw === '今天' || raw === '今日' || raw === '当天') return new Date(`${utcNow().slice(0, 10)}T12:00:00.000Z`).toISOString()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00.000Z`).toISOString()
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizedLedgerDirection(value: unknown): 'income' | 'expense' | null {
  if (value === 'income' || value === 'revenue' || value === '收入') return 'income'
  if (value === 'expense' || value === 'cost' || value === '支出' || value === '成本') return 'expense'
  return null
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

export async function planGenericLedgerCreateFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const monthLabel = asNonEmptyString(step.monthLabel)
  const direction = normalizedLedgerDirection(step.direction)
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

  const occurredAt = isoFromDateLike(step.occurredAt) ?? isoFromDateLike(step.date) ?? periodOccurrenceDate(config, period)
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

export async function planPlannedMemberIncomeBatch(ctx: PlannerContext, step: RuntimePlannerStep) {
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

export async function planPlannedRelatedExpenseBatch(ctx: PlannerContext, step: RuntimePlannerStep) {
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

async function findLedgerEntryById(
  ctx: PlannerContext,
  entryId: string,
  desiredStatus: 'posted' | 'voided',
): Promise<EntryLookup> {
  const initial = await ctx.db
    .selectFrom('actual_entries')
    .select(['workspace_id', 'ledger_period_id'])
    .where('id', '=', entryId)
    .executeTakeFirst()
  if (!initial || initial.workspace_id !== ctx.workspace.id) {
    return { status: 'missing', message: `没有找到分录 ${entryId}。`, period: null }
  }

  await listEntries(ctx.db, ctx.workspace, initial.ledger_period_id)
  const refreshed = await ctx.db
    .selectFrom('actual_entries')
    .select(['workspace_id', 'ledger_period_id', 'status'])
    .where('id', '=', entryId)
    .executeTakeFirst()
  if (!refreshed || refreshed.workspace_id !== ctx.workspace.id) {
    return { status: 'missing', message: `没有找到分录 ${entryId}。`, period: null }
  }
  const period = (await listPeriods(ctx.db, ctx.workspace)).find((item) => item.id === refreshed.ledger_period_id) ?? null
  if (!period) return { status: 'missing', message: `没有找到分录 ${entryId} 所属账期。`, period: null }
  if (refreshed.status !== desiredStatus) {
    return { status: 'missing', message: `分录状态不是${desiredStatus === 'posted' ? '已过账' : '已作废'}。`, period }
  }

  const entries = await listEntries(ctx.db, ctx.workspace, period.id)
  const entry = entries.find((item) => item.id === entryId)
  if (!entry) return { status: 'missing', message: `没有找到分录 ${entryId}。`, period }
  return { status: 'found', entry, period }
}

async function findLedgerEntryForStep(
  ctx: PlannerContext,
  step: RuntimePlannerStep,
  desiredStatus: 'posted' | 'voided',
): Promise<EntryLookup> {
  const entryId = asNonEmptyString(step.entryId)
  if (entryId) return findLedgerEntryById(ctx, entryId, desiredStatus)

  const monthLabel = asNonEmptyString(step.monthLabel)
  const period = monthLabel ? await periodForMonth(ctx, monthLabel) : null
  if (!period) return { status: 'missing', message: '需要指定账本月份。', period: null }
  const entries = await listEntries(ctx.db, ctx.workspace, period.id)

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

export async function planLedgerVoidFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
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

export async function planLedgerRestoreFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
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

export async function planLedgerUpdateFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
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

export async function planPeriodLockFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const monthLabel = asNonEmptyString(step.monthLabel)
  if (!monthLabel) return null
  const period = await periodForMonth(ctx, monthLabel)
  if (!period) return null
  const locked = Boolean(step.locked)
  return {
    kind: locked ? 'ledger.lock_period' : 'ledger.unlock_period',
    title: locked ? '确认锁定账期' : '确认解锁账期',
    summary: locked ? `锁定 ${monthLabel} 后将禁止新增、修改和作废分录。` : `解锁 ${monthLabel} 后可以继续修改已过账记录。`,
    targetLabel: monthLabel,
    riskLevel: 'high',
    details: [{ label: '账期', value: monthLabel }],
    navigation: ledgerNavigation(period.id, '锁账动作需要打开本期账本并选中目标账期。'),
    payload: { periodId: period.id },
  } satisfies AgentActionDraft
}
