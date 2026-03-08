import { Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MonthlyScenarioResult } from '../../types'
import { cx, formatCompactNumber, formatCurrency, formatDecimal } from '../../lib/format'
import { Panel, SectionTitle, StatCard } from '../common/ui'

export function MonthlyResultsTable(props: {
  months: MonthlyScenarioResult[]
  selectedMonthId: string
  onSelectMonth: (id: string) => void
}) {
  const profitableMonths = props.months.filter((month) => month.monthlyProfit >= 0).length
  const paybackMonth = props.months.find((month) => month.hasPaidBack)?.label ?? '未回本'
  const lastCash = props.months.at(-1)?.cumulativeCash ?? 0

  return (
    <Panel>
      <SectionTitle
        icon={Table2}
        eyebrow="Dashboard"
        title="月度经营结果表"
        description="按月份展开收入、成本、利润和累计现金。点击任意一行，可以联动切到成员拆解。"
      />

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <StatCard label="盈利月份" value={`${profitableMonths} / ${props.months.length}`} />
        <StatCard label="回本月份" value={paybackMonth} />
        <StatCard label="期末累计现金" value={formatCurrency(lastCash)} />
      </div>

      <div className="mt-5 overflow-x-auto rounded-[24px] border border-stone-900/10">
        <table className="min-w-[1160px] w-full border-collapse text-sm">
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell>月份</HeaderCell>
              <HeaderCell align="right">场次</HeaderCell>
              <HeaderCell align="right">单场张数</HeaderCell>
              <HeaderCell align="right">月总张数</HeaderCell>
              <HeaderCell align="right">营收</HeaderCell>
              <HeaderCell align="right">提成</HeaderCell>
              <HeaderCell align="right">固定成本</HeaderCell>
              <HeaderCell align="right">场次成本</HeaderCell>
              <HeaderCell align="right">耗材</HeaderCell>
              <HeaderCell align="right">总成本</HeaderCell>
              <HeaderCell align="right">月利润</HeaderCell>
              <HeaderCell align="right">累计现金</HeaderCell>
              <HeaderCell align="center">状态</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.months.map((month) => {
              const active = month.monthId === props.selectedMonthId

              return (
                <tr
                  key={month.monthId}
                  className={cx(
                    'cursor-pointer border-b border-stone-900/10 transition last:border-none hover:bg-stone-50',
                    active && 'bg-amber-50/90',
                  )}
                  onClick={() => props.onSelectMonth(month.monthId)}
                >
                  <BodyCell className="font-semibold text-stone-950">{month.label}</BodyCell>
                  <BodyCell align="right">{month.events}</BodyCell>
                  <BodyCell align="right">{formatDecimal(month.totalUnitsPerEvent)}</BodyCell>
                  <BodyCell align="right">{formatCompactNumber(month.totalUnitsPerMonth)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.grossSales)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.commissionCost)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.fixedCostTotal)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.showLinkedCostTotal)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.unitLinkedCostTotal)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.totalCost)}</BodyCell>
                  <BodyCell
                    align="right"
                    className={month.monthlyProfit >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}
                  >
                    {formatCurrency(month.monthlyProfit)}
                  </BodyCell>
                  <BodyCell
                    align="right"
                    className={month.cumulativeCash >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-stone-700'}
                  >
                    {formatCurrency(month.cumulativeCash)}
                  </BodyCell>
                  <BodyCell align="center">
                    <span
                      className={
                        month.hasPaidBack
                          ? 'rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-700'
                          : active
                            ? 'rounded-full border border-amber-200 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800'
                            : 'rounded-full border border-stone-900/10 bg-white px-2 py-1 text-[11px] font-semibold text-stone-500'
                      }
                    >
                      {month.hasPaidBack ? '已回本' : active ? '当前查看' : '未回本'}
                    </span>
                  </BodyCell>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function HeaderCell(props: {
  children: string
  align?: 'left' | 'right' | 'center' | undefined
}) {
  return (
    <th
      className={cx(
        'px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em]',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
      )}
    >
      {props.children}
    </th>
  )
}

function BodyCell(props: {
  children: ReactNode
  align?: 'left' | 'right' | 'center' | undefined
  className?: string | undefined
}) {
  return (
    <td
      className={cx(
        'px-4 py-3 align-top text-stone-700',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
        props.className,
      )}
    >
      {props.children}
    </td>
  )
}
