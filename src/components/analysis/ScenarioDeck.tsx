import { formatCurrency, formatPercent } from '../../lib/format'
import type { ScenarioKey, ScenarioResult } from '../../types'
import { cx } from '../../lib/format'

const scenarioOrder: ScenarioKey[] = ['pessimistic', 'base', 'optimistic']

const scenarioMeta: Record<
  ScenarioKey,
  {
    labelClass: string
    cardClass: string
  }
> = {
  pessimistic: {
    labelClass: 'border-rose-200 bg-rose-100 text-rose-700',
    cardClass: 'border-rose-200 bg-rose-50/80',
  },
  base: {
    labelClass: 'border-amber-200 bg-amber-100 text-amber-800',
    cardClass: 'border-amber-200 bg-amber-50/80',
  },
  optimistic: {
    labelClass: 'border-emerald-200 bg-emerald-100 text-emerald-700',
    cardClass: 'border-emerald-200 bg-emerald-50/80',
  },
}

function formatPayback(scenario: ScenarioResult) {
  return scenario.paybackMonthLabel ? `${scenario.paybackMonthLabel} 回本` : '周期内未回本'
}

export function ScenarioDeck(props: {
  scenarios: ScenarioResult[]
  selectedKey: ScenarioKey
  onSelect: (key: ScenarioKey) => void
}) {
  const lookup = new Map(props.scenarios.map((scenario) => [scenario.key, scenario]))

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {scenarioOrder.map((key) => {
        const scenario = lookup.get(key)

        if (!scenario) {
          return null
        }

        return (
          <button
            key={key}
            type="button"
            onClick={() => props.onSelect(key)}
            className={cx(
              'rounded-[26px] border p-5 text-left transition',
              scenarioMeta[key].cardClass,
              props.selectedKey === key
                ? 'ring-2 ring-stone-950/15'
                : 'hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(70,52,17,0.08)]',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-semibold',
                  scenarioMeta[key].labelClass,
                )}
              >
                {scenario.label}
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                {props.selectedKey === key ? '当前查看' : '点击查看'}
              </span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <KeyValue label="总营收" value={formatCurrency(scenario.grossSales)} />
              <KeyValue label="总成本" value={formatCurrency(scenario.totalCost)} />
              <KeyValue label="总利润" value={formatCurrency(scenario.totalProfit)} />
              <KeyValue label="期末现金" value={formatCurrency(scenario.netCashAfterInvestment)} />
              <KeyValue label="回本判断" value={formatPayback(scenario)} />
              <KeyValue label="ROI" value={formatPercent(scenario.roi)} />
            </div>
          </button>
        )
      })}
    </div>
  )
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="rounded-[20px] border border-stone-900/10 bg-white/70 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className="mt-2 text-base font-semibold text-stone-950">{props.value}</p>
    </div>
  )
}
