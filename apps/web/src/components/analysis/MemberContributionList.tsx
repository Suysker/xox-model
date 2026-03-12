import { Users2 } from 'lucide-react'
import type { MonthlyScenarioResult } from '../../types'
import { cx, formatCompactNumber, formatCurrency, formatDecimal } from '../../lib/format'
import { BodyCell, HeaderCell, Panel, SectionTitle, StatCard } from '../common/ui'

const palette = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

export function MemberContributionList(props: {
  months: MonthlyScenarioResult[]
  selectedMonthId: string
  onSelectMonth: (id: string) => void
}) {
  const selectedMonth = props.months.find((month) => month.monthId === props.selectedMonthId) ?? props.months[0]

  if (!selectedMonth) {
    return null
  }

  const selectedMonthIndex = Math.max(
    0,
    props.months.findIndex((month) => month.monthId === selectedMonth.monthId),
  )
  const monthLabelStride = Math.max(1, Math.ceil(props.months.length / 6))
  const visibleMonths = props.months.filter(
    (_, index) => index === 0 || index === props.months.length - 1 || index % monthLabelStride === 0,
  )
  const members = [...selectedMonth.members].sort(
    (left, right) => right.companyNetContribution - left.companyNetContribution,
  )
  const memberColorMap = new Map(members.map((member, index) => [member.memberId, palette[index % palette.length]]))
  const trendMembers = members.slice(0, 5).map((member, index) => ({
    memberId: member.memberId,
    name: member.name,
    color: memberColorMap.get(member.memberId) ?? palette[index % palette.length] ?? '#f59e0b',
    values: props.months.map((month) => month.members.find((item) => item.memberId === member.memberId)?.grossSales ?? 0),
  }))
  const totalContribution = members.reduce((sum, member) => sum + member.companyNetContribution, 0)

  return (
    <Panel>
      <SectionTitle icon={Users2} eyebrow="Dashboard" title="成员贡献拆解" />

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <StatCard label="当前月份" value={selectedMonth.label} />
        <StatCard label="月总张数" value={`${formatCompactNumber(selectedMonth.totalUnitsPerMonth)} 张`} />
        <StatCard label="成员营收" value={formatCurrency(selectedMonth.memberGrossSales)} />
        <StatCard label="成员净贡献" value={formatCurrency(totalContribution)} />
      </div>

      <section className="mt-5 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
        <div className="grid gap-4 xl:grid-cols-2 xl:[&>section]:h-full">
          <section className="rounded-[20px] border border-stone-900/10 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-stone-950">成员营收趋势</h3>
              <span className="rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-600">
                Top 5
              </span>
            </div>
            <div className="mt-4">
              <MemberTrendChart
                months={props.months}
                lines={trendMembers}
                selectedMonthId={selectedMonth.monthId}
                onSelectMonth={props.onSelectMonth}
              />
            </div>
          </section>

          <section className="rounded-[20px] border border-stone-900/10 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-stone-950">{selectedMonth.label} 成员营收占比</h3>
              <span className="rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-600">
                环图
              </span>
            </div>
            <div className="mt-4">
              <MemberShareDonut
                members={members.map((member) => ({
                  name: member.name,
                  value: member.grossSales,
                  color: memberColorMap.get(member.memberId) ?? '#f59e0b',
                }))}
              />
            </div>
          </section>
        </div>
      </section>

      <section className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10 bg-stone-50/80">
        <div className="border-b border-stone-900/10 px-4 py-4">
          <h3 className="text-lg font-semibold text-stone-950">{selectedMonth.label} 成员明细</h3>

          <div className="mt-4">
            <MonthRail
              months={props.months}
              visibleMonths={visibleMonths}
              selectedMonthId={selectedMonth.monthId}
              selectedMonthIndex={selectedMonthIndex}
              onSelectMonth={props.onSelectMonth}
            />
          </div>
        </div>

        <div className="px-4 py-4">
          <table className="w-full table-fixed overflow-hidden rounded-[20px] border border-stone-900/10 bg-white">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[10%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[12%]" />
              <col className="w-[11%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead className="bg-stone-50 text-stone-600">
              <tr>
                <HeaderCell align="center">成员</HeaderCell>
                <HeaderCell align="center">类型</HeaderCell>
                <HeaderCell align="center">单场张</HeaderCell>
                <HeaderCell align="center">月总张</HeaderCell>
                <HeaderCell align="center">营收</HeaderCell>
                <HeaderCell align="center">提成</HeaderCell>
                <HeaderCell align="center">底薪</HeaderCell>
                <HeaderCell align="center">路费</HeaderCell>
                <HeaderCell align="center">净贡献</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {members.map((member, index) => {
                const borderClass = index !== members.length - 1 ? 'border-b border-stone-900/10' : ''

                return (
                  <tr key={member.memberId}>
                    <BodyCell align="center" className={borderClass}>
                      <div className="flex items-center justify-center gap-2 py-1">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: memberColorMap.get(member.memberId) ?? palette[index % palette.length] }}
                        />
                        <span className="text-sm font-semibold text-stone-950">{member.name}</span>
                      </div>
                    </BodyCell>
                    <BodyCell align="center" className={borderClass}>
                      <span
                        className={
                          member.employmentType === 'salary'
                            ? 'rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700'
                            : 'rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700'
                        }
                      >
                        {member.employmentType === 'salary' ? '底薪' : '兼职'}
                      </span>
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatDecimal(member.unitsPerEvent)}
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatCompactNumber(member.monthlyUnits)}
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatCurrency(member.grossSales)}
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatCurrency(member.commissionCost)}
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatCurrency(member.basePayCost)}
                    </BodyCell>
                    <BodyCell align="center" className={cx(borderClass, 'text-sm font-semibold text-stone-900')}>
                      {formatCurrency(member.travelCost)}
                    </BodyCell>
                    <BodyCell
                      align="center"
                      className={cx(borderClass, 'bg-emerald-50/70 text-sm font-bold text-emerald-800')}
                    >
                      {formatCurrency(member.companyNetContribution)}
                    </BodyCell>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </Panel>
  )
}

