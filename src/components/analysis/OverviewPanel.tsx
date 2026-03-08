import { Sparkles } from 'lucide-react'
import type { MonthlyPlan, MonthlyScenarioResult, ScenarioKey, ScenarioResult } from '../../types'
import { cx, formatCurrency, formatPercent } from '../../lib/format'
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
  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-[28px] bg-stone-950 p-5 text-white shadow-[0_18px_50px_rgba(41,37,36,0.22)] md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-400">Metrics</p>
            <h2 className="mt-2 text-2xl font-bold text-white">
              {props.selectedScenarioResult.label}场景走势
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-stone-300">
              {props.selectedScenarioResult.description}
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

        <div className="mt-4">
          <MetricBandChart
            scenarios={props.scenarios}
            metric={props.chartMetric}
            initialInvestment={props.initialInvestment}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {(['pessimistic', 'base', 'optimistic'] as ScenarioKey[]).map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-stone-200"
            >
              <span className={cx('h-2.5 w-2.5 rounded-full', scenarioLegend[key].color)} />
              {scenarioLegend[key].label}
            </span>
          ))}
        </div>
      </section>

      <Panel>
        <SectionTitle
          icon={Sparkles}
          eyebrow="Decision"
          title={`${props.selectedScenarioResult.label}场景摘要`}
          description="这一列只保留投资判断最需要的指标，再加一个当前月份透视，避免把所有数字一起堆出来。"
        />

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <StatCard label="总营收" value={formatCurrency(props.selectedScenarioResult.grossSales)} />
          <StatCard label="总成本" value={formatCurrency(props.selectedScenarioResult.totalCost)} />
          <StatCard label="总利润" value={formatCurrency(props.selectedScenarioResult.totalProfit)} />
          <StatCard label="ROI" value={formatPercent(props.selectedScenarioResult.roi)} />
          <StatCard
            label="平均单场张数"
            value={`${Math.round(props.selectedScenarioResult.averageUnitsPerEvent)} 张`}
          />
          <StatCard
            label="回本判断"
            value={
              props.selectedScenarioResult.paybackMonthLabel
                ? `${props.selectedScenarioResult.paybackMonthLabel} 回本`
                : '周期内未回本'
            }
          />
        </div>

        <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
                  Current Month
                </p>
                <h3 className="mt-1 text-lg font-semibold text-stone-950">
                  {props.selectedMonthPlan.label} 透视
                </h3>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {props.months.map((month) => (
                  <button
                    key={month.id}
                    type="button"
                    onClick={() => props.onSelectMonth(month.id)}
                    className={
                      month.id === props.selectedMonthPlan.id
                        ? 'rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800'
                        : 'rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-medium text-stone-600 transition hover:bg-stone-100'
                    }
                  >
                    {month.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <MiniMetric label="本月营收" value={formatCurrency(props.selectedMonthResult.grossSales)} />
              <MiniMetric label="本月总成本" value={formatCurrency(props.selectedMonthResult.totalCost)} />
              <MiniMetric label="本月利润" value={formatCurrency(props.selectedMonthResult.monthlyProfit)} />
              <MiniMetric label="累计现金" value={formatCurrency(props.selectedMonthResult.cumulativeCash)} />
            </div>

            <div className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-4">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">经营备注</p>
              <p className="mt-2 text-sm leading-7 text-stone-600">
                {props.selectedMonthPlan.notes || '这个月份还没有备注。可以在“模型输入 -> 月度排期 -> 备注”里补充。'}
              </p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

function MiniMetric(props: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className="mt-2 text-sm font-semibold text-stone-950">{props.value}</p>
    </div>
  )
}
