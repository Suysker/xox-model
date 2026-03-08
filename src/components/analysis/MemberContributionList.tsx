import { Users2 } from 'lucide-react'
import type { MonthlyScenarioResult } from '../../types'
import { cx, formatCompactNumber, formatCurrency, formatDecimal } from '../../lib/format'
import { Panel, SectionTitle, StatCard } from '../common/ui'

export function MemberContributionList(props: {
  months: MonthlyScenarioResult[]
  selectedMonthId: string
  onSelectMonth: (id: string) => void
}) {
  const selectedMonth = props.months.find((month) => month.monthId === props.selectedMonthId) ?? props.months[0]

  if (!selectedMonth) {
    return null
  }

  const members = [...selectedMonth.members].sort(
    (left, right) => right.companyRevenueAfterCommission - left.companyRevenueAfterCommission,
  )
  const maxGrossSales = Math.max(...members.map((member) => member.grossSales), 1)

  return (
    <Panel>
      <SectionTitle
        icon={Users2}
        eyebrow="Dashboard"
        title="成员贡献拆解"
        description="按月份查看每个成员的单场张数、月总张数、提成成本和扣提成后的公司留存。"
      />

      <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
        {props.months.map((month) => (
          <button
            key={month.monthId}
            type="button"
            onClick={() => props.onSelectMonth(month.monthId)}
            className={
              month.monthId === selectedMonth.monthId
                ? 'rounded-full border border-amber-300 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-800'
                : 'rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-50'
            }
          >
            {month.label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <StatCard label="当前月份" value={selectedMonth.label} />
        <StatCard label="月总张数" value={`${formatCompactNumber(selectedMonth.totalUnitsPerMonth)} 张`} />
        <StatCard label="月营收" value={formatCurrency(selectedMonth.grossSales)} />
        <StatCard label="扣提成后留存" value={formatCurrency(selectedMonth.grossSales - selectedMonth.commissionCost)} />
      </div>

      <div className="mt-5 grid gap-3">
        {members.map((member) => {
          const width = `${Math.max(8, (member.grossSales / maxGrossSales) * 100)}%`

          return (
            <article
              key={member.memberId}
              className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4"
            >
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="xl:min-w-[240px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold text-stone-950">{member.name}</p>
                    <span
                      className={
                        member.employmentType === 'salary'
                          ? 'rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800'
                          : 'rounded-full border border-sky-200 bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-800'
                      }
                    >
                      {member.employmentType === 'salary' ? '底薪成员' : '兼职成员'}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-stone-500">
                    单场 {formatDecimal(member.unitsPerEvent)} 张 · 月总 {formatCompactNumber(member.monthlyUnits)} 张
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 xl:min-w-[620px]">
                  <MetricCard label="营收" value={formatCurrency(member.grossSales)} />
                  <MetricCard label="提成成本" value={formatCurrency(member.commissionCost)} />
                  <MetricCard label="成员底薪" value={formatCurrency(member.basePayCost)} />
                  <MetricCard label="扣提成后留存" value={formatCurrency(member.companyRevenueAfterCommission)} />
                </div>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-stone-500">
                  <span>成员营收权重</span>
                  <span>{formatCurrency(member.grossSales)}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className={cx(
                      'h-full rounded-full',
                      member.employmentType === 'salary' ? 'bg-amber-400' : 'bg-emerald-400',
                    )}
                    style={{ width }}
                  />
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </Panel>
  )
}

function MetricCard(props: {
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