function MonthRail(props: {
  months: MonthlyScenarioResult[]
  visibleMonths: MonthlyScenarioResult[]
  selectedMonthId: string
  selectedMonthIndex: number
  onSelectMonth: (id: string) => void
}) {
  return (
    <div className="rounded-[18px] border border-stone-900/10 bg-white px-3 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">月份</p>

      <input
        type="range"
        min={0}
        max={Math.max(0, props.months.length - 1)}
        step={1}
        value={props.selectedMonthIndex}
        onChange={(event) => {
          const nextMonth = props.months[Number(event.target.value)]
          if (nextMonth) {
            props.onSelectMonth(nextMonth.monthId)
          }
        }}
        className="mt-3 h-2 w-full cursor-pointer accent-amber-500"
      />

      <div
        className="mt-2 grid gap-2 text-[11px] font-medium text-stone-500"
        style={{ gridTemplateColumns: `repeat(${props.visibleMonths.length}, minmax(0, 1fr))` }}
      >
        {props.visibleMonths.map((month) => (
          <span
            key={month.monthId}
            className={cx(
              'truncate text-center transition',
              month.monthId === props.selectedMonthId && 'font-semibold text-amber-700',
            )}
          >
            {month.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function MemberTrendChart(props: {
  months: MonthlyScenarioResult[]
  lines: Array<{
    memberId: string
    name: string
    color: string
    values: number[]
  }>
  selectedMonthId: string
  onSelectMonth: (id: string) => void
}) {
  const width = 760
  const height = 220
  const padding = { top: 18, right: 18, bottom: 38, left: 60 }
  const allValues = props.lines.flatMap((line) => line.values)
  const rawMinValue = Math.min(...allValues)
  const rawMaxValue = Math.max(...allValues)
  const valueSpread = Math.max(rawMaxValue - rawMinValue, Math.max(rawMaxValue, 1) * 0.12)
  const yMin = Math.max(0, rawMinValue - valueSpread * 0.28)
  const yMax = rawMaxValue + valueSpread * 0.18
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xStep = props.months.length > 1 ? plotWidth / (props.months.length - 1) : 0
  const selectedMonthIndex = Math.max(
    0,
    props.months.findIndex((month) => month.monthId === props.selectedMonthId),
  )

  function getX(index: number) {
    return padding.left + xStep * index
  }

  function getY(value: number) {
    return padding.top + plotHeight - ((value - yMin) / Math.max(yMax - yMin, 1)) * plotHeight
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-[220px] w-full" role="img" aria-label="成员营收折线图">
        {props.months.map((month, index) => {
          const center = getX(index)
          const previousCenter = index === 0 ? padding.left : getX(index - 1)
          const nextCenter = index === props.months.length - 1 ? width - padding.right : getX(index + 1)
          const zoneStart = index === 0 ? padding.left : (previousCenter + center) / 2
          const zoneEnd = index === props.months.length - 1 ? width - padding.right : (center + nextCenter) / 2

          return (
            <g key={`zone-${month.monthId}`}>
              {index === selectedMonthIndex ? (
                <rect
                  x={zoneStart}
                  y={padding.top}
                  width={zoneEnd - zoneStart}
                  height={plotHeight}
                  rx="12"
                  fill="rgba(245, 158, 11, 0.08)"
                />
              ) : null}
              <rect
                x={zoneStart}
                y={padding.top}
                width={zoneEnd - zoneStart}
                height={plotHeight + padding.bottom}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => props.onSelectMonth(month.monthId)}
              />
            </g>
          )
        })}

        {Array.from({ length: 4 }, (_, index) => {
          const value = yMin + ((yMax - yMin) / 3) * index
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
              <text x={padding.left - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#78716c">
                {formatCompactNumber(value)}
              </text>
            </g>
          )
        })}

        {props.months.map((month, index) => (
          <g key={month.monthId}>
            <text
              x={getX(index)}
              y={height - 10}
              textAnchor="middle"
              fontSize="11"
              fill={month.monthId === props.selectedMonthId ? '#b45309' : '#57534e'}
              fontWeight={month.monthId === props.selectedMonthId ? '700' : '500'}
              style={{ cursor: 'pointer' }}
              onClick={() => props.onSelectMonth(month.monthId)}
            >
              {month.label}
            </text>
          </g>
        ))}

        {props.lines.map((line) => (
          <g key={line.memberId}>
            <path
              d={line.values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value)}`).join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth="3"
              strokeLinecap="round"
            />
            {line.values.map((value, index) => (
              <circle
                key={`${line.memberId}-${index}`}
                cx={getX(index)}
                cy={getY(value)}
                r={index === selectedMonthIndex ? 5.5 : 4.5}
                fill={line.color}
                stroke={index === selectedMonthIndex ? 'white' : 'none'}
                strokeWidth={index === selectedMonthIndex ? 2 : 0}
                style={{ cursor: 'pointer' }}
                onClick={() => props.onSelectMonth(props.months[index]?.monthId ?? props.selectedMonthId)}
              />
            ))}
            {line.values.map((value, index) =>
              index === selectedMonthIndex ? (
                <text
                  key={`${line.memberId}-${index}-label`}
                  x={getX(index)}
                  y={getY(value) - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="700"
                  fill={line.color}
                >
                  {formatCompactNumber(value)}
                </text>
              ) : null,
            )}
          </g>
        ))}
      </svg>

      <div className="mt-3 flex flex-wrap gap-2">
        {props.lines.map((line) => (
          <span
            key={line.memberId}
            className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-600"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: line.color }} />
            {line.name}
          </span>
        ))}
      </div>
    </div>
  )
}

function MemberShareDonut(props: {
  members: Array<{
    name: string
    value: number
    color: string
  }>
}) {
  const width = 220
  const height = 220
  const centerX = 110
  const centerY = 110
  const radius = 58
  const strokeWidth = 22
  const total = props.members.reduce((sum, member) => sum + member.value, 0) || 1

  let currentAngle = -Math.PI / 2

  return (
    <div className="grid gap-4 md:grid-cols-[190px_minmax(0,1fr)] md:items-center">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto block h-[188px] w-[188px]"
        role="img"
        aria-label="成员营收占比环图"
      >
        {props.members.map((member) => {
          const angle = (member.value / total) * Math.PI * 2
          const startX = centerX + radius * Math.cos(currentAngle)
          const startY = centerY + radius * Math.sin(currentAngle)
          const endAngle = currentAngle + angle
          const endX = centerX + radius * Math.cos(endAngle)
          const endY = centerY + radius * Math.sin(endAngle)
          const largeArc = angle > Math.PI ? 1 : 0
          const path = `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`

          currentAngle = endAngle

          return (
            <path
              key={member.name}
              d={path}
              fill="none"
              stroke={member.color}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
            />
          )
        })}
        <circle cx={centerX} cy={centerY} r="36" fill="white" />
        <text x={centerX} y={centerY - 5} textAnchor="middle" fontSize="12" fill="#78716c">
          月营收
        </text>
        <text x={centerX} y={centerY + 18} textAnchor="middle" fontSize="15" fontWeight="700" fill="#111827">
          {formatCompactNumber(total)}
        </text>
      </svg>

      <div className="grid gap-2 sm:grid-cols-2">
        {props.members.map((member) => (
          <div
            key={member.name}
            className="flex items-center justify-between gap-3 rounded-[16px] border border-stone-900/10 bg-stone-50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: member.color }} />
              <span className="text-sm font-medium text-stone-800">{member.name}</span>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-stone-950">{formatCurrency(member.value)}</p>
              <p className="text-xs text-stone-500">{Math.round((member.value / total) * 100)}%</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
