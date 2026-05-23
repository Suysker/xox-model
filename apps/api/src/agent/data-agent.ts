import type { Kysely } from 'kysely'
import { projectModel } from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import { listEntries, listPeriods, varianceForPeriod } from '../modules/ledger.js'

type DataAgentContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
}

export type DataAgentQueryStep = {
  scope?: unknown
  metrics?: unknown
  monthLabel?: string | null
  memberName?: string | null
  subjectKey?: string | null
  subjectName?: string | null
  direction?: 'income' | 'expense' | null
  entryStatus?: 'posted' | 'voided' | null
  dateMode?: 'all' | 'day' | 'week' | null
  day?: string | null
  week?: string | null
  keyword?: string | null
  order?: unknown
  limit?: unknown
}

export type DataAgentRead = {
  title: string
  message: string
  readKind: 'tool_observation'
  modelContent: string
  displayPreview: string
  navigation: AgentNavigationEvent
  status: 'executed'
}

function dataRead(input: {
  title: string
  message: string
  navigation: AgentNavigationEvent
  data: Record<string, unknown>
}): DataAgentRead {
  return {
    title: input.title,
    message: input.message,
    readKind: 'tool_observation',
    modelContent: JSON.stringify({ ...input.data, displayPreview: input.message }),
    displayPreview: input.message,
    navigation: input.navigation,
    status: 'executed',
  }
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

function normalizedDataScope(step: DataAgentQueryStep, metrics: string[]) {
  const scope = step.scope === 'workspace_summary' ||
    step.scope === 'period_summary' ||
    step.scope === 'member_summary' ||
    step.scope === 'team_summary' ||
    step.scope === 'top_months' ||
    step.scope === 'variance_detail' ||
    step.scope === 'ledger_history'
    ? step.scope
    : 'workspace_summary'

  if (scope === 'workspace_summary' && typeof step.monthLabel === 'string' && step.monthLabel.trim().length > 0) {
    const metricSet = new Set(metrics)
    const hasMonthMetric = metrics.length === 0 ||
      metricSet.has('plannedRevenue') ||
      metricSet.has('plannedCost') ||
      metricSet.has('plannedProfit') ||
      metricSet.has('actualRevenue') ||
      metricSet.has('actualCost') ||
      metricSet.has('actualProfit')
    if (hasMonthMetric) return 'period_summary'
  }

  return scope
}

function normalizeLookup(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

function toInputDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

function toWeekInputValue(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const localDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = localDate.getDay() || 7
  localDate.setDate(localDate.getDate() + 4 - day)
  const yearStart = new Date(localDate.getFullYear(), 0, 1)
  const weekNumber = Math.ceil(((localDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${localDate.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`
}

function entryMatchesKeyword(entry: Awaited<ReturnType<typeof listEntries>>[number], keyword: string) {
  const needle = normalizeLookup(keyword)
  const haystack = [
    entry.counterparty,
    entry.description,
    entry.relatedEntityName,
    entry.direction === 'income' ? '收入' : '支出',
    entry.status === 'voided' ? '已作废' : '已过账',
    ...entry.allocations.flatMap((allocation) => [allocation.subjectKey, allocation.subjectName]),
  ]
  return haystack.some((item) => item && normalizeLookup(item).includes(needle))
}

async function periodForMonth(ctx: DataAgentContext, monthLabel: string) {
  const periods = await ctx.db.selectFrom('ledger_periods').selectAll().where('workspace_id', '=', ctx.workspace.id).execute()
  return periods.find((period) => period.month_label === monthLabel) ?? null
}

async function currentDraftProjection(ctx: DataAgentContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  const { config } = draftContext(draft)
  return { config, projection: projectModel(config) }
}

export async function answerWorkspaceDataQuestion(ctx: DataAgentContext, step: DataAgentQueryStep): Promise<DataAgentRead | null> {
  const { config, projection } = await currentDraftProjection(ctx)
  const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null
  if (!baseScenario) return null

  const metrics = normalizeDataMetrics(step.metrics)
  const scope = normalizedDataScope(step, metrics)

  if (scope === 'team_summary') {
    const members = config.teamMembers
    const names = members.map((member) => member.name).filter((name) => name.trim().length > 0)
    const includeNames = metrics.length === 0 || metrics.includes('teamMemberNames')
    const nameText = includeNames && names.length > 0 ? `，分别是：${names.join('、')}` : ''
    return dataRead({
      title: '回答团队成员问题',
      message: `当前工作区共有 ${members.length} 个成员${nameText}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'members' },
        reason: '团队成员问答需要打开成员分析页面，便于核对成员口径。',
      },
      data: { scope, memberCount: members.length, names },
    })
  }

  if (scope === 'period_summary') {
    const period = step.monthLabel ? await periodForMonth(ctx, step.monthLabel) : null
    if (!period) return null
    const periods = await listPeriods(ctx.db, ctx.workspace)
    const summary = periods.find((item) => item.id === period.id) ?? periods.find((item) => item.monthLabel === period.month_label) ?? null
    const month = baseScenario.months.find((item) => item.monthIndex === period.month_index) ?? null
    const plannedRevenue = summary?.plannedRevenue ?? month?.grossSales ?? 0
    const plannedCost = summary?.plannedCost ?? month?.totalCost ?? 0
    const actualRevenue = summary?.actualRevenue ?? 0
    const actualCost = summary?.actualCost ?? 0
    const plannedProfit = plannedRevenue - plannedCost
    const actualProfit = actualRevenue - actualCost
    const includeActual = metrics.length === 0 || metrics.some((metric) => metric.startsWith('actual'))
    const parts = [
      `${period.month_label}计划收入 ${money(plannedRevenue)}`,
      `计划成本 ${money(plannedCost)}`,
      `计划利润 ${money(plannedProfit)}`,
      ...(includeActual ? [`实际收入 ${money(actualRevenue)}`, `实际成本 ${money(actualCost)}`, `实际利润 ${money(actualProfit)}`] : []),
    ]
    const route: AgentNavigationEvent['route'] = includeActual
      ? { mainTab: 'variance', secondaryTab: 'analysis', selectedPeriodId: period.id }
      : { mainTab: 'dashboard', secondaryTab: 'months', selectedPeriodId: period.id }
    return dataRead({
      title: '回答单月数据问题',
      message: `${parts.join('，')}。`,
      navigation: {
        type: 'navigation',
        route,
        reason: '数据问答需要打开对应月份的分析页面，便于核对口径。',
      },
      data: { scope, monthLabel: period.month_label, plannedRevenue, plannedCost, plannedProfit, actualRevenue, actualCost, actualProfit, metrics },
    })
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
    return dataRead({
      title: '回答成员数据问题',
      message: `${label}计划收入 ${money(totals.revenue)}，计划提成 ${money(totals.commission)}，公司净贡献 ${money(totals.contribution)}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'members' },
        reason: '成员数据问答需要打开成员分析页面，便于核对口径。',
      },
      data: { scope, memberId: member.id, memberName: member.name, monthLabel: step.monthLabel ?? null, totals },
    })
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
    return dataRead({
      title: '回答月份排行问题',
      message: `按${metric === 'plannedRevenue' ? '计划收入' : metric === 'plannedCost' ? '计划成本' : metric === 'cash' ? '累计现金' : '计划利润'}${order === 'asc' ? '升序' : '降序'}，前 ${limit} 个月份是：${ranked.map((item) => `${item.month.label} ${money(item.value)}`).join('；')}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'months' },
        reason: '月份排行问答需要打开按月分析页面，便于核对口径。',
      },
      data: { scope, metric, order, limit, ranked: ranked.map((item) => ({ monthLabel: item.month.label, value: item.value })) },
    })
  }

  if (scope === 'variance_detail') {
    const period = step.monthLabel ? await periodForMonth(ctx, step.monthLabel) : null
    if (!period) return null
    const variance = await varianceForPeriod(ctx.db, ctx.workspace, period.id)
    const subjectNeedle = typeof step.subjectName === 'string' && step.subjectName.trim() ? normalizeLookup(step.subjectName) : ''
    const subjectKey = typeof step.subjectKey === 'string' && step.subjectKey.trim() ? step.subjectKey.trim() : ''
    const keyword = typeof step.keyword === 'string' && step.keyword.trim() ? normalizeLookup(step.keyword) : ''
    const lines = variance.lines
      .filter((line) => {
        if (subjectKey && line.subjectKey !== subjectKey) return false
        if (subjectNeedle && !normalizeLookup(line.subjectName).includes(subjectNeedle) && !normalizeLookup(line.subjectKey).includes(subjectNeedle)) return false
        if (keyword && !normalizeLookup(`${line.subjectName}${line.subjectKey}`).includes(keyword)) return false
        return true
      })
      .sort((a, b) => Math.abs(b.varianceAmount) - Math.abs(a.varianceAmount))
      .slice(0, Math.min(8, Math.max(1, typeof step.limit === 'number' ? Math.round(step.limit) : 5)))
    const detail = lines.length > 0
      ? lines.map((line) => `${line.subjectName}：计划 ${money(line.plannedAmount)}，实际 ${money(line.actualAmount)}，差异 ${money(line.varianceAmount)}`).join('；')
      : '没有找到匹配科目的预实差异明细'
    return dataRead({
      title: '回答预实差异追问',
      message: `${variance.monthLabel}收入差异 ${money(variance.revenueVarianceAmount)}，成本差异 ${money(variance.costVarianceAmount)}。${detail}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'variance', secondaryTab: 'analysis', selectedPeriodId: period.id },
        reason: '预实分析追问需要打开对应月份偏差页，便于核对科目明细。',
      },
      data: { scope, monthLabel: variance.monthLabel, revenueVarianceAmount: variance.revenueVarianceAmount, costVarianceAmount: variance.costVarianceAmount, lines },
    })
  }

  if (scope === 'ledger_history') {
    const periods = await listPeriods(ctx.db, ctx.workspace)
    const targetPeriods = step.monthLabel
      ? periods.filter((period) => period.monthLabel === step.monthLabel)
      : periods
    if (targetPeriods.length === 0) return null

    const filters = {
      direction: step.direction ?? 'all',
      status: step.entryStatus ?? 'all',
      dateMode: step.dateMode ?? (step.day ? 'day' : step.week ? 'week' : 'all'),
      day: step.day ?? null,
      week: step.week ?? null,
      keyword: step.keyword ?? null,
    } as const
    const subjectKey = typeof step.subjectKey === 'string' && step.subjectKey.trim() ? step.subjectKey.trim() : ''
    const subjectName = typeof step.subjectName === 'string' && step.subjectName.trim() ? normalizeLookup(step.subjectName) : ''
    const keyword = typeof step.keyword === 'string' && step.keyword.trim() ? step.keyword.trim() : ''
    const rows: Array<{ periodId: string; monthLabel: string; entry: Awaited<ReturnType<typeof listEntries>>[number] }> = []

    for (const period of targetPeriods) {
      const entries = await listEntries(ctx.db, ctx.workspace, period.id)
      for (const entry of entries) {
        if (filters.direction !== 'all' && entry.direction !== filters.direction) continue
        if (filters.status !== 'all' && entry.status !== filters.status) continue
        if (filters.dateMode === 'day' && filters.day && toInputDate(entry.occurredAt) !== filters.day) continue
        if (filters.dateMode === 'week' && filters.week && toWeekInputValue(entry.occurredAt) !== filters.week) continue
        if (subjectKey && !entry.allocations.some((allocation) => allocation.subjectKey === subjectKey)) continue
        if (subjectName && !entry.allocations.some((allocation) => normalizeLookup(allocation.subjectName).includes(subjectName))) continue
        if (keyword && !entryMatchesKeyword(entry, keyword)) continue
        rows.push({ periodId: period.id, monthLabel: period.monthLabel, entry })
      }
    }

    const selectedPeriodId = rows[0]?.periodId ?? targetPeriods[0]!.id
    const limit = Math.min(10, Math.max(1, typeof step.limit === 'number' ? Math.round(step.limit) : 5))
    const preview = rows.slice(0, limit).map(({ monthLabel, entry }) => {
      const subjectText = entry.allocations.map((allocation) => allocation.subjectName).join('/')
      return `${monthLabel} ${toInputDate(entry.occurredAt)} ${entry.direction === 'income' ? '收入' : '支出'} ${money(entry.amount)} ${entry.relatedEntityName ?? subjectText} ${entry.status === 'voided' ? '已作废' : '已过账'}`
    })
    const filterText = [
      filters.direction !== 'all' ? (filters.direction === 'income' ? '收入' : '支出') : null,
      filters.status !== 'all' ? (filters.status === 'posted' ? '已过账' : '已作废') : null,
      filters.dateMode === 'day' && filters.day ? filters.day : null,
      filters.dateMode === 'week' && filters.week ? filters.week : null,
      subjectKey || (typeof step.subjectName === 'string' ? step.subjectName : null),
      keyword,
    ].filter(Boolean).join(' / ') || '全部记录'

    return dataRead({
      title: '筛选账本历史',
      message: `已按“${filterText}”筛选账本历史，命中 ${rows.length} 笔${preview.length > 0 ? `：${preview.join('；')}` : ''}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId },
        ledgerFilters: filters,
        reason: '账本历史筛选需要打开记实际页面，并同步方向、状态、日期和关键词过滤器。',
      },
      data: { scope, filterText, count: rows.length, preview, filters },
    })
  }

  return dataRead({
    title: '回答工作区数据问题',
    message: `基准场景总收入 ${money(baseScenario.grossSales)}，总成本 ${money(baseScenario.totalCost)}，总利润 ${money(baseScenario.totalProfit)}，期末现金 ${money(baseScenario.netCashAfterInvestment)}，投资回报率 ${pct(baseScenario.roi)}，回本周期 ${baseScenario.paybackMonthLabel ?? '未回本'}。`,
    navigation: {
      type: 'navigation',
      route: { mainTab: 'dashboard', secondaryTab: 'overview' },
      reason: '工作区数据问答需要打开经营总览页面，便于核对口径。',
    },
    data: {
      scope,
      grossSales: baseScenario.grossSales,
      totalCost: baseScenario.totalCost,
      totalProfit: baseScenario.totalProfit,
      netCashAfterInvestment: baseScenario.netCashAfterInvestment,
      roi: baseScenario.roi,
      paybackMonthLabel: baseScenario.paybackMonthLabel ?? null,
    },
  })
}
