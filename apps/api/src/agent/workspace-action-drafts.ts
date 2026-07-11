import {
  createCostItem,
  createEmployee,
  createMember,
  createMonth,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
  createTimelineTemplate,
  getMonthLabel,
  hydrateModelConfig,
  projectModel,
  type CostItem,
  type Employee,
  type EmploymentType,
  type ModelConfig,
  type MonthlyPlan,
  type Shareholder,
  type StageCostItem,
  type StageCostMode,
  type TeamMember,
} from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import { newId } from '../core/security.js'
import { listEntries, listPeriods, varianceForPeriod } from '../modules/ledger.js'
import { draftContext, exportWorkspaceBundle, getWorkspaceDraft } from '../modules/workspace.js'
import type { AgentActionDraft } from './host-profile/xox-runtime-items.js'
import type { ReadDraft, RuntimeToolStep } from './host-profile/xox-runtime-items.js'
import { cloneModelConfig, currentDraftConfig, finiteNumber, getConfigPath, setConfigPath } from './action-draft-utils.js'
import type { AgentTurnContext } from './host-profile/xox-runtime-items.js'
import {
  isWorkspaceDataQueryMetric,
  isWorkspaceDataQueryScope,
  isWorkspaceDataQueryTopMonthMetric,
  WORKSPACE_DATA_QUERY_ACTUAL_METRICS,
  WORKSPACE_DATA_QUERY_METRIC,
  WORKSPACE_DATA_QUERY_METRIC_LABELS,
  WORKSPACE_DATA_QUERY_PERIOD_INFER_METRICS,
  WORKSPACE_DATA_QUERY_SCOPE,
  type WorkspaceDataQueryMetric,
  type WorkspaceDataQueryScope,
  type WorkspaceDataQueryTopMonthMetric,
} from './tool-catalog.js'

function modelWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'revenue' },
    reason,
  }
}

function operatingModelNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'capital' },
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

type WorkspaceDataQueryContext = Pick<AgentTurnContext, 'db' | 'workspace'>

export type WorkspaceDataQueryStep = {
  question?: string | null
  scope?: WorkspaceDataQueryScope | string | null
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

export type WorkspaceDataQueryRead = {
  title: string
  message: string
  readKind: 'tool_observation'
  modelContent: string
  displayPreview: string
  navigation: AgentNavigationEvent
  status: 'executed'
}

function workspaceDataRead(input: {
  title: string
  message: string
  navigation: AgentNavigationEvent
  data: Record<string, unknown>
}): WorkspaceDataQueryRead {
  const displayPreview = compactObservationPreview(input.data)
  return {
    title: input.title,
    message: displayPreview,
    readKind: 'tool_observation',
    modelContent: JSON.stringify(input.data),
    displayPreview,
    navigation: input.navigation,
    status: 'executed',
  }
}

function compactObservationPreview(data: Record<string, unknown>) {
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data).slice(0, 12)) {
    if (Array.isArray(value)) {
      preview[key] = value.length <= 5 ? value : { count: value.length, sample: value.slice(0, 3) }
      continue
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      preview[key] = entries.length <= 8 ? value : Object.fromEntries(entries.slice(0, 8))
      continue
    }
    preview[key] = value
  }
  return JSON.stringify(preview, null, 2)
}

function normalizeDataMetrics(raw: unknown): WorkspaceDataQueryMetric[] {
  return Array.isArray(raw) ? raw.filter(isWorkspaceDataQueryMetric) : []
}

