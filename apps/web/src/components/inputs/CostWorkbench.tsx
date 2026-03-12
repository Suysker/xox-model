import { Coins } from 'lucide-react'
import { useState } from 'react'
import { formatCurrency } from '../../lib/format'
import { getStageCostValue } from '../../lib/costs'
import type { Employee, ModelConfig, MonthlyPlan, MonthlyScenarioResult, TeamMember } from '../../types'
import { Panel, SectionTitle } from '../common/ui'

type LeafCostItem = {
  id: string
  label: string
  value: number
  color: string
}

type CostStackMonth = {
  id: string
  label: string
  totalCost: number
  items: LeafCostItem[]
}

const namedColors: Record<string, string> = {
  提成: '#fb7185',
  成员底薪: '#f59e0b',
  成员路费: '#f97316',
  员工月薪: '#84cc16',
  员工场次: '#10b981',
  排练: '#06b6d4',
  老师: '#3b82f6',
  化妆: '#ec4899',
  推流: '#0ea5e9',
  聚餐: '#f97316',
  团建: '#22c55e',
  VJ: '#a855f7',
  原创: '#d946ef',
  耗材: '#eab308',
}

const fallbackColors = ['#fb7185', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f97316', '#84cc16', '#14b8a6']

function formatCompactCurrency(value: number) {
  const abs = Math.abs(value)

  if (abs >= 10000) {
    return `${(value / 10000).toFixed(abs >= 100000 ? 0 : 1).replace(/\.0$/, '')}w`
  }

  return `${Math.round(value)}`
}

function formatPercent(value: number) {
  const percentage = value * 100

  if (percentage >= 10 || Number.isInteger(percentage)) {
    return `${Math.round(percentage)}%`
  }

  return `${percentage.toFixed(1).replace(/\.0$/, '')}%`
}

function clampToNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function getColor(label: string, index: number) {
  return namedColors[label] ?? fallbackColors[index % fallbackColors.length] ?? '#94a3b8'
}

function getMonthLeafItems(
  month: MonthlyScenarioResult,
  plan: MonthlyPlan | undefined,
  operating: ModelConfig['operating'],
  teamMembers: TeamMember[],
  employees: Employee[],
  stageCostItems: ModelConfig['stageCostItems'],
) {
  const rawItems: Array<{ id: string; label: string; value: number }> = []

  rawItems.push({ id: 'commission', label: '提成', value: month.commissionCost })
  rawItems.push({ id: 'member-base-pay', label: '成员底薪', value: month.basePayCost })
  rawItems.push({ id: 'member-travel', label: '成员路费', value: month.memberTravelCost })
  rawItems.push({ id: 'employee-base-pay', label: '员工月薪', value: month.employeeBasePayCost })
  rawItems.push({ id: 'employee-event', label: '员工场次', value: month.employeeEventCost })

  operating.monthlyFixedCosts.forEach((item) => {
    rawItems.push({ id: `monthly-${item.id}`, label: item.name, value: item.amount })
  })

  operating.perEventCosts.forEach((item) => {
    rawItems.push({ id: `event-${item.id}`, label: item.name, value: item.amount * month.events })
  })

  operating.perUnitCosts.forEach((item) => {
    rawItems.push({ id: `unit-${item.id}`, label: item.name, value: item.amount * month.totalUnitsPerMonth })
  })

  if (plan) {
    rawItems.push({ id: 'rehearsal', label: '排练', value: plan.rehearsalCount * plan.rehearsalCost })
    rawItems.push({ id: 'teacher', label: '老师', value: plan.teacherCount * plan.teacherCost })

    stageCostItems.forEach((item) => {
      const value = getStageCostValue(plan.specialCosts, item.id)
      const amount = clampToNonNegative(value?.amount ?? 0)
      const count = clampToNonNegative(value?.count ?? 0)

      if (item.mode === 'monthly') {
        rawItems.push({ id: `stage-${item.id}`, label: item.name, value: amount })
      } else if (item.mode === 'perEvent') {
        rawItems.push({ id: `stage-${item.id}`, label: item.name, value: amount * count })
      } else {
        rawItems.push({ id: `stage-${item.id}`, label: item.name, value: amount * month.totalUnitsPerMonth })
      }
    })
  }

  return rawItems
    .map((item) => ({ ...item, value: clampToNonNegative(item.value) }))
    .filter((item) => item.value > 0)
}

export function CostWorkbench(props: {
  operating: ModelConfig['operating']
  teamMembers: TeamMember[]
  employees: Employee[]
  stageCostItems: ModelConfig['stageCostItems']
  months: MonthlyPlan[]
  scenarioMonths: MonthlyScenarioResult[]
  selectedMonthId: string
  selectedMonthPlan: MonthlyPlan
  selectedMonthResult: MonthlyScenarioResult
  selectedScenarioLabel: string
  onSelectMonth: (id: string) => void
}) {
  const [hoveredMonthId, setHoveredMonthId] = useState<string | null>(null)
  const planById = new Map(props.months.map((month) => [month.id, month]))
  const stackMonths: CostStackMonth[] = props.scenarioMonths.map((month) => {
    const rawItems = getMonthLeafItems(
      month,
      planById.get(month.monthId),
      props.operating,
      props.teamMembers,
      props.employees,
      props.stageCostItems,
    )

    return {
      id: month.monthId,
      label: month.label,
      totalCost: month.totalCost,
      items: rawItems.map((item, index) => ({
        ...item,
        color: getColor(item.label, index),
      })),
    }
  })

  const legendItems = Array.from(
    new Map(
      stackMonths.flatMap((month) => month.items).map((item) => [item.id, { id: item.id, label: item.label, color: item.color }]),
    ).values(),
  )
  const hoveredMonth = stackMonths.find((month) => month.id === hoveredMonthId) ?? null
  const tooltipMonth = hoveredMonth
  const maxMonthlyCost = Math.max(...stackMonths.map((month) => month.totalCost), 1)
  const axisTicks = [1, 0.66, 0.33].map((ratio) => ({
    key: ratio,
    value: maxMonthlyCost * ratio,
  }))
  const gridClass = stackMonths.length <= 6 ? 'grid-cols-6' : 'grid-cols-12'
  const tooltipIndex = tooltipMonth ? stackMonths.findIndex((month) => month.id === tooltipMonth.id) : -1
  const tooltipHeightRatio = tooltipMonth ? tooltipMonth.totalCost / maxMonthlyCost : 0
  const tooltipAnchorX = tooltipMonth && tooltipIndex >= 0
    ? `${((tooltipIndex + 0.5) / Math.max(stackMonths.length, 1)) * 100}%`
    : '50%'
  const tooltipPlacement = tooltipIndex < stackMonths.length / 2 ? 'right' : 'left'
  const tooltipTransform =
    tooltipPlacement === 'right'
      ? 'translateX(20px)'
      : 'translateX(calc(-100% - 20px))'
  const tooltipTop = `clamp(12px, calc(${(1 - tooltipHeightRatio) * 100}% - 112px), calc(100% - 220px))`

  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="Inputs"
        title="成本概览"
        description="按月看成本结构，点击柱子切换当前查看月份。"
      />

      <section className="mt-5 rounded-[24px] border border-stone-900/10 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">按月成本结构</h3>
            <p className="mt-1 text-sm leading-6 text-stone-600">每个月独立成柱，直接展示化妆、推流、聚餐这类末级成本项。</p>
          </div>
          <div className="rounded-full border border-stone-900/10 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700">
            {props.selectedMonthPlan.label} · 月总成本 {formatCurrency(props.selectedMonthResult.totalCost)}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-[52px_minmax(0,1fr)] gap-4">
          <div className="relative h-[338px]">
            {axisTicks.map((tick) => (
              <div
                key={tick.key}
                className="absolute inset-x-0 flex -translate-y-1/2 items-center justify-end text-xs font-semibold text-stone-400"
                style={{ top: `${(1 - tick.key) * 100}%` }}
              >
                {formatCompactCurrency(tick.value)}
              </div>
            ))}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-end text-xs font-semibold text-stone-400">
              0
            </div>
          </div>

          <div className="relative h-[338px] rounded-[20px] border border-stone-900/10 bg-stone-50/80 px-4 pb-4 pt-8">
            {axisTicks.map((tick) => (
              <div
                key={`line-${tick.key}`}
                className="absolute inset-x-4 border-t border-dashed border-stone-900/10"
                style={{ top: `calc(${(1 - tick.key) * 100}% + 10px)` }}
              />
            ))}
            <div className="absolute inset-x-4 bottom-4 border-t border-stone-900/10" />

            {tooltipMonth && tooltipIndex >= 0 ? (
              <div
                className="pointer-events-none absolute z-20 w-[248px] rounded-[18px] border border-stone-900/10 bg-white/96 p-3 shadow-[0_18px_40px_rgba(28,25,23,0.12)]"
                style={{ left: tooltipAnchorX, top: tooltipTop, transform: tooltipTransform }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">{tooltipMonth.label}</p>
                    <p className="mt-1 text-lg font-bold text-stone-950">{formatCurrency(tooltipMonth.totalCost)}</p>
                  </div>
                  <span className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                    月总成本
                  </span>
                </div>
                <div className="mt-3 grid gap-1.5">
                  {tooltipMonth.items
                    .slice()
                    .sort((left, right) => right.value - left.value)
                    .map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="truncate text-stone-600">{item.label}</span>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-stone-900">{formatCurrency(item.value)}</div>
                          <div className="text-[11px] font-medium text-stone-500">
                            占比 {formatPercent(item.value / Math.max(tooltipMonth.totalCost, 1))}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}

            <div className={`relative z-10 grid h-full gap-2 ${gridClass}`}>
              {stackMonths.map((month) => {
                const heightRatio = month.totalCost / maxMonthlyCost
                const isSelected = month.id === props.selectedMonthId

                return (
                  <button
                    key={month.id}
                    type="button"
                    onClick={() => props.onSelectMonth(month.id)}
                    onMouseEnter={() => setHoveredMonthId(month.id)}
                    onMouseLeave={() => setHoveredMonthId((current) => (current === month.id ? null : current))}
                    onFocus={() => setHoveredMonthId(month.id)}
                    onBlur={() => setHoveredMonthId((current) => (current === month.id ? null : current))}
                    className="flex h-full min-w-0 flex-col items-center justify-end"
                    aria-label={`${month.label} 月总成本 ${formatCurrency(month.totalCost)}`}
                  >
                    <div className="flex h-full w-full max-w-[86px] flex-col justify-end gap-2 pt-5">
                      <div className="relative flex h-[244px] items-end overflow-visible">
                        <div
                          className={`pointer-events-none absolute left-1/2 z-10 whitespace-nowrap text-[11px] font-semibold ${
                            isSelected ? 'text-stone-950' : 'text-stone-500'
                          }`}
                          style={{
                            bottom: `${Math.max(heightRatio * 100, 8)}%`,
                            transform: 'translate(-50%, calc(-100% - 2px))',
                          }}
                        >
                          {formatCompactCurrency(month.totalCost)}
                        </div>
                        <div
                          className={`w-full overflow-hidden rounded-t-[16px] border transition ${
                            isSelected
                              ? 'border-stone-950 shadow-[0_10px_24px_rgba(28,25,23,0.14)]'
                              : 'border-stone-900/10 hover:border-stone-400'
                          }`}
                          style={{ height: `${Math.max(heightRatio * 100, 8)}%` }}
                        >
                          <div className="flex h-full flex-col justify-end">
                            {month.items.map((item) => (
                              <div
                                key={`${month.id}-${item.id}`}
                                className="min-h-[5px]"
                                style={{
                                  height: `${(item.value / month.totalCost) * 100}%`,
                                  backgroundColor: item.color,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className={`text-center text-sm font-semibold ${isSelected ? 'text-stone-950' : 'text-stone-500'}`}>
                        {month.label}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {legendItems.map((item) => (
            <div
              key={item.id}
              className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </div>
          ))}
        </div>
      </section>
    </Panel>
  )
}
