import { ReceiptText } from 'lucide-react'
import type { MonthlyPlan, MonthlyScenarioResult, ScenarioKey, ScenarioResult } from '../../types'
import { cx, formatCurrency, formatDecimal, formatPaybackMonths } from '../../lib/format'
import { SegmentTabs, Panel, SectionTitle, StatCard } from '../common/ui'
import { MetricBandChart, type ChartMetricKey } from './MetricBandChart'

const scenarioLegend: Record<ScenarioKey, { label: string; color: string }> = {
  pessimistic: { label: '悲观', color: 'bg-rose-400' },
  base: { label: '基准', color: 'bg-amber-400' },
  optimistic: { label: '乐观', color: 'bg-emerald-400' },
}

export function OverviewPanel(props: {
  scenarios: ScenarioResult[]
  selectedScenarioResult: ScenarioResult
  chartMetric: ChartMetricKey
  chartMetricTabs: Array<{ value: ChartMetricKey; label: string }>
  initialInvestment: number
  onChartMetricChange: (value: ChartMetricKey) => void
  months: MonthlyPlan[]
  selectedMonthPlan: MonthlyPlan
  selectedMonthResult: MonthlyScenarioResult
  onSelectMonth: (id: string) => void
}) {
  const memberBasePayCost = props.selectedMonthResult.basePayCost
  const employeeCost =
    props.selectedMonthResult.employeeBasePayCost + props.selectedMonthResult.employeeEventCost
  const trainingCost = props.selectedMonthResult.rehearsalCost + props.selectedMonthResult.teacherCost
  const perEventCost = props.selectedMonthResult.eventOperatingCost + props.selectedMonthResult.extraPerEventCost
  const monthColumnCount = Math.min(6, Math.max(3, props.months.length))

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.04fr)_minmax(360px,0.96fr)] xl:items-start">
      <section className="self-start rounded-[28px] bg-stone-950 p-5 text-white shadow-[0_18px_50px_rgba(41,37,36,0.22)] md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-400">Metrics</p>
            <h2 className="mt-2 text-2xl font-bold text-white">
              {props.selectedScenarioResult.label}场景走势
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-stone-300">
              当前图表会跟随场景切换，灰色带仍保留悲观到乐观的上下界，彩色点和标签只标注当前选中场景。
            </p>
          </div>
          <SegmentTabs
            dark
            compact
            value={props.chartMetric}
            items={props.chartMetricTabs}
            onChange={props.onChartMetricChange}
          />
        </div>

        <div className="mt-4 rounded-[24px] border border-white/10 bg-white/[0.03] p-3 md:p-4">
          <MetricBandChart
            scenarios={props.scenarios}
            metric={props.chartMetric}
            initialInvestment={props.initialInvestment}
            selectedScenarioKey={props.selectedScenarioResult.key}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {(['pessimistic', 'base', 'optimistic'] as ScenarioKey[]).map((key) => (
            <span
              key={key}
              className={cx(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                props.selectedScenarioResult.key === key
                  ? 'border-white/10 bg-white/10 text-white'
                  : 'border-white/10 bg-white/5 text-stone-300',
              )}
            >
              <span className={cx('h-2.5 w-2.5 rounded-full', scenarioLegend[key].color)} />
              {scenarioLegend[key].label}
            </span>
          ))}
        </div>
      </section>

      <Panel className="self-start">
        <SectionTitle
          icon={ReceiptText}
          eyebrow="Breakdown"
          title={`${props.selectedMonthPlan.label} 经营明细`}
          description="这里不再重复整段周期的总营收和总成本，而是直接展开当前月份的输入参数、成本结构和回本进度。月总成本口径包含提成。"
          aside={
            <div className="rounded-[18px] border border-stone-900/10 bg-stone-50/80 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">当前查看</p>
              <p className="mt-1 text-sm font-semibold text-stone-950">{props.selectedMonthPlan.label}</p>
            </div>
          }
        />

        <div className="mt-4 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
          <div className="grid gap-3 lg:grid-cols-[160px_minmax(0,1fr)] lg:items-center">
            <div className="shrink-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">月度切换</p>
              <p className="mt-1 text-sm font-semibold text-stone-950">选择月份展开单月输入与成本</p>
            </div>
            <div
              className="grid min-w-0 gap-2"
              style={{ gridTemplateColumns: `repeat(${monthColumnCount}, minmax(0, 1fr))` }}
            >
              {props.months.map((month) => (
                <button
                  key={month.id}
                  type="button"
                  onClick={() => props.onSelectMonth(month.id)}
                  className={
                    month.id === props.selectedMonthPlan.id
                      ? 'min-w-0 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-2 text-xs font-semibold leading-none text-amber-800'
                      : 'min-w-0 rounded-full border border-stone-900/10 bg-white px-2.5 py-2 text-xs font-medium leading-none text-stone-600 transition hover:bg-stone-100'
                  }
                >
                  {month.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCard label="回本周期" value={formatPaybackMonths(props.selectedScenarioResult.paybackMonthIndex)} />
          <StatCard label="当前月利润" value={formatCurrency(props.selectedMonthResult.monthlyProfit)} />
          <StatCard label="累计现金" value={formatCurrency(props.selectedMonthResult.cumulativeCash)} />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[0.86fr_1.14fr] xl:items-start">
          <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">输入参数</p>
              <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                当月输入
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              <DetailMetric label="场次" value={`${props.selectedMonthResult.events} 场`} />
              <DetailMetric label="销售系数" value={`${formatDecimal(props.selectedMonthResult.salesMultiplier)}x`} />
              <DetailMetric label="单场总张数" value={`${formatDecimal(props.selectedMonthResult.totalUnitsPerEvent)} 张`} />
              <DetailMetric label="月营收" value={formatCurrency(props.selectedMonthResult.grossSales)} />
            </div>
          </div>

          <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">成本拆解</p>
              <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                含提成
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <DetailMetric label="提成成本" value={formatCurrency(props.selectedMonthResult.commissionCost)} />
              <DetailMetric label="成员底薪" value={formatCurrency(memberBasePayCost)} />
              <DetailMetric label="员工成本" value={formatCurrency(employeeCost)} />
              <DetailMetric label="训练成本" value={formatCurrency(trainingCost)} />
              <DetailMetric label="经营固定" value={formatCurrency(props.selectedMonthResult.fixedOperatingCost)} />
              <DetailMetric label="每场成本" value={formatCurrency(perEventCost)} />
              <DetailMetric label="专项项目" value={formatCurrency(props.selectedMonthResult.specialProjectCost)} />
              <DetailMetric label="耗材" value={formatCurrency(props.selectedMonthResult.unitLinkedCostTotal)} />
              <DetailMetric label="月总成本" value={formatCurrency(props.selectedMonthResult.totalCost)} />
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-[20px] border border-stone-900/10 bg-white px-4 py-4">
          <p className="text-xs uppercase tracking-[0.18em] text-stone-500">经营备注</p>
          <p className="mt-2 text-sm leading-7 text-stone-600">
            {props.selectedMonthPlan.notes || '这个月份还没有备注。可以在“模型输入 -> 月度排期 -> 备注”里补充。'}
          </p>
        </div>
      </Panel>
    </div>
  )
}

function DetailMetric(props: {
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[18px] border border-stone-900/10 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-[0.16em] text-stone-500">{props.label}</p>
      <p className="text-sm font-semibold text-right text-stone-950">{props.value}</p>
    </div>
  )
}