function normalizedDataScope(step: WorkspaceDataQueryStep, metrics: WorkspaceDataQueryMetric[]) {
  const scope = isWorkspaceDataQueryScope(step.scope)
    ? step.scope
    : WORKSPACE_DATA_QUERY_SCOPE.workspaceSummary

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.workspaceSummary && typeof step.monthLabel === 'string' && step.monthLabel.trim().length > 0) {
    const metricSet = new Set(metrics)
    const hasMonthMetric = metrics.length === 0 || WORKSPACE_DATA_QUERY_PERIOD_INFER_METRICS.some((metric) => metricSet.has(metric))
    if (hasMonthMetric) return WORKSPACE_DATA_QUERY_SCOPE.periodSummary
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

async function periodForMonth(ctx: WorkspaceDataQueryContext, monthLabel: string) {
  const periods = await ctx.db.selectFrom('ledger_periods').selectAll().where('workspace_id', '=', ctx.workspace.id).execute()
  return periods.find((period) => period.month_label === monthLabel) ?? null
}

async function currentDraftProjection(ctx: WorkspaceDataQueryContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  const { config } = draftContext(draft)
  return { config, projection: projectModel(config) }
}

type WorkspaceScenarioMonthForRanking = {
  grossSales: number
  totalCost: number
  cumulativeCash: number
  monthlyProfit: number
}

const TOP_MONTH_METRIC_READERS: Record<WorkspaceDataQueryTopMonthMetric, (month: WorkspaceScenarioMonthForRanking) => number> = {
  [WORKSPACE_DATA_QUERY_METRIC.plannedRevenue]: (month) => month.grossSales,
  [WORKSPACE_DATA_QUERY_METRIC.plannedCost]: (month) => month.totalCost,
  [WORKSPACE_DATA_QUERY_METRIC.cash]: (month) => month.cumulativeCash,
  [WORKSPACE_DATA_QUERY_METRIC.plannedProfit]: (month) => month.monthlyProfit,
}

function normalizeTopMonthMetric(metric: WorkspaceDataQueryMetric | undefined): WorkspaceDataQueryTopMonthMetric {
  return isWorkspaceDataQueryTopMonthMetric(metric) ? metric : WORKSPACE_DATA_QUERY_METRIC.plannedProfit
}

function topMonthMetricReader(metric: WorkspaceDataQueryTopMonthMetric) {
  return TOP_MONTH_METRIC_READERS[metric]
}

export async function planWorkspaceDataQueryRead(
  ctx: WorkspaceDataQueryContext,
  step: WorkspaceDataQueryStep,
): Promise<WorkspaceDataQueryRead | null> {
  const { config, projection } = await currentDraftProjection(ctx)
  const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null
  if (!baseScenario) return null

  const metrics = normalizeDataMetrics(step.metrics)
  const scope = normalizedDataScope(step, metrics)

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.entitySummary) {
    const members = config.teamMembers.map((member, index) => ({
      index: index + 1,
      id: member.id,
      name: member.name,
      employmentType: member.employmentType,
      monthlyBasePay: member.monthlyBasePay,
      commissionRate: member.commissionRate,
    }))
    const shareholders = config.shareholders.map((shareholder, index) => ({
      index: index + 1,
      id: shareholder.id,
      name: shareholder.name,
      investmentAmount: shareholder.investmentAmount,
      dividendRate: shareholder.dividendRate,
    }))
    const employees = config.employees.map((employee, index) => ({
      index: index + 1,
      id: employee.id,
      name: employee.name,
      role: employee.role,
      monthlyBasePay: employee.monthlyBasePay,
      perEventCost: employee.perEventCost,
    }))
    const costItems = {
      monthlyFixed: config.operating.monthlyFixedCosts.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, amount: item.amount })),
      perEvent: config.operating.perEventCosts.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, amount: item.amount })),
      perUnit: config.operating.perUnitCosts.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, amount: item.amount })),
      stage: config.stageCostItems.map((item, index) => ({ index: index + 1, id: item.id, name: item.name, mode: item.mode })),
    }
    const firstShareholder = shareholders[0]
    const memberSample = members.slice(0, 8).map((member) => member.name).join('、')
    const shareholderText = shareholders.length > 0
      ? `首位股东是 ${firstShareholder?.name}，当前投资额 ${money(firstShareholder?.investmentAmount ?? 0)}；股东列表：${shareholders.map((shareholder) => `${shareholder.index}. ${shareholder.name} ${money(shareholder.investmentAmount)}`).join('、')}`
      : '当前没有股东。'
    return workspaceDataRead({
      title: '检查工作区业务对象',
      message: `当前工作区有 ${members.length} 个成员、${shareholders.length} 个股东、${employees.length} 位员工。${memberSample ? `成员示例：${memberSample}。` : ''}${shareholderText}`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'inputs', secondaryTab: 'capital' },
        reason: '成员、股东和成本结构检查需要打开调模型页面，便于核对现有对象。',
      },
      data: {
        scope,
        memberCount: members.length,
        members,
        shareholderCount: shareholders.length,
        shareholders,
        employeeCount: employees.length,
        employees,
        costItems,
      },
    })
  }

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.teamSummary) {
    const members = config.teamMembers
    const names = members.map((member) => member.name).filter((name) => name.trim().length > 0)
    const includeNames = metrics.length === 0 || metrics.includes(WORKSPACE_DATA_QUERY_METRIC.teamMemberNames)
    const nameText = includeNames && names.length > 0 ? `，分别是：${names.join('、')}` : ''
    return workspaceDataRead({
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

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.periodSummary) {
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
    const includeActual = metrics.length === 0 || WORKSPACE_DATA_QUERY_ACTUAL_METRICS.some((metric) => metrics.includes(metric))
    const parts = [
      `${period.month_label}计划收入 ${money(plannedRevenue)}`,
      `计划成本 ${money(plannedCost)}`,
      `计划利润 ${money(plannedProfit)}`,
      ...(includeActual ? [`实际收入 ${money(actualRevenue)}`, `实际成本 ${money(actualCost)}`, `实际利润 ${money(actualProfit)}`] : []),
    ]
    const route: AgentNavigationEvent['route'] = includeActual
      ? { mainTab: 'variance', secondaryTab: 'analysis', selectedPeriodId: period.id }
      : { mainTab: 'dashboard', secondaryTab: 'months', selectedPeriodId: period.id }
    return workspaceDataRead({
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

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.memberSummary) {
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
    return workspaceDataRead({
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

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.topMonths) {
    const metric = normalizeTopMonthMetric(metrics[0])
    const metricValue = topMonthMetricReader(metric)
    const order = step.order === 'asc' ? 'asc' : 'desc'
    const limit = Math.min(6, Math.max(1, Math.round(typeof step.limit === 'number' ? step.limit : 3)))
    const ranked = baseScenario.months
      .map((month) => ({ month, value: metricValue(month) }))
      .sort((a, b) => (order === 'asc' ? a.value - b.value : b.value - a.value))
      .slice(0, limit)
    return workspaceDataRead({
      title: '回答月份排行问题',
      message: `按${WORKSPACE_DATA_QUERY_METRIC_LABELS[metric]}${order === 'asc' ? '升序' : '降序'}，前 ${limit} 个月份是：${ranked.map((item) => `${item.month.label} ${money(item.value)}`).join('；')}。`,
      navigation: {
        type: 'navigation',
        route: { mainTab: 'dashboard', secondaryTab: 'months' },
        reason: '月份排行问答需要打开按月分析页面，便于核对口径。',
      },
      data: { scope, metric, order, limit, ranked: ranked.map((item) => ({ monthLabel: item.month.label, value: item.value })) },
    })
  }

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.varianceDetail) {
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
    return workspaceDataRead({
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

  if (scope === WORKSPACE_DATA_QUERY_SCOPE.ledgerHistory) {
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

    return workspaceDataRead({
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

  return workspaceDataRead({
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

function sameJsonValue(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return Object.is(left, right)
  }
}

export async function planOnlineFactorFromFields(
  ctx: AgentTurnContext,
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
  ctx: AgentTurnContext,
  patches: Array<{ path: string; value: unknown; label?: string }>,
) {
  if (patches.length === 0) return null
  const { draft, config } = await currentDraftConfig(ctx)
  const nextConfig = cloneModelConfig(config)
  const details = []
  const changedPatches = []

  for (const patch of patches) {
    const oldValue = getConfigPath(nextConfig, patch.path)
    if (sameJsonValue(oldValue, patch.value)) continue
    setConfigPath(nextConfig, patch.path, patch.value)
    changedPatches.push(patch)
    details.push({
      label: patch.label ?? patch.path,
      value: `${JSON.stringify(oldValue)} -> ${JSON.stringify(patch.value)}`,
    })
  }

  if (changedPatches.length === 0) {
    return {
      title: '模型草稿未变化',
      message: '这次工具参数和当前草稿一致，没有生成写入确认卡。请重新给出需要增加、减少或改成的具体值。',
      readKind: 'tool_observation',
      status: 'info',
      navigation: modelWorkbenchNavigation('模型草稿修改需要打开调模型页面供核对。'),
    } satisfies ReadDraft
  }

  const normalized = hydrateModelConfig(nextConfig)
  return {
    kind: 'workspace.update_draft',
    title: '确认修改模型草稿',
    summary: `将 ${changedPatches.length} 项模型输入保存到当前草稿。`,
    targetLabel: ctx.workspace.name,
    riskLevel: 'medium',
    details: details.slice(0, 8),
    navigation: modelWorkbenchNavigation('模型草稿修改需要打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: changedPatches,
    },
  } satisfies AgentActionDraft
}

export function planWorkspaceRename(ctx: AgentTurnContext, workspaceName: unknown) {
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

export async function planExportBundleRead(ctx: AgentTurnContext) {
  const bundle = await exportWorkspaceBundle(ctx.db, ctx.workspace)
  return {
    title: '导出工作区 Bundle',
    message: `已生成当前工作区 bundle：${bundle.workspaceName}，包含 ${bundle.snapshots.length} 个历史版本。完整 JSON 可通过 /api/v1/workspace/bundle 获取；本次 Agent 未修改业务数据。`,
    navigation: workspacePanelNavigation('导出工作区属于版本管理动作，需要打开版本管理面板。'),
    status: 'executed',
  } satisfies ReadDraft
}

export function planImportBundleFromValue(ctx: AgentTurnContext, rawBundle: unknown) {
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

type RecordValue = Record<string, unknown>

type StageDefinition = {
  item: StageCostItem
  defaultAmount: number
  defaultCount: number | null
}

type StageValueOverride = {
  amount: number | null
  count: number | null
}

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecordValue) : []
}

function firstString(record: RecordValue, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function numberField(record: RecordValue, ...keys: string[]) {
  for (const key of keys) {
    const value = finiteNumber(record[key])
    if (value !== null) return value
  }
  return null
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function roundFactor(value: number) {
  return Math.round(value * 10000) / 10000
}

function nonNegative(value: number | null, fallback = 0) {
  return value === null || !Number.isFinite(value) ? fallback : Math.max(0, value)
}

function positiveInteger(value: number | null, fallback = 1) {
  if (value === null || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

function normalizedRate(value: unknown) {
  const raw = finiteNumber(value)
  if (raw === null) return null
  const normalized = raw > 1 ? raw / 100 : raw
  return Math.min(1, Math.max(0, roundFactor(normalized)))
}

function money(value: number) {
  return `¥${Math.round(value).toLocaleString('zh-CN')}`
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function buildNamedCostItems(raw: unknown, fallbackPrefix: string): CostItem[] {
  return recordArray(raw).flatMap((item, index) => {
    const name = firstString(item, 'name') || `${fallbackPrefix} ${index + 1}`
    const amount = numberField(item, 'amount')
    return name ? [createCostItem(newId(), { name, amount: nonNegative(amount) })] : []
  })
}

function buildShareholders(current: Shareholder[], plan: RecordValue) {
  const rows = recordArray(plan.shareholders)
  if (rows.length === 0) return current

  const shareholders = rows.flatMap((item, index) => {
    const name = firstString(item, 'name', 'shareholderName') || `股东 ${index + 1}`
    if (!name) return [] as Shareholder[]
    return [
      createShareholder(newId(), {
        name,
        investmentAmount: nonNegative(numberField(item, 'investmentAmount', 'amount', 'cashInvestment')),
        dividendRate: normalizedRate(item.dividendRate ?? item.shareRatio ?? item.ratio) ?? 0,
      }),
    ]
  })

  const reservedDividendRate = normalizedRate(plan.reservedDividendRate)
  if (reservedDividendRate !== null && !shareholders.some((item) => item.investmentAmount === 0 && item.dividendRate === reservedDividendRate)) {
    shareholders.push(createShareholder(newId(), {
      name: '员工激励池',
      investmentAmount: 0,
      dividendRate: reservedDividendRate,
    }))
  }

  return shareholders.length > 0 ? shareholders : current
}

function employmentTypeFromSegment(segment: RecordValue, monthlyBasePay: number): EmploymentType {
  return segment.employmentType === 'salary' || segment.employmentType === 'partTime'
    ? segment.employmentType
    : monthlyBasePay > 0
      ? 'salary'
      : 'partTime'
}

function buildTeamMembers(current: TeamMember[], plan: RecordValue, assumptions: string[]) {
  const segments = recordArray(plan.memberSegments)
  if (segments.length === 0) return { members: current, onlineFactor: null as number | null, segmentSummary: [] as string[] }

  const members: TeamMember[] = []
  const segmentSummary: string[] = []
  let memberIndex = 1
  let weightedOfflineUnits = 0
  let weightedOnlineUnits = 0

  for (const segment of segments) {
    const count = positiveInteger(numberField(segment, 'count'), 1)
    const label = firstString(segment, 'label', 'segmentName') || `分层 ${segmentSummary.length + 1}`
    const namePrefix = firstString(segment, 'namePrefix') || '成员'
    const basePay = nonNegative(numberField(segment, 'monthlyBasePay', 'basePay'))
    const basePayAfterMonth = numberField(segment, 'monthlyBasePayAfterMonth', 'basePayAfterMonth')
    const firstBasePayFreeMonths = numberField(segment, 'firstBasePayFreeMonths')
    const monthlyBasePay = basePayAfterMonth !== null && basePay === 0 ? nonNegative(basePayAfterMonth) : basePay
    const commissionRate = normalizedRate(segment.commissionRate) ?? 0
    const perEventTravelCost = nonNegative(numberField(segment, 'perEventTravelCost', 'travelCost'))
    const offlineUnits = nonNegative(numberField(segment, 'offlineUnitsPerEvent', 'baseUnitsPerEvent', 'unitsPerEvent'))
    const onlineUnits = nonNegative(numberField(segment, 'onlineUnitsPerEvent'))
    const pessimisticUnits = nonNegative(numberField(segment, 'pessimisticUnitsPerEvent'), roundFactor(offlineUnits * 0.8))
    const optimisticUnits = nonNegative(numberField(segment, 'optimisticUnitsPerEvent'), roundFactor(offlineUnits * 1.2))
    const employmentType = employmentTypeFromSegment(segment, monthlyBasePay)

    if (basePayAfterMonth !== null || (firstBasePayFreeMonths !== null && firstBasePayFreeMonths > 0)) {
      assumptions.push(`${label} 的阶段性保底已用稳定期月保底 ${monthlyBasePay} 元近似；当前领域模型暂不表达前几个月免保底。`)
    }

    for (let localIndex = 1; localIndex <= count; localIndex += 1) {
      members.push(createMember(newId(), {
        name: `${namePrefix} ${memberIndex}`,
        employmentType,
        monthlyBasePay,
        perEventTravelCost,
        commissionRate,
        unitsPerEvent: {
          pessimistic: pessimisticUnits,
          base: offlineUnits,
          optimistic: optimisticUnits,
        },
      }))
      memberIndex += 1
    }

    weightedOfflineUnits += offlineUnits * count
    weightedOnlineUnits += onlineUnits * count
    segmentSummary.push(`${label} ${count} 人，基准场均线下 ${offlineUnits} 张，线上 ${onlineUnits} 张`)
  }

  const onlineFactor = weightedOfflineUnits > 0 ? roundFactor(weightedOnlineUnits / weightedOfflineUnits) : null
  if (onlineFactor !== null) {
    assumptions.push(`线上收入用统一线上系数 ${onlineFactor} 近似，由各成员分层线上张数除以线下张数加权得到。`)
  }

  return { members: members.length > 0 ? members : current, onlineFactor, segmentSummary }
}

function buildEmployees(current: Employee[], plan: RecordValue) {
  const rows = recordArray(plan.employees)
  if (rows.length === 0) return current
  const employees: Employee[] = []
  let employeeIndex = 1

  for (const item of rows) {
    const role = firstString(item, 'role', 'name', 'namePrefix') || `员工岗位 ${employeeIndex}`
    const namePrefix = firstString(item, 'namePrefix', 'name') || role
    const count = positiveInteger(numberField(item, 'count'), 1)
    const monthlyBasePay = nonNegative(numberField(item, 'monthlyBasePay', 'basePay'))
    const perEventCost = nonNegative(numberField(item, 'perEventCost', 'eventCost'))

    for (let index = 1; index <= count; index += 1) {
      employees.push(createEmployee(newId(), {
        name: count === 1 && firstString(item, 'name') ? firstString(item, 'name') : `${namePrefix} ${index}`,
        role,
        monthlyBasePay,
        perEventCost,
      }))
      employeeIndex += 1
    }
  }

  return employees.length > 0 ? employees : current
}

function addStageDefinition(
  definitions: StageDefinition[],
  byKey: Map<string, StageDefinition>,
  input: { name: string; mode: StageCostMode; amount?: number; count?: number | null },
) {
  const name = input.name.trim()
  const key = `${input.mode}:${name.toLocaleLowerCase()}`
  const existing = byKey.get(key)
  if (existing) {
    if (input.amount !== undefined) existing.defaultAmount = input.amount
    if (input.count !== undefined) existing.defaultCount = input.count
    return existing
  }
  const definition: StageDefinition = {
    item: createStageCostItem(newId(), { name, mode: input.mode }),
    defaultAmount: input.amount ?? 0,
    defaultCount: input.count ?? null,
  }
  definitions.push(definition)
  byKey.set(key, definition)
  return definition
}

function monthOverrideMap(overrides: Map<number, Map<string, StageValueOverride>>, monthIndex: number) {
  let map = overrides.get(monthIndex)
  if (!map) {
    map = new Map()
    overrides.set(monthIndex, map)
  }
  return map
}

function stageMode(value: unknown): StageCostMode {
  return value === 'monthly' || value === 'perEvent' || value === 'perUnit' ? value : 'monthly'
}

function buildStageDefinitions(plan: RecordValue) {
  const definitions: StageDefinition[] = []
  const byKey = new Map<string, StageDefinition>()
  const overrides = new Map<number, Map<string, StageValueOverride>>()
  const extraIncomeByMonth = new Map<number, number>()

  for (const item of recordArray(plan.stageCosts)) {
    const name = firstString(item, 'name') || `专项成本 ${definitions.length + 1}`
    addStageDefinition(definitions, byKey, {
      name,
      mode: stageMode(item.mode),
      amount: nonNegative(numberField(item, 'amount')),
      count: numberField(item, 'count'),
    })
  }

  for (const item of recordArray(plan.startupCosts)) {
    const name = firstString(item, 'name') || `启动成本 ${definitions.length + 1}`
    const definition = addStageDefinition(definitions, byKey, { name, mode: 'monthly', amount: 0 })
    monthOverrideMap(overrides, 1).set(definition.item.id, { amount: nonNegative(numberField(item, 'amount')), count: 1 })
  }

  const marketingDefinition = recordArray(plan.monthlyMarketing).length > 0
    ? addStageDefinition(definitions, byKey, { name: '宣发', mode: 'monthly', amount: 0 })
    : null
  if (marketingDefinition) {
    for (const item of recordArray(plan.monthlyMarketing)) {
      const monthIndex = positiveInteger(numberField(item, 'monthIndex'), 1)
      monthOverrideMap(overrides, monthIndex).set(marketingDefinition.item.id, {
        amount: nonNegative(numberField(item, 'amount')),
        count: 1,
      })
    }
  }

  for (const item of recordArray(plan.specialEvents)) {
    const monthIndex = positiveInteger(numberField(item, 'monthIndex'), 1)
    const eventName = firstString(item, 'name') || `第 ${monthIndex} 月专项活动`
    const extraCost = numberField(item, 'extraCost', 'cost')
    if (extraCost !== null && extraCost > 0) {
      const definition = addStageDefinition(definitions, byKey, { name: `${eventName}成本`, mode: 'monthly', amount: 0 })
      monthOverrideMap(overrides, monthIndex).set(definition.item.id, { amount: extraCost, count: 1 })
    }
    const extraIncome = numberField(item, 'extraIncome', 'income')
    if (extraIncome !== null && extraIncome > 0) {
      extraIncomeByMonth.set(monthIndex, (extraIncomeByMonth.get(monthIndex) ?? 0) + extraIncome)
    }
  }

  for (const item of recordArray(plan.months)) {
    const monthIndex = positiveInteger(numberField(item, 'monthIndex'), 1)
    const extraIncome = numberField(item, 'extraIncome')
    if (extraIncome !== null && extraIncome > 0) {
      extraIncomeByMonth.set(monthIndex, (extraIncomeByMonth.get(monthIndex) ?? 0) + extraIncome)
    }
    for (const cost of recordArray(item.specialCosts)) {
      const name = firstString(cost, 'name') || `第 ${monthIndex} 月专项成本`
      const definition = addStageDefinition(definitions, byKey, { name, mode: 'monthly', amount: 0 })
      monthOverrideMap(overrides, monthIndex).set(definition.item.id, {
        amount: numberField(cost, 'amount'),
        count: numberField(cost, 'count'),
      })
    }
  }

  return { definitions, overrides, extraIncomeByMonth }
}

function stageCostValueFor(definition: StageDefinition, monthIndex: number, events: number, overrides: Map<number, Map<string, StageValueOverride>>) {
  const override = overrides.get(monthIndex)?.get(definition.item.id)
  const amount = override?.amount ?? definition.defaultAmount
  const defaultCount = definition.item.mode === 'perEvent'
    ? definition.defaultCount ?? events
    : 1
  const count = override?.count ?? defaultCount
  return {
    itemId: definition.item.id,
    amount: nonNegative(amount),
    count: nonNegative(count),
  }
}

function monthInputByIndex(plan: RecordValue) {
  const map = new Map<number, RecordValue>()
  for (const item of recordArray(plan.months)) {
    const monthIndex = positiveInteger(numberField(item, 'monthIndex'), 1)
    map.set(monthIndex, item)
  }
  return map
}

function buildMonths(input: {
  current: MonthlyPlan[]
  plan: RecordValue
  stageDefinitions: StageDefinition[]
  stageOverrides: Map<number, Map<string, StageValueOverride>>
  extraIncomeByMonth: Map<number, number>
  planning: { startMonth: number; horizonMonths: number }
  onlineFactor: number
  teamMembers: TeamMember[]
  offlineUnitPrice: number
  onlineUnitPrice: number
  assumptions: string[]
}) {
  const monthInputs = monthInputByIndex(input.plan)
  const stageItems = input.stageDefinitions.map((definition) => definition.item)
  const months: MonthlyPlan[] = []
  const totalBaseOfflineUnits = input.teamMembers.reduce((sum, member) => sum + nonNegative(member.unitsPerEvent.base), 0)

  for (let index = 1; index <= input.planning.horizonMonths; index += 1) {
    const monthInput = monthInputs.get(index)
    const existing = input.current[index - 1]
    const events = nonNegative(monthInput ? numberField(monthInput, 'events') : null, existing?.events ?? 0)
    const onlineSalesFactor = nonNegative(monthInput ? numberField(monthInput, 'onlineSalesFactor') : null, existing?.onlineSalesFactor ?? input.onlineFactor)
    const baseMultiplier = nonNegative(monthInput ? numberField(monthInput, 'salesMultiplier') : null, existing?.salesMultiplier ?? 1)
    const extraIncome = input.extraIncomeByMonth.get(index) ?? 0
    const revenuePerMultiplier = events * totalBaseOfflineUnits * (input.offlineUnitPrice + onlineSalesFactor * input.onlineUnitPrice)
    const extraIncomeMultiplier = extraIncome > 0 && revenuePerMultiplier > 0 ? extraIncome / revenuePerMultiplier : 0
    if (extraIncome > 0) {
      if (extraIncomeMultiplier > 0) {
        input.assumptions.push(`第 ${index} 月额外收入 ${money(extraIncome)} 已折算为销量系数增量 ${roundFactor(extraIncomeMultiplier)}。`)
      } else {
        input.assumptions.push(`第 ${index} 月额外收入 ${money(extraIncome)} 当前模型无法在无场次或无成员销量时表达，未计入预测。`)
      }
    }
    const values = input.stageDefinitions.map((definition) =>
      stageCostValueFor(definition, index, events, input.stageOverrides),
    )

    months.push(createMonth(
      newId(),
      {
        id: `month-${newId()}`,
        label: getMonthLabel(input.planning.startMonth, index - 1),
        events,
        salesMultiplier: roundFactor(baseMultiplier + extraIncomeMultiplier),
        onlineSalesFactor: roundFactor(onlineSalesFactor),
        rehearsalCount: nonNegative(monthInput ? numberField(monthInput, 'rehearsalCount') : null, existing?.rehearsalCount ?? 0),
        rehearsalCost: nonNegative(monthInput ? numberField(monthInput, 'rehearsalCost') : null, existing?.rehearsalCost ?? 0),
        teacherCount: nonNegative(monthInput ? numberField(monthInput, 'teacherCount') : null, existing?.teacherCount ?? 0),
        teacherCost: nonNegative(monthInput ? numberField(monthInput, 'teacherCost') : null, existing?.teacherCost ?? 0),
        specialCosts: createStageCostValues(stageItems, values),
      },
      stageItems,
    ))
  }

  return months
}

function buildOperatingModelConfig(current: ModelConfig, plan: RecordValue, assumptions: string[]) {
  const planningRecord = isRecordValue(plan.planning) ? plan.planning : {}
  const operatingRecord = isRecordValue(plan.operating) ? plan.operating : {}
  const planning = {
    startMonth: Math.min(12, Math.max(1, Math.round(nonNegative(numberField(planningRecord, 'startMonth'), current.planning.startMonth || 1)))),
    horizonMonths: Math.min(24, Math.max(1, Math.round(nonNegative(numberField(planningRecord, 'horizonMonths'), current.planning.horizonMonths || 12)))),
  }

  const offlineUnitPrice = nonNegative(numberField(operatingRecord, 'offlineUnitPrice'), current.operating.offlineUnitPrice)
  const onlineUnitPrice = nonNegative(numberField(operatingRecord, 'onlineUnitPrice'), current.operating.onlineUnitPrice)
  const polaroidLossRate = normalizedRate(operatingRecord.polaroidLossRate) ?? current.operating.polaroidLossRate
  const shareholders = buildShareholders(current.shareholders, plan)
  const memberResult = buildTeamMembers(current.teamMembers, plan, assumptions)
  const employees = buildEmployees(current.employees, plan)
  const monthlyFixedCosts = buildNamedCostItems(plan.monthlyFixedCosts, '每月固定成本')
  const perEventCosts = buildNamedCostItems(plan.perEventCosts, '每场成本')
  const perUnitCosts = buildNamedCostItems(plan.perUnitCosts, '每张成本')
  const revenueFeeRate = normalizedRate(operatingRecord.revenueFeeRate)

  if (revenueFeeRate !== null && revenueFeeRate > 0) {
    perUnitCosts.push(createCostItem(newId(), {
      name: '平台手续费估算',
      amount: roundMoney(offlineUnitPrice * revenueFeeRate),
    }))
    assumptions.push(`收入手续费率 ${pct(revenueFeeRate)} 已按线下单价折算为每张 ${money(offlineUnitPrice * revenueFeeRate)} 的按张成本。`)
  }

  const { definitions, overrides, extraIncomeByMonth } = buildStageDefinitions(plan)
  const stageDefinitions = definitions.length > 0
    ? definitions
    : current.stageCostItems.map((item) => ({ item, defaultAmount: 0, defaultCount: null }))
  const stageCostItems = stageDefinitions.map((definition) => definition.item)
  const onlineFactorFromPlan = numberField(operatingRecord, 'onlineSalesFactor', 'onlineFactor')
  const onlineFactor = nonNegative(onlineFactorFromPlan, memberResult.onlineFactor ?? current.timelineTemplate.onlineSalesFactor ?? 0)
  const months = buildMonths({
    current: current.months,
    plan,
    stageDefinitions,
    stageOverrides: overrides,
    extraIncomeByMonth,
    planning,
    onlineFactor,
    teamMembers: memberResult.members,
    offlineUnitPrice,
    onlineUnitPrice,
    assumptions,
  })
  const lastMonth = months[months.length - 1]
  const timelineTemplate = createTimelineTemplate(
    lastMonth
      ? {
          events: lastMonth.events,
          salesMultiplier: lastMonth.salesMultiplier,
          onlineSalesFactor: lastMonth.onlineSalesFactor,
          rehearsalCount: lastMonth.rehearsalCount,
          rehearsalCost: lastMonth.rehearsalCost,
          teacherCount: lastMonth.teacherCount,
          teacherCost: lastMonth.teacherCost,
          specialCosts: lastMonth.specialCosts,
        }
      : undefined,
    stageCostItems,
  )

  const nextConfig = hydrateModelConfig({
    shareholders,
    operating: {
      offlineUnitPrice,
      onlineUnitPrice,
      polaroidLossRate,
      monthlyFixedCosts: monthlyFixedCosts.length > 0 ? monthlyFixedCosts : current.operating.monthlyFixedCosts,
      perEventCosts: perEventCosts.length > 0 ? perEventCosts : current.operating.perEventCosts,
      perUnitCosts: perUnitCosts.length > 0 ? perUnitCosts : current.operating.perUnitCosts,
    },
    planning,
    stageCostItems,
    timelineTemplate,
    teamMembers: memberResult.members,
    employees,
    months,
  })

  return { config: nextConfig, segmentSummary: memberResult.segmentSummary }
}

function projectionSummary(config: ModelConfig) {
  const base = projectModel(config).scenarios.find((scenario) => scenario.key === 'base')
  if (!base) return null
  const firstMonth = base.months[0]
  if (!firstMonth) return null
  const worst = base.months.reduce((selected, month) => (month.monthlyProfit < selected.monthlyProfit ? month : selected), firstMonth)
  const best = base.months.reduce((selected, month) => (month.monthlyProfit > selected.monthlyProfit ? month : selected), firstMonth)
  return { base, worst, best }
}

export async function planOperatingModelFromStep(ctx: AgentTurnContext, step: RuntimeToolStep) {
  const rawPlan = isRecordValue(step.plan)
    ? step.plan
    : isRecordValue(step.modelPlan)
      ? step.modelPlan
      : isRecordValue(step.scenario)
        ? step.scenario
        : null
  if (!rawPlan) return null

  const { draft, config } = await currentDraftConfig(ctx)
  const assumptions: string[] = []
  const explicitAssumptions = Array.isArray(rawPlan.assumptions)
    ? rawPlan.assumptions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
  assumptions.push(...explicitAssumptions)

  const result = buildOperatingModelConfig(config, rawPlan, assumptions)
  const normalized = result.config
  const workspaceName = firstString(rawPlan, 'workspaceName', 'projectName') || ctx.workspace.name
  const summary = projectionSummary(normalized)
  const navigation = operatingModelNavigation('完整经营模型配置需要打开调模型页面，从资本和输入结构开始核对。')
  const totalInvestment = normalized.shareholders.reduce((sum, shareholder) => sum + Math.max(0, shareholder.investmentAmount), 0)
  const stageCostCount = normalized.stageCostItems.length
  const assumptionLines = assumptions.length > 0 ? assumptions.slice(0, 5) : ['未填写的字段沿用当前草稿或领域默认值。']
  const forecastDetails = summary
    ? [
        { label: '总收入', value: money(summary.base.grossSales) },
        { label: '总成本', value: money(summary.base.totalCost) },
        { label: '总利润', value: money(summary.base.totalProfit) },
        { label: '期末现金', value: money(summary.base.netCashAfterInvestment) },
        { label: '回本月份', value: summary.base.paybackMonthLabel ?? '未回本' },
        { label: '最亏月份', value: `${summary.worst.label} ${money(summary.worst.monthlyProfit)}` },
        { label: '最赚钱月份', value: `${summary.best.label} ${money(summary.best.monthlyProfit)}` },
      ]
    : []

  const action: AgentActionDraft = {
    kind: 'workspace.update_draft',
    title: '确认生成完整经营模型',
    summary: `生成“${workspaceName}”的 ${normalized.planning.horizonMonths} 个月经营模型草稿。确认后覆盖当前草稿，不发布正式版本。`,
    targetLabel: workspaceName,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '生成完整经营模型草稿' },
      { label: '工作区名称', value: workspaceName },
      { label: '预测周期', value: `${normalized.planning.startMonth} 月开始，共 ${normalized.planning.horizonMonths} 个月` },
      { label: '股东', value: `${normalized.shareholders.length} 个，总投资 ${money(totalInvestment)}` },
      { label: '成员', value: `${normalized.teamMembers.length} 个${result.segmentSummary.length > 0 ? `：${result.segmentSummary.join('；')}` : ''}` },
      { label: '员工', value: `${normalized.employees.length} 个` },
      { label: '成本项', value: `固定 ${normalized.operating.monthlyFixedCosts.length} 个，每场 ${normalized.operating.perEventCosts.length} 个，每张 ${normalized.operating.perUnitCosts.length} 个，专项 ${stageCostCount} 个` },
      ...forecastDetails,
      { label: '近似假设', value: assumptionLines.join('；') },
      { label: '审计说明', value: '确认后仅覆盖当前草稿；不会发布版本，也不会生成分享链接。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName,
      config: normalized,
      source: 'workspace_configure_operating_model',
      assumptions,
    },
  }

  const read: ReadDraft = summary
    ? {
        title: '经营模型预测预览',
        message: `经营模型配置预览：基准场景总收入 ${money(summary.base.grossSales)}，总成本 ${money(summary.base.totalCost)}，总利润 ${money(summary.base.totalProfit)}，期末现金 ${money(summary.base.netCashAfterInvestment)}，回本月份 ${summary.base.paybackMonthLabel ?? '未回本'}，最亏月份 ${summary.worst.label} ${money(summary.worst.monthlyProfit)}，最赚钱月份 ${summary.best.label} ${money(summary.best.monthlyProfit)}。写入动作会通过确认卡保存，本步骤不发布版本。`,
        navigation,
        status: 'executed',
      }
    : {
        title: '经营模型预测预览',
        message: '经营模型配置预览已生成，但当前模型无法生成基准预测摘要；请在确认卡里核对配置。写入动作会通过确认卡保存，本步骤不发布版本。',
        navigation,
        status: 'info',
      }

  return [action, read]
}

export function planWorkspacePatchFromStep(ctx: AgentTurnContext, step: RuntimeToolStep) {
  return step.patches ? planWorkspacePatch(ctx, step.patches) : null
}
