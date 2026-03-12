import { BarChart3 } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { PeriodResponse, VarianceResponse } from '../../lib/api'

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
          eyebrow="Variance"
          title="Plan vs actual"
          description="Compare posted actuals with the baseline released version attached to each period."
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
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Planned revenue</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(props.variance.plannedRevenue)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Actual revenue</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(props.variance.actualRevenue)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Planned cost</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(props.variance.plannedCost)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Actual cost</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(props.variance.actualCost)}</p>
              </div>
            </div>
          </Panel>

          <Panel>
            <SectionTitle
              icon={BarChart3}
              eyebrow="Lines"
              title={props.variance.baselineVersionName ? `Baseline ${props.variance.baselineVersionName}` : 'Variance lines'}
              description={`Selected period: ${props.variance.monthLabel}`}
            />
            <div className="mt-5 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.16em] text-stone-500">
                    <th className="px-3 py-2">Subject</th>
                    <th className="px-3 py-2">Planned</th>
                    <th className="px-3 py-2">Actual</th>
                    <th className="px-3 py-2">Variance</th>
                    <th className="px-3 py-2">Variance rate</th>
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
