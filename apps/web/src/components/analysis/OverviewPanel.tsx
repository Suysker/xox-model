import { ReceiptText } from 'lucide-react'
import type { MonthlyPlan, MonthlyScenarioResult, ScenarioKey, ScenarioResult } from '../../types'
import { cx, formatCompactNumber, formatCurrency, formatDecimal, formatPaybackMonths } from '../../lib/format'
import { getScenarioLabel } from '../../lib/scenarios'
import { MetricBandChart, type ChartMetricKey } from './MetricBandChart'
import { Panel, SectionTitle, StatCard } from '../common/ui'

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
  onChartMetricChange: (value: ChartMetricKey) => void
  months: MonthlyPlan[]
  selectedMonthPlan: MonthlyPlan
  selectedMonthResult: MonthlyScenarioResult
  onSelectMonth: (id: string) => void
}) {
  const trainingCost = props.selectedMonthResult.rehearsalCost + props.selectedMonthResult.teacherCost
  const monthlyFixedBase = props.selectedMonthResult.monthlyFixedCostTotal - props.selectedMonthResult.specialProjectCost
  const perEventCost = props.selectedMonthResult.perEventCostTotal
  const selectedMonthIndex = Math.max(
    0,
    props.months.findIndex((month) => month.id === props.selectedMonthPlan.id),
  )
  const monthLabelStride = Math.max(1, Math.ceil(props.months.length / 6))
  const visibleMonths = props.months.filter(
    (_, index) => index === 0 || index === props.months.length - 1 || index % monthLabelStride === 0,
  )
  const scenarioMonthRows = props.scenarios
    .map((scenario) => ({
      key: scenario.key,
      label: getScenarioLabel(scenario.key, scenario.label),
      revenue: scenario.months[selectedMonthIndex]?.grossSales ?? 0,
      cost: scenario.months[selectedMonthIndex]?.totalCost ?? 0,
      profit: scenario.months[selectedMonthIndex]?.monthlyProfit ?? 0,
      color: keyToColor(scenario.key),
    }))
    .filter((row) => row.revenue > 0 || row.cost > 0 || row.profit !== 0)

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.02fr)_minmax(520px,0.98fr)] xl:items-stretch">
      <section className="flex h-full flex-col rounded-[28px] border border-stone-900/10 bg-white/88 p-5 shadow-[0_18px_50px_rgba(70,52,17,0.08)] backdrop-blur md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">指标</p>
            <h2 className="mt-2 text-2xl font-bold text-stone-950">
              {getScenarioLabel(props.selectedScenarioResult.key, props.selectedScenarioResult.label)}场景走势
            </h2>
          </div>

          <div className="flex flex-col gap-2 lg:items-end">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-500">图表口径</p>
            <ChartMetricSelector
              value={props.chartMetric}
              items={props.chartMetricTabs}
              onChange={props.onChartMetricChange}
            />
          </div>
        </div>

        <div className="mt-4 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-3 md:p-4">
          <MetricBandChart
            scenarios={props.scenarios}
            metric={props.chartMetric}
            selectedScenarioKey={props.selectedScenarioResult.key}
            monthIds={props.months.map((month) => month.id)}
            selectedMonthId={props.selectedMonthPlan.id}
            onSelectMonth={props.onSelectMonth}
          />
        </div>

        <div className="mt-4 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">当前月份</p>
              <h3 className="mt-1 text-lg font-semibold text-stone-950">{props.selectedMonthPlan.label} 三档对比</h3>
            </div>
            <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
              营收 / 成本 / 利润
            </span>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_148px] lg:items-end">
            <SelectedMonthScenarioBars rows={scenarioMonthRows} />

            <div className="grid gap-2">
              {(['pessimistic', 'base', 'optimistic'] as ScenarioKey[]).map((key) => (
                <span
                  key={key}
                  className={cx(
                    'inline-flex items-center justify-between rounded-full border px-3 py-2 text-xs font-medium',
                    props.selectedScenarioResult.key === key
                      ? 'border-stone-900/10 bg-stone-950 text-white'
                      : 'border-stone-900/10 bg-white text-stone-600',
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className={cx('h-2.5 w-2.5 rounded-full', scenarioLegend[key].color)} />
                    {scenarioLegend[key].label}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <Panel className="flex h-full flex-col">
        <SectionTitle icon={ReceiptText} eyebrow="拆解" title={`${props.selectedMonthPlan.label} 经营明细`} />

        <div className="mt-4 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">月份</p>
            <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-500">
              {selectedMonthIndex + 1} / {props.months.length}
            </span>
          </div>

          <div className="mt-3">
            <input
              type="range"
              min={0}
              max={Math.max(0, props.months.length - 1)}
              step={1}
              value={selectedMonthIndex}
              onChange={(event) => {
                const nextMonth = props.months[Number(event.target.value)]
                if (nextMonth) {
                  props.onSelectMonth(nextMonth.id)
                }
              }}
              className="h-2 w-full cursor-pointer accent-amber-500"
            />
            <div
              className="mt-2 grid gap-2 text-[11px] font-medium text-stone-500"
              style={{ gridTemplateColumns: `repeat(${visibleMonths.length}, minmax(0, 1fr))` }}
            >
              {visibleMonths.map((month) => (
                <span
                  key={month.id}
                  className={cx(
                    'truncate text-center transition',
                    month.id === props.selectedMonthPlan.id && 'font-semibold text-amber-700',
                  )}
                >
                  {month.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCard label="回本周期" value={formatPaybackMonths(props.selectedScenarioResult.paybackMonthIndex)} />
          <StatCard label="当前月利润" value={formatCurrency(props.selectedMonthResult.monthlyProfit)} />
          <StatCard label="累计现金" value={formatCurrency(props.selectedMonthResult.cumulativeCash)} />
        </div>

        <div className="mt-4 grid flex-1 gap-3 lg:grid-cols-[minmax(210px,0.68fr)_minmax(0,1.32fr)]">
          <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">当前月输入</p>
              <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                输入
              </span>
            </div>

            <CompactMetricList
              className="mt-3"
              rows={[
                { label: '场次', value: `${props.selectedMonthResult.events} 场` },
                { label: '销售系数', value: `${formatDecimal(props.selectedMonthResult.salesMultiplier)}x` },
                { label: '单场总张数', value: `${formatDecimal(props.selectedMonthResult.totalUnitsPerEvent)} 张` },
                { label: '线上系数', value: `${formatDecimal(props.selectedMonthResult.onlineSalesFactor)}x` },
                { label: '线下营收', value: formatCurrency(props.selectedMonthResult.memberGrossSales) },
                { label: '线上营收', value: formatCurrency(props.selectedMonthResult.onlineRevenue) },
                { label: '月营收', value: formatCurrency(props.selectedMonthResult.grossSales), emphasis: true },
              ]}
            />
          </section>

          <section className="flex flex-col rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">成本拆解</p>
              <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                含提成
              </span>
            </div>

            <div className="mt-3 grid gap-2.5 md:grid-cols-2">
              <CompactMetricList
                rows={[
                  { label: '月固定合计', value: formatCurrency(monthlyFixedBase) },
                  { label: '每场合计', value: formatCurrency(perEventCost) },
                  { label: '专项项目', value: formatCurrency(props.selectedMonthResult.specialProjectCost) },
                  { label: '每张耗材', value: formatCurrency(props.selectedMonthResult.unitLinkedCostTotal) },
                  { label: '提成成本', value: formatCurrency(props.selectedMonthResult.commissionCost) },
                  { label: '月总成本', value: formatCurrency(props.selectedMonthResult.totalCost), emphasis: true },
                ]}
              />

              <CompactMetricList
                rows={[
                  { label: '成员底薪', value: formatCurrency(props.selectedMonthResult.basePayCost) },
                  { label: '成员路费', value: formatCurrency(props.selectedMonthResult.memberTravelCost) },
                  { label: '员工月薪', value: formatCurrency(props.selectedMonthResult.employeeBasePayCost) },
                  { label: '员工场次', value: formatCurrency(props.selectedMonthResult.employeeEventCost) },
                  { label: '经营固定', value: formatCurrency(props.selectedMonthResult.monthlyOperatingCost) },
                  { label: '训练成本', value: formatCurrency(trainingCost) },
                ]}
              />
            </div>
          </section>
        </div>
      </Panel>
    </div>
  )
}

function CompactMetricList(props: {
  rows: Array<{
    label: string
    value: string
    emphasis?: boolean | undefined
  }>
  className?: string | undefined
}) {
  return (
    <div className={cx('overflow-hidden rounded-[20px] border border-stone-900/10 bg-white', props.className)}>
      {props.rows.map((row, index) => (
        <div
          key={row.label}
          className={cx(
            'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3',
            index !== props.rows.length - 1 && 'border-b border-stone-900/10',
            row.emphasis && 'bg-amber-50/70',
          )}
        >
          <p className="whitespace-nowrap text-sm text-stone-500">{row.label}</p>
          <p className={cx('text-right text-[15px] font-semibold text-stone-950', row.emphasis && 'text-amber-900')}>
            {row.value}
          </p>
        </div>
      ))}
    </div>
  )
}

function ChartMetricSelector<T extends string>(props: {
  value: T
  items: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5 rounded-[18px] border border-stone-900/10 bg-stone-50/90 p-1.5 sm:inline-flex sm:flex-wrap">
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => props.onChange(item.value)}
          className={cx(
            'min-w-[72px] rounded-[14px] px-3 py-2 text-sm font-medium transition',
            props.value === item.value
              ? 'bg-stone-950 text-white shadow-[0_10px_24px_rgba(28,25,23,0.14)]'
              : 'text-stone-600 hover:bg-white',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function keyToColor(key: ScenarioKey) {
  if (key === 'pessimistic') {
    return '#fb7185'
  }

  if (key === 'optimistic') {
    return '#34d399'
  }

  return '#fbbf24'
}

function SelectedMonthScenarioBars(props: {
  rows: Array<{
    key: ScenarioKey
    label: string
    revenue: number
    cost: number
    profit: number
    color: string
  }>
}) {
  const width = 760
  const height = 176
  const padding = { top: 14, right: 16, bottom: 34, left: 44 }
  const metrics = ['revenue', 'cost', 'profit'] as const
  const labels: Record<(typeof metrics)[number], string> = {
    revenue: '营收',
    cost: '成本',
    profit: '利润',
  }
  const maxValue = Math.max(1, ...props.rows.flatMap((row) => [row.revenue, row.cost, Math.max(0, row.profit)]))
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const groupWidth = plotWidth / metrics.length
  const barWidth = Math.min(32, groupWidth / Math.max(3, props.rows.length + 1))

  function getY(value: number) {
    return padding.top + plotHeight - (Math.max(0, value) / maxValue) * plotHeight
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-[176px] w-full"
      role="img"
      aria-label="当前月份三档场景的营收、成本和利润对比图"
    >
      {Array.from({ length: 4 }, (_, index) => {
        const value = (maxValue / 3) * index
        const y = getY(value)

        return (
          <g key={value}>
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="rgba(120,113,108,0.16)"
              strokeDasharray="4 6"
            />
            <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#78716c">
              {formatCompactNumber(value)}
            </text>
          </g>
        )
      })}

      {metrics.map((metric, metricIndex) => {
        const groupStart = padding.left + metricIndex * groupWidth
        const groupCenter = groupStart + groupWidth / 2

        return (
          <g key={metric}>
            <text x={groupCenter} y={height - 10} textAnchor="middle" fontSize="11" fill="#57534e">
              {labels[metric]}
            </text>
            {props.rows.map((row, rowIndex) => {
              const value = row[metric]
              const x = groupStart + 16 + rowIndex * (barWidth + 10)
              const y = getY(value)
              const h = padding.top + plotHeight - y

              return (
                <g key={`${metric}-${row.key}`}>
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={h}
                    rx="9"
                    fill={row.color}
                    opacity={metric === 'cost' ? 0.78 : 0.92}
                  />
                  <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize="10" fontWeight="700" fill="#292524">
                    {formatCompactNumber(value)}
                  </text>
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}
