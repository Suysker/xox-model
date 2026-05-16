import type { Kysely } from 'kysely'
import { projectModel } from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import type { Database, Row } from '../db/schema.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import { listPeriods } from '../modules/ledger.js'

type DataAgentContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
}

export type DataAgentQueryStep = {
  scope?: unknown
  metrics?: unknown
  monthLabel?: string | null
  memberName?: string | null
  order?: unknown
  limit?: unknown
}

export type DataAgentRead = {
  title: string
  message: string
  navigation: AgentNavigationEvent
  status: 'executed'
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

  const scope = step.scope === 'workspace_summary' || step.scope === 'period_summary' || step.scope === 'member_summary' || step.scope === 'top_months'
    ? step.scope
    : 'workspace_summary'
  const metrics = normalizeDataMetrics(step.metrics)

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
    return {
      title: '回答单月数据问题',
      message: `${parts.join('，')}。本次只读取当前工作区数据，未修改业务数据。`,
      navigation: {
        type: 'navigation',
        route,
        reason: '数据问答需要打开对应月份的分析页面，便于核对口径。',
      },
      status: 'executed',
    }
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
    }
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
    }
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
  }
}
