import { CalendarRange, RefreshCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cx, formatDecimal } from '../../lib/format'
import type { MonthlyPlan, MonthlyPlanTemplate } from '../../types'
import { BodyCell, CompactNumberInput, HeaderCell, Panel, SectionTitle } from '../common/ui'

type RevenueNumberKey = 'events' | 'salesMultiplier' | 'onlineSalesFactor'
type RhythmSeriesKey = 'events' | 'salesMultiplier'
type DragTarget = { monthId: string; series: RhythmSeriesKey } | null

const rhythmChartFrame = {
  width: 920,
  height: 320,
  padding: { top: 28, right: 74, bottom: 54, left: 74 },
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function TimelineEditor(props: {
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  onTemplateNumberChange: (key: RevenueNumberKey, value: number) => void
  onNumberChange: (id: string, key: RevenueNumberKey, value: number) => void
  onApplyTemplateToAll: () => void
  onResetMonthFromTemplate: (id: string) => void
}) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [dragTarget, setDragTarget] = useState<DragTarget>(null)
  const eventMax = Math.max(props.template.events + 4, ...props.months.map((month) => month.events + 2), 6)
  const salesMax = Number(
    Math.max(
      props.template.salesMultiplier + 0.5,
      ...props.months.map((month) => month.salesMultiplier + 0.2),
      1.6,
    ).toFixed(2),
  )

  function updateDraggedValue(target: DragTarget, clientY: number) {
    if (!target || !chartRef.current) {
      return
    }

    const rect = chartRef.current.getBoundingClientRect()
    const relativeY = clamp(clientY - rect.top, 0, rect.height)
    const scaledY = (relativeY / rect.height) * rhythmChartFrame.height
    const plotTop = rhythmChartFrame.padding.top
    const plotHeight = rhythmChartFrame.height - rhythmChartFrame.padding.top - rhythmChartFrame.padding.bottom
    const ratio = 1 - clamp((scaledY - plotTop) / plotHeight, 0, 1)

    if (target.series === 'events') {
      props.onNumberChange(target.monthId, 'events', Math.round(clamp(ratio * eventMax, 0, eventMax)))
      return
    }

    props.onNumberChange(
      target.monthId,
      'salesMultiplier',
      Number(clamp(ratio * salesMax, 0, salesMax).toFixed(2)),
    )
  }

  useEffect(() => {
    if (!dragTarget) {
      return undefined
    }

    function handlePointerMove(event: PointerEvent) {
      updateDraggedValue(dragTarget, event.clientY)
    }

    function handlePointerUp() {
      setDragTarget(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [dragTarget, eventMax, salesMax, props.onNumberChange])

  return (
    <Panel>
      <SectionTitle
        icon={CalendarRange}
        eyebrow="Inputs"
        title="收入引擎"
      />

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <LegendPill color="bg-amber-400" label="场次" />
        <LegendPill color="bg-emerald-500" label="销售系数" />
        <button
          type="button"
          onClick={props.onApplyTemplateToAll}
          className="inline-flex items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
        >
          同步默认
        </button>
      </div>

      <div
        ref={chartRef}
        className="mt-4 rounded-[22px] border border-stone-900/10 bg-[linear-gradient(180deg,_rgba(255,251,235,0.72),_rgba(255,255,255,0.98))] p-3 md:p-4"
      >
        <RhythmChart
          months={props.months}
          templateEvents={props.template.events}
          templateSalesMultiplier={props.template.salesMultiplier}
          eventMax={eventMax}
          salesMax={salesMax}
          dragTarget={dragTarget}
          onStartDrag={(target, clientY) => {
            setDragTarget(target)
            updateDraggedValue(target, clientY)
          }}
        />
      </div>

      <div className="mt-4 rounded-[20px] border border-stone-900/10 bg-white">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[22%]" />
            <col className="w-[24%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell align="center">月份</HeaderCell>
              <HeaderCell align="center">场次</HeaderCell>
              <HeaderCell align="center">销售系数</HeaderCell>
              <HeaderCell align="center">线上系数</HeaderCell>
              <HeaderCell align="center">恢复</HeaderCell>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-stone-900/10 bg-amber-50/60">
              <BodyCell align="center" className="font-semibold text-amber-900">
                默认
              </BodyCell>
              <BodyCell align="center">
                <CompactNumberInput
                  value={props.template.events}
                  min={0}
                  step={1}
                  size="sm"
                  align="center"
                  className="mx-auto max-w-[112px]"
                  onChange={(value) => props.onTemplateNumberChange('events', value)}
                />
              </BodyCell>
              <BodyCell align="center">
                <CompactNumberInput
                  value={props.template.salesMultiplier}
                  min={0}
                  step={0.01}
                  size="sm"
                  align="center"
                  className="mx-auto max-w-[128px]"
                  onChange={(value) => props.onTemplateNumberChange('salesMultiplier', value)}
                />
              </BodyCell>
              <BodyCell align="center">
                <CompactNumberInput
                  value={props.template.onlineSalesFactor}
                  min={0}
                  step={0.01}
                  size="sm"
                  align="center"
                  className="mx-auto max-w-[144px]"
                  onChange={(value) => props.onTemplateNumberChange('onlineSalesFactor', value)}
                />
              </BodyCell>
              <BodyCell align="center" className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">
                --
              </BodyCell>
            </tr>

            {props.months.map((month) => (
              <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                <BodyCell align="center" className="font-semibold text-stone-900">
                  {month.label}
                </BodyCell>
                <BodyCell align="center">
                  <CompactNumberInput
                    value={month.events}
                    min={0}
                    step={1}
                    size="sm"
                    align="center"
                    className="mx-auto max-w-[112px]"
                    onChange={(value) => props.onNumberChange(month.id, 'events', value)}
                  />
                </BodyCell>
                <BodyCell align="center">
                  <CompactNumberInput
                    value={month.salesMultiplier}
                    min={0}
                    step={0.01}
                    size="sm"
                    align="center"
                    className="mx-auto max-w-[128px]"
                    onChange={(value) => props.onNumberChange(month.id, 'salesMultiplier', value)}
                  />
                </BodyCell>
                <BodyCell align="center">
                  <CompactNumberInput
                    value={month.onlineSalesFactor}
                    min={0}
                    step={0.01}
                    size="sm"
                    align="center"
                    className="mx-auto max-w-[144px]"
                    onChange={(value) => props.onNumberChange(month.id, 'onlineSalesFactor', value)}
                  />
                </BodyCell>
                <BodyCell align="center">
                  <button
                    type="button"
                    onClick={() => props.onResetMonthFromTemplate(month.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-100"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" />
                    默认
                  </button>
                </BodyCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function RhythmChart(props: {
  months: MonthlyPlan[]
  templateEvents: number
  templateSalesMultiplier: number
  eventMax: number
  salesMax: number
  dragTarget: DragTarget
  onStartDrag: (target: DragTarget, clientY: number) => void
}) {
  const { width, height, padding } = rhythmChartFrame
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xStep = props.months.length > 1 ? plotWidth / (props.months.length - 1) : 0

  function getX(index: number) {
    return padding.left + xStep * index
  }

  function getY(value: number, max: number) {
    return padding.top + ((max - value) / (max || 1)) * plotHeight
  }

  function buildPath(key: RhythmSeriesKey) {
    return props.months
      .map((month, index) => {
        const value = key === 'events' ? month.events : month.salesMultiplier
        const max = key === 'events' ? props.eventMax : props.salesMax
        return `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value, max)}`
      })
      .join(' ')
  }

  const eventsPath = buildPath('events')
  const salesPath = buildPath('salesMultiplier')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-[320px] w-full"
      role="img"
      aria-label="场次与销售系数联动收入节奏图"
    >
      {Array.from({ length: 5 }, (_, index) => {
        const fraction = index / 4
        const y = padding.top + plotHeight - plotHeight * fraction
        const eventTick = props.eventMax * fraction
        const salesTick = props.salesMax * fraction

        return (
          <g key={fraction}>
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="rgba(120,113,108,0.18)"
              strokeDasharray="4 6"
            />
            <text x={padding.left - 12} y={y + 4} textAnchor="end" fontSize="11" fill="#78716c">
              {Math.round(eventTick)}场
            </text>
            <text x={width - padding.right + 12} y={y + 4} fontSize="11" fill="#059669">
              {formatDecimal(salesTick)}x
            </text>
          </g>
        )
      })}

      <line
        x1={padding.left}
        y1={getY(props.templateEvents, props.eventMax)}
        x2={width - padding.right}
        y2={getY(props.templateEvents, props.eventMax)}
        stroke="rgba(245,158,11,0.45)"
        strokeDasharray="8 6"
      />
      <line
        x1={padding.left}
        y1={getY(props.templateSalesMultiplier, props.salesMax)}
        x2={width - padding.right}
        y2={getY(props.templateSalesMultiplier, props.salesMax)}
        stroke="rgba(16,185,129,0.38)"
        strokeDasharray="8 6"
      />

      {props.months.map((month, index) => (
        <line
          key={`grid-${month.id}`}
          x1={getX(index)}
          y1={padding.top}
          x2={getX(index)}
          y2={height - padding.bottom}
          stroke="rgba(120,113,108,0.08)"
        />
      ))}

      <path d={eventsPath} fill="none" stroke="#f59e0b" strokeWidth="4" strokeLinecap="round" />
      <path d={salesPath} fill="none" stroke="#10b981" strokeWidth="4" strokeLinecap="round" />

      {props.months.map((month, index) => {
        const eventTarget = props.dragTarget?.series === 'events' && props.dragTarget.monthId === month.id
        const salesTarget = props.dragTarget?.series === 'salesMultiplier' && props.dragTarget.monthId === month.id
        const x = getX(index)
        const eventY = getY(month.events, props.eventMax)
        const salesY = getY(month.salesMultiplier, props.salesMax)

        return (
          <g key={month.id}>
            <text x={x} y={height - 18} textAnchor="middle" fontSize="11" fill="#57534e">
              {month.label}
            </text>

            <circle
              cx={x}
              cy={eventY}
              r={13}
              fill="transparent"
              style={{ cursor: 'ns-resize' }}
              onPointerDown={(event) => {
                event.preventDefault()
                props.onStartDrag({ monthId: month.id, series: 'events' }, event.clientY)
              }}
            />
            <circle
              cx={x}
              cy={eventY}
              r={eventTarget ? 7 : 5}
              fill="#f59e0b"
              stroke="white"
              strokeWidth={eventTarget ? '3' : '2'}
              pointerEvents="none"
            />
            <text x={x} y={eventY - 12} textAnchor="middle" fontSize="11" fontWeight="700" fill="#b45309">
              {month.events}
            </text>

            <circle
              cx={x}
              cy={salesY}
              r={13}
              fill="transparent"
              style={{ cursor: 'ns-resize' }}
              onPointerDown={(event) => {
                event.preventDefault()
                props.onStartDrag({ monthId: month.id, series: 'salesMultiplier' }, event.clientY)
              }}
            />
            <circle
              cx={x}
              cy={salesY}
              r={salesTarget ? 7 : 5}
              fill="#10b981"
              stroke="white"
              strokeWidth={salesTarget ? '3' : '2'}
              pointerEvents="none"
            />
            <text x={x} y={salesY + 22} textAnchor="middle" fontSize="11" fontWeight="700" fill="#047857">
              {formatDecimal(month.salesMultiplier)}x
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function LegendPill(props: {
  color: string
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-600">
      <span className={cx('h-2.5 w-2.5 rounded-full', props.color)} />
      {props.label}
    </span>
  )
}
