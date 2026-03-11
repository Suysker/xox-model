import { Coins, Plus, Trash2 } from 'lucide-react'
import { monthLabelOptions } from '../../lib/defaults'
import { formatCurrency, formatPercent } from '../../lib/format'
import type { PlanningConfig, Shareholder } from '../../types'
import { CompactNumberInput, HeaderCell, Panel, SectionTitle } from '../common/ui'

export function OperatingWorkbench(props: {
  shareholders: Shareholder[]
  planning: PlanningConfig
  onPlanningChange: (key: keyof PlanningConfig, value: number) => void
  onShareholderAdd: () => void
  onShareholderRemove: (id: string) => void
  onShareholderNameChange: (id: string, value: string) => void
  onShareholderInvestmentChange: (id: string, value: number) => void
  onShareholderDividendChange: (id: string, value: number) => void
}) {
  const totalInvestment = props.shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)
  const totalDividendRate = props.shareholders.reduce((sum, shareholder) => sum + shareholder.dividendRate, 0)

  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="Inputs"
        title="股东投资"
        description="先定经营起点和周期，再录股东资金来源与分红结构。"
        aside={
          <button
            type="button"
            onClick={props.onShareholderAdd}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
          >
            <Plus className="h-4 w-4" />
            添加股东
          </button>
        }
      />

      <div className="mt-5 grid gap-3 xl:grid-cols-[190px_170px_repeat(3,minmax(0,1fr))]">
        <label className="grid gap-2 rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">经营开始月份</span>
          <select
            className="h-10 rounded-xl border border-stone-900/10 bg-white px-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500"
            value={props.planning.startMonth}
            onChange={(event) => props.onPlanningChange('startMonth', Number(event.target.value))}
          >
            {monthLabelOptions.map((label, index) => (
              <option key={label} value={index + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-2 rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">规划月数</span>
          <CompactNumberInput
            value={props.planning.horizonMonths}
            min={1}
            max={24}
            step={1}
            size="sm"
            align="center"
            suffix="月"
            onChange={(value) => props.onPlanningChange('horizonMonths', value)}
          />
        </label>

        <SummaryPill label="总投资" value={formatCurrency(totalInvestment)} />
        <SummaryPill label="股东人数" value={`${props.shareholders.length} 人`} />
        <SummaryPill
          label="分红比例合计"
          value={formatPercent(totalDividendRate)}
          tone={Math.abs(totalDividendRate - 1) <= 0.001 ? 'ok' : 'warn'}
        />
      </div>

      <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-white">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[26%]" />
            <col className="w-[26%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell align="center">股东</HeaderCell>
              <HeaderCell align="center">投资额</HeaderCell>
              <HeaderCell align="center">分红比例</HeaderCell>
              <HeaderCell align="center">删除</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.shareholders.map((shareholder) => (
              <tr key={shareholder.id} className="border-b border-stone-900/10 last:border-none">
                <td className="px-3 py-2.5 text-center">
                  <input
                    className="h-9 w-full rounded-lg border border-stone-900/10 bg-stone-50 px-3 text-center text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={shareholder.name}
                    onChange={(event) => props.onShareholderNameChange(shareholder.id, event.target.value)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={shareholder.investmentAmount}
                    min={0}
                    step={1000}
                    size="sm"
                    align="center"
                    onChange={(value) => props.onShareholderInvestmentChange(shareholder.id, value)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={shareholder.dividendRate * 100}
                    min={0}
                    max={100}
                    step={0.1}
                    size="sm"
                    align="center"
                    onChange={(value) => props.onShareholderDividendChange(shareholder.id, value / 100)}
                  />
                </td>
                <td className="px-2 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => props.onShareholderRemove(shareholder.id)}
                    disabled={props.shareholders.length === 1}
                    aria-label={`删除 ${shareholder.name}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SummaryPill(props: {
  label: string
  value: string
  tone?: 'default' | 'ok' | 'warn' | undefined
}) {
  return (
    <div
      className={
        props.tone === 'ok'
          ? 'rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3'
          : props.tone === 'warn'
            ? 'rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3'
            : 'rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3'
      }
    >
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className="mt-1.5 text-lg font-bold text-stone-950">{props.value}</p>
    </div>
  )
}
