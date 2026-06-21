import {
  buildToolSurfaceDiscoveryObservation,
  buildToolSurfaceManifestSearchObservation,
} from '@agentic-os/core'
import type { AgentNavigationEvent } from '@xox/contracts'
import { projectModel } from '@xox/domain'
import { listEntries, listPeriods, varianceForPeriod } from '../modules/ledger.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import type { ActionDraftBuilderHandlers } from './action-draft-builder.js'
import type { PlannerContext } from './action-draft-builder.js'
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
import {
  AGENT_TOOL_REGISTRY,
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

type WorkspaceDataQueryContext = Pick<PlannerContext, 'db' | 'workspace'>

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

function money(value: number) {
  return `¥${Math.round(value).toLocaleString('zh-CN')}`
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`
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

export async function answerWorkspaceDataQuestion(
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
