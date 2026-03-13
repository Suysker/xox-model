import { BarChart3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PeriodResponse, VarianceResponse } from '../../lib/api'
import { cx, formatCompactNumber, formatCurrency, formatPercent } from '../../lib/format'
import { Panel, SectionTitle, SegmentTabs } from '../common/ui'

type VarianceMetric = 'revenue' | 'cost'
type VarianceScope = 'current' | 'cumulative'

const metricTabs: Array<{ value: VarianceMetric; label: string }> = [
  { value: 'revenue', label: '收入' },
  { value: 'cost', label: '成本' },
]

const scopeTabs: Array<{ value: VarianceScope; label: string }> = [
  { value: 'current', label: '当期' },
  { value: 'cumulative', label: '累计' },
]

export function VariancePanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  variance: VarianceResponse | null
  onSelectPeriod: (id: string) => void
}) {
  const [metric, setMetric] = useState<VarianceMetric>('revenue')
  const [scope, setScope] = useState<VarianceScope>('current')

  const trendRows = useMemo(() => buildTrendRows(props.periods, metric, scope), [metric, props.periods, scope])
  const selectedPeriod = props.periods.find((period) => period.id === props.selectedPeriodId) ?? props.periods[0] ?? null
  const topDrivers = useMemo(() => getTopVarianceDrivers(props.variance), [props.variance])

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={BarChart3}
          eyebrow="预实分析"
          title={props.variance?.baselineVersionName ? `基线 ${props.variance.baselineVersionName}` : '计划与实际'}
          description={selectedPeriod ? `当前期间：${selectedPeriod.monthLabel}` : undefined}
        />

        <div className="mt-5 flex flex-wrap gap-2">
          {props.periods.map((period) => (
            <button
              key={period.id}
              type="button"
              onClick={() => props.onSelectPeriod(period.id)}
              className={
                props.selectedPeriodId === period.id
                  ? 'rounded-full border border-stone-950 bg-stone-950 px-4 py-2 text-sm font-semibold text-white'
                  : 'rounded-full border border-stone-900/10 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700'
              }
            >
              {period.monthLabel}
            </button>
          ))}
        </div>
      </Panel>

      {props.variance ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <VarianceMetricCard
              title="收入表现"
              tone="revenue"
              planned={props.variance.plannedRevenue}
              actual={props.variance.actualRevenue}
              varianceAmount={props.variance.revenueVarianceAmount}
              varianceRate={props.variance.revenueVarianceRate}
              cumulativePlanned={props.variance.cumulativePlannedRevenue}
              cumulativeActual={props.variance.cumulativeActualRevenue}
              cumulativeVarianceAmount={props.variance.cumulativeRevenueVarianceAmount}
              cumulativeVarianceRate={props.variance.cumulativeRevenueVarianceRate}
            />
            <VarianceMetricCard
              title="成本表现"
              tone="cost"
              planned={props.variance.plannedCost}
              actual={props.variance.actualCost}
              varianceAmount={props.variance.costVarianceAmount}
              varianceRate={props.variance.costVarianceRate}
              cumulativePlanned={props.variance.cumulativePlannedCost}
              cumulativeActual={props.variance.cumulativeActualCost}
              cumulativeVarianceAmount={props.variance.cumulativeCostVarianceAmount}
              cumulativeVarianceRate={props.variance.cumulativeCostVarianceRate}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_340px]">
            <Panel>
              <SectionTitle
                icon={BarChart3}
                eyebrow="趋势"
                title="计划与实际走势"
                aside={
                  <div className="flex flex-wrap gap-2">
                    <SegmentTabs value={metric} items={metricTabs} onChange={setMetric} compact />
                    <SegmentTabs value={scope} items={scopeTabs} onChange={setScope} compact />
                  </div>
                }
              />

              <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-3 md:p-4">
                <VarianceTrendChart rows={trendRows} selectedPeriodId={props.selectedPeriodId} onSelect={props.onSelectPeriod} />
              </div>
            </Panel>

            <Panel>
              <SectionTitle
                icon={BarChart3}
                eyebrow="驱动"
                title="当期偏差来源"
              />

              <div className="mt-5">
                <VarianceDriverBars rows={topDrivers} />
              </div>
            </Panel>
          </div>

          <Panel>
            <SectionTitle
              icon={BarChart3}
              eyebrow="明细"
              title="科目对账"
            />

            <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10">
              <table className="w-full table-fixed border-collapse text-sm">
                <thead className="bg-stone-100/90 text-stone-700">
                  <tr className="border-b border-stone-900/10">
                    <HeaderCell>科目</HeaderCell>
                    <HeaderCell>计划</HeaderCell>
                    <HeaderCell>实际</HeaderCell>
                    <HeaderCell>差异</HeaderCell>
                    <HeaderCell>差异率</HeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {props.variance.lines.map((line) => (
                    <tr key={line.subjectKey} className="border-b border-stone-900/10 last:border-none">
                      <BodyCell className="font-semibold text-stone-950">{line.subjectName}</BodyCell>
                      <BodyCell>{formatCurrency(line.plannedAmount)}</BodyCell>
                      <BodyCell>{formatCurrency(line.actualAmount)}</BodyCell>
                      <BodyCell className={getVarianceToneClass(line.subjectType, line.varianceAmount)}>
                        {formatCurrency(line.varianceAmount)}
                      </BodyCell>
                      <BodyCell>{line.varianceRate === null ? '-' : formatPercent(line.varianceRate)}</BodyCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  )
}

function VarianceMetricCard(props: {
  title: string
  tone: VarianceMetric
  planned: number
  actual: number
  varianceAmount: number
  varianceRate: number | null
  cumulativePlanned: number
  cumulativeActual: number
  cumulativeVarianceAmount: number
  cumulativeVarianceRate: number | null
}) {
  return (
    <Panel>
      <SectionTitle icon={BarChart3} eyebrow="表现" title={props.title} />

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <VarianceStack
          label="当期"
          planned={props.planned}
          actual={props.actual}
          varianceAmount={props.varianceAmount}
          varianceRate={props.varianceRate}
          tone={props.tone}
        />
        <VarianceStack
          label="累计"
          planned={props.cumulativePlanned}
          actual={props.cumulativeActual}
          varianceAmount={props.cumulativeVarianceAmount}
          varianceRate={props.cumulativeVarianceRate}
          tone={props.tone}
        />
      </div>
    </Panel>
  )
}

function VarianceStack(props: {
  label: string
  planned: number
  actual: number
  varianceAmount: number
  varianceRate: number | null
  tone: VarianceMetric
}) {
  const ratio = props.planned > 0 ? props.actual / props.planned : null
  const ratioLabel = props.tone === 'revenue' ? '达成' : '执行'
  const ratioToneClass =
    ratio === null ? 'text-stone-500' : getVarianceToneClass(props.tone === 'revenue' ? 'revenue' : 'cost', props.varianceAmount)
  const ratioWidth = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100))

  return (
    <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-4">
      <p className="text-xs font-semibold tracking-[0.16em] text-stone-500">{props.label}</p>
      <div className="mt-3 grid gap-3">
        <MetricRow label="计划" value={formatCurrency(props.planned)} />
        <MetricRow label="实际" value={formatCurrency(props.actual)} />
        <MetricRow
          label="差异"
          value={formatCurrency(props.varianceAmount)}
          className={getVarianceToneClass(props.tone === 'revenue' ? 'revenue' : 'cost', props.varianceAmount)}
        />
        <MetricRow label="差异率" value={props.varianceRate === null ? '-' : formatPercent(props.varianceRate)} />
      </div>

      <div className="mt-4 rounded-[18px] border border-stone-900/10 bg-white px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold tracking-[0.16em] text-stone-500">{ratioLabel}</span>
          <span className={cx('text-sm font-semibold', ratioToneClass)}>
            {ratio === null ? '-' : formatPercent(ratio)}
          </span>
        </div>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-stone-200">
          <div
            className={cx(
              'h-full rounded-full transition-[width]',
              ratio === null ? 'bg-stone-300' : props.tone === 'revenue' ? 'bg-amber-500' : 'bg-stone-950',
            )}
            style={{ width: `${ratioWidth}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function MetricRow(props: { label: string; value: string; className?: string | undefined }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <span className="text-sm text-stone-500">{props.label}</span>
      <span className={cx('text-right text-base font-semibold text-stone-950', props.className)}>{props.value}</span>
    </div>
  )
}

function VarianceTrendChart(props: {
  rows: Array<{ periodId: string; label: string; planned: number; actual: number }>
  selectedPeriodId: string
  onSelect: (id: string) => void
}) {
  const width = 760
  const height = 300
  const padding = { top: 22, right: 20, bottom: 42, left: 60 }
  const allValues = props.rows.flatMap((row) => [row.planned, row.actual])
  const minValue = Math.min(0, ...allValues)
  const maxValue = Math.max(1, ...allValues)
  const valueRange = maxValue - minValue || 1
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xStep = props.rows.length > 1 ? plotWidth / (props.rows.length - 1) : 0
  const selectedIndex = Math.max(0, props.rows.findIndex((row) => row.periodId === props.selectedPeriodId))
  const tickValues = Array.from({ length: 4 }, (_, index) => minValue + (valueRange / 3) * index)

  function getX(index: number) {
    return padding.left + xStep * index
  }

  function getY(value: number) {
    return padding.top + ((maxValue - value) / valueRange) * plotHeight
  }

  function buildLine(values: number[]) {
    return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value)}`).join(' ')
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-[300px] w-full" role="img" aria-label="预实分析趋势图">
      {props.rows.map((row, index) => {
        const center = getX(index)
        const previousCenter = index === 0 ? padding.left : getX(index - 1)
        const nextCenter = index === props.rows.length - 1 ? width - padding.right : getX(index + 1)
        const zoneStart = index === 0 ? padding.left : (previousCenter + center) / 2
        const zoneEnd = index === props.rows.length - 1 ? width - padding.right : (center + nextCenter) / 2

        return (
          <g key={row.periodId}>
            {index === selectedIndex ? (
              <rect
                x={zoneStart}
                y={padding.top}
                width={zoneEnd - zoneStart}
                height={plotHeight}
                rx="14"
                fill="rgba(245,158,11,0.10)"
              />
            ) : null}
            <rect
              x={zoneStart}
              y={padding.top}
              width={zoneEnd - zoneStart}
              height={plotHeight + padding.bottom}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onClick={() => props.onSelect(row.periodId)}
            />
          </g>
        )
      })}

      {tickValues.map((tick) => (
        <g key={tick}>
          <line
            x1={padding.left}
            y1={getY(tick)}
            x2={width - padding.right}
            y2={getY(tick)}
            stroke="rgba(120,113,108,0.18)"
            strokeDasharray="4 6"
          />
          <text x={padding.left - 10} y={getY(tick) + 4} textAnchor="end" fontSize="11" fill="#78716c">
            {formatCompactNumber(tick)}
          </text>
        </g>
      ))}

      <path d={buildLine(props.rows.map((row) => row.planned))} fill="none" stroke="#f59e0b" strokeWidth="3" strokeDasharray="6 6" />
      <path d={buildLine(props.rows.map((row) => row.actual))} fill="none" stroke="#292524" strokeWidth="3.5" strokeLinecap="round" />

      {props.rows.map((row, index) => (
        <g key={`${row.periodId}-points`}>
          <circle cx={getX(index)} cy={getY(row.planned)} r="4.5" fill="#f59e0b" stroke="white" strokeWidth="1.5" />
          <circle cx={getX(index)} cy={getY(row.actual)} r={index === selectedIndex ? '5' : '4.5'} fill="#292524" stroke="white" strokeWidth="1.5" />
          <text
            x={getX(index)}
            y={height - 12}
            textAnchor="middle"
            fontSize="11"
            fontWeight={index === selectedIndex ? '700' : '500'}
            fill={index === selectedIndex ? '#b45309' : '#57534e'}
          >
            {row.label}
          </text>
        </g>
      ))}

      <g>
        <rect x={padding.left} y={10} width="12" height="12" rx="4" fill="#f59e0b" />
        <text x={padding.left + 18} y={20} fontSize="12" fill="#57534e">
          计划
        </text>
        <rect x={padding.left + 74} y={10} width="12" height="12" rx="4" fill="#292524" />
        <text x={padding.left + 92} y={20} fontSize="12" fill="#57534e">
          实际
        </text>
      </g>
    </svg>
  )
}

function VarianceDriverBars(props: {
  rows: Array<{ label: string; amount: number; type: 'revenue' | 'cost' }>
}) {
  if (props.rows.length === 0) {
    return (
      <div className="rounded-[22px] border border-dashed border-stone-900/10 bg-stone-50/80 px-4 py-10 text-center text-sm text-stone-500">
        当前期间还没有偏差驱动。
      </div>
    )
  }

  const maxAbs = Math.max(1, ...props.rows.map((row) => Math.abs(row.amount)))

  return (
    <div className="grid gap-3">
      {props.rows.map((row) => {
        const width = `${(Math.abs(row.amount) / maxAbs) * 100}%`
        const positive = row.type === 'revenue' ? row.amount >= 0 : row.amount <= 0

        return (
          <div key={row.label} className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-stone-950">{row.label}</span>
              <span className={positive ? 'text-sm font-semibold text-emerald-700' : 'text-sm font-semibold text-rose-700'}>
                {formatCurrency(row.amount)}
              </span>
            </div>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-stone-200">
              <div className={positive ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-rose-500'} style={{ width }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function buildTrendRows(periods: PeriodResponse[], metric: VarianceMetric, scope: VarianceScope) {
  let plannedRunning = 0
  let actualRunning = 0

  return periods.map((period) => {
    const planned = metric === 'revenue' ? period.plannedRevenue : period.plannedCost
    const actual = metric === 'revenue' ? period.actualRevenue : period.actualCost

    if (scope === 'current') {
      return {
        periodId: period.id,
        label: period.monthLabel,
        planned,
        actual,
      }
    }

    plannedRunning += planned
    actualRunning += actual

    return {
      periodId: period.id,
      label: period.monthLabel,
      planned: plannedRunning,
      actual: actualRunning,
    }
  })
}

function getTopVarianceDrivers(variance: VarianceResponse | null) {
  if (!variance) {
    return []
  }

  return [...variance.lines]
    .sort((left, right) => Math.abs(right.varianceAmount) - Math.abs(left.varianceAmount))
    .slice(0, 6)
    .map((line) => ({
      label: line.subjectName,
      amount: line.varianceAmount,
      type: line.subjectType,
    }))
}

function getVarianceToneClass(subjectType: 'revenue' | 'cost', amount: number) {
  const positive = subjectType === 'revenue' ? amount >= 0 : amount <= 0
  return positive ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'
}

function HeaderCell(props: { children: string }) {
  return <th className="px-4 py-3 text-center text-xs font-semibold tracking-[0.16em]">{props.children}</th>
}

function BodyCell(props: { children: React.ReactNode; className?: string | undefined }) {
  return <td className={cx('px-4 py-3 text-center text-stone-700', props.className)}>{props.children}</td>
}
