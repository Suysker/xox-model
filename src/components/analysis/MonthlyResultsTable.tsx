import { Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MonthlyScenarioResult } from '../../types'
import { cx, formatCurrency, formatDecimal, formatPaybackMonths } from '../../lib/format'
import { Panel, SectionTitle, StatCard } from '../common/ui'

export function MonthlyResultsTable(props: {
  months: MonthlyScenarioResult[]
  selectedMonthId: string
  onSelectMonth: (id: string) => void
}) {
  const profitableMonths = props.months.filter((month) => month.monthlyProfit >= 0).length
  const paybackMonthIndex = props.months.findIndex((month) => month.hasPaidBack)
  const lastCash = props.months.at(-1)?.cumulativeCash ?? 0
  const showExtraRevenue = props.months.some((month) => month.extraChannelRevenue > 0)

  return (
    <Panel>
      <SectionTitle
        icon={Table2}
        eyebrow="Dashboard"
        title="月度经营结果表"
        description="按月份展开营收、固定成本、每场成本、专项、耗材和累计现金。"
      />

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <StatCard label="盈利月份" value={`${profitableMonths} / ${props.months.length}`} />
        <StatCard
          label="回本周期"
          value={formatPaybackMonths(paybackMonthIndex >= 0 ? paybackMonthIndex + 1 : null)}
        />
        <StatCard label="期末累计现金" value={formatCurrency(lastCash)} />
      </div>

      <div className="mt-5 rounded-[24px] border border-stone-900/10">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell>月份</HeaderCell>
              <HeaderCell align="right">场次</HeaderCell>
              <HeaderCell align="right">单场张数</HeaderCell>
              <HeaderCell align="right">营收</HeaderCell>
              {showExtraRevenue ? <HeaderCell align="right">额外渠道</HeaderCell> : null}
              <HeaderCell align="right">提成</HeaderCell>
              <HeaderCell align="right">月固定</HeaderCell>
              <HeaderCell align="right">每场</HeaderCell>
              <HeaderCell align="right">专项</HeaderCell>
              <HeaderCell align="right">耗材</HeaderCell>
              <HeaderCell align="right">月利润</HeaderCell>
              <HeaderCell align="right">累计现金</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.months.map((month) => {
              const active = month.monthId === props.selectedMonthId
              const monthlyFixedCost =
                month.basePayCost +
                month.employeeBasePayCost +
                month.monthlyOperatingCost +
                month.rehearsalCost +
                month.teacherCost +
                month.extraFixedCost

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
                  <BodyCell align="right">{formatCurrency(month.grossSales)}</BodyCell>
                  {showExtraRevenue ? <BodyCell align="right">{formatCurrency(month.extraChannelRevenue)}</BodyCell> : null}
                  <BodyCell align="right">{formatCurrency(month.commissionCost)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(monthlyFixedCost)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.perEventCostTotal)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.specialProjectCost)}</BodyCell>
                  <BodyCell align="right">{formatCurrency(month.unitLinkedCostTotal)}</BodyCell>
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
        'px-4 py-3 text-center text-xs font-semibold uppercase tracking-[0.16em]',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
        props.align === 'left' && 'text-left',
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
