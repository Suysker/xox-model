import { BarChart3 } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { PeriodResponse, VarianceResponse } from '../../lib/api'

function SummaryCard(props: { label: string; value: string; tone?: 'neutral' | 'positive' | 'negative' }) {
  const toneClass =
    props.tone === 'positive'
      ? 'text-emerald-700'
      : props.tone === 'negative'
        ? 'text-rose-700'
        : 'text-stone-950'

  return (
    <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className={`mt-2 text-lg font-bold ${toneClass}`}>{props.value}</p>
    </div>
  )
}

export function VariancePanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  variance: VarianceResponse | null
  onSelectPeriod: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={BarChart3}
          eyebrow="预实分析"
          title="计划与实际"
          description="对比当前期间预算基线与已过账实际。"
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
          <Panel>
            <SectionTitle
              icon={BarChart3}
              eyebrow="期间"
              title={props.variance.baselineVersionName ? `基线 ${props.variance.baselineVersionName}` : '差异汇总'}
              description={`当前期间：${props.variance.monthLabel}`}
            />
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <SummaryCard label="计划收入" value={formatCurrency(props.variance.plannedRevenue)} />
              <SummaryCard label="实际收入" value={formatCurrency(props.variance.actualRevenue)} />
              <SummaryCard label="收入差异" value={formatCurrency(props.variance.revenueVarianceAmount)} tone={props.variance.revenueVarianceAmount >= 0 ? 'positive' : 'negative'} />
              <SummaryCard label="收入差异率" value={props.variance.revenueVarianceRate === null ? '-' : formatPercent(props.variance.revenueVarianceRate)} tone={props.variance.revenueVarianceRate !== null && props.variance.revenueVarianceRate >= 0 ? 'positive' : props.variance.revenueVarianceRate !== null ? 'negative' : 'neutral'} />
              <SummaryCard label="计划成本" value={formatCurrency(props.variance.plannedCost)} />
              <SummaryCard label="实际成本" value={formatCurrency(props.variance.actualCost)} />
              <SummaryCard label="成本差异" value={formatCurrency(props.variance.costVarianceAmount)} tone={props.variance.costVarianceAmount <= 0 ? 'positive' : 'negative'} />
              <SummaryCard label="成本差异率" value={props.variance.costVarianceRate === null ? '-' : formatPercent(props.variance.costVarianceRate)} tone={props.variance.costVarianceRate !== null && props.variance.costVarianceRate <= 0 ? 'positive' : props.variance.costVarianceRate !== null ? 'negative' : 'neutral'} />
            </div>
          </Panel>

          <Panel>
            <SectionTitle
              icon={BarChart3}
              eyebrow="累计"
              title="累计差异"
              description="按期间基线累计到当前期间。"
            />
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <SummaryCard label="累计计划收入" value={formatCurrency(props.variance.cumulativePlannedRevenue)} />
              <SummaryCard label="累计实际收入" value={formatCurrency(props.variance.cumulativeActualRevenue)} />
              <SummaryCard label="累计收入差异" value={formatCurrency(props.variance.cumulativeRevenueVarianceAmount)} tone={props.variance.cumulativeRevenueVarianceAmount >= 0 ? 'positive' : 'negative'} />
              <SummaryCard label="累计收入差异率" value={props.variance.cumulativeRevenueVarianceRate === null ? '-' : formatPercent(props.variance.cumulativeRevenueVarianceRate)} tone={props.variance.cumulativeRevenueVarianceRate !== null && props.variance.cumulativeRevenueVarianceRate >= 0 ? 'positive' : props.variance.cumulativeRevenueVarianceRate !== null ? 'negative' : 'neutral'} />
              <SummaryCard label="累计计划成本" value={formatCurrency(props.variance.cumulativePlannedCost)} />
              <SummaryCard label="累计实际成本" value={formatCurrency(props.variance.cumulativeActualCost)} />
              <SummaryCard label="累计成本差异" value={formatCurrency(props.variance.cumulativeCostVarianceAmount)} tone={props.variance.cumulativeCostVarianceAmount <= 0 ? 'positive' : 'negative'} />
              <SummaryCard label="累计成本差异率" value={props.variance.cumulativeCostVarianceRate === null ? '-' : formatPercent(props.variance.cumulativeCostVarianceRate)} tone={props.variance.cumulativeCostVarianceRate !== null && props.variance.cumulativeCostVarianceRate <= 0 ? 'positive' : props.variance.cumulativeCostVarianceRate !== null ? 'negative' : 'neutral'} />
            </div>
          </Panel>

          <Panel>
            <SectionTitle
              icon={BarChart3}
              eyebrow="科目明细"
              title="差异明细"
              description="行项目汇总必须与上方期间汇总一致。"
            />
            <div className="mt-5 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.16em] text-stone-500">
                    <th className="px-3 py-2">科目</th>
                    <th className="px-3 py-2">计划</th>
                    <th className="px-3 py-2">实际</th>
                    <th className="px-3 py-2">差异</th>
                    <th className="px-3 py-2">差异率</th>
                  </tr>
                </thead>
                <tbody>
                  {props.variance.lines.map((line) => (
                    <tr key={line.subjectKey} className="bg-stone-50/90 text-sm text-stone-700">
                      <td className="px-3 py-3 font-semibold text-stone-950">{line.subjectName}</td>
                      <td className="px-3 py-3">{formatCurrency(line.plannedAmount)}</td>
                      <td className="px-3 py-3">{formatCurrency(line.actualAmount)}</td>
                      <td className={line.varianceAmount >= 0 ? 'px-3 py-3 text-emerald-700' : 'px-3 py-3 text-rose-700'}>
                        {formatCurrency(line.varianceAmount)}
                      </td>
                      <td className="px-3 py-3">{line.varianceRate === null ? '-' : formatPercent(line.varianceRate)}</td>
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
