import type { ScenarioKey, ScenarioResult } from '../../types'
import { formatCompactNumber } from '../../lib/format'

export type ChartMetricKey = 'revenue' | 'cost' | 'profit' | 'cash'

const scenarioOrder: ScenarioKey[] = ['pessimistic', 'base', 'optimistic']

const scenarioColors: Record<ScenarioKey, string> = {
  pessimistic: '#f43f5e',
  base: '#f59e0b',
  optimistic: '#10b981',
}

function getScenarioValue(month: ScenarioResult['months'][number], metric: ChartMetricKey) {
  if (metric === 'revenue') {
    return month.grossSales
  }

  if (metric === 'cost') {
    return month.totalCost
  }

  if (metric === 'profit') {
    return month.monthlyProfit
  }

  return month.cumulativeCash
}

function buildTicks(minValue: number, maxValue: number) {
  if (minValue === maxValue) {
    return [minValue]
  }

  const step = (maxValue - minValue) / 3

  return [minValue, minValue + step, minValue + step * 2, maxValue]
}

export function MetricBandChart(props: {
  scenarios: ScenarioResult[]
  metric: ChartMetricKey
  initialInvestment: number
}) {
  const width = 760
  const height = 320
  const padding = { top: 20, right: 22, bottom: 36, left: 60 }
  const baseScenario = props.scenarios.find((scenario) => scenario.key === 'base') ?? props.scenarios[0]

  if (!baseScenario) {
    return null
  }

  const labels =
    props.metric === 'cash'
      ? ['投入', ...baseScenario.months.map((month) => month.label)]
      : baseScenario.months.map((month) => month.label)
  const series = scenarioOrder.map((key) => {
    const scenario = props.scenarios.find((item) => item.key === key)
    const values =
      props.metric === 'cash'
        ? [
            -props.initialInvestment,
            ...(scenario?.months.map((month) => getScenarioValue(month, props.metric)) ?? []),
          ]
        : scenario?.months.map((month) => getScenarioValue(month, props.metric)) ?? []

    return {
      key,
      values,
    }
  })

  const allValues = series.flatMap((item) => item.values)
  const minValue = Math.min(...allValues, 0)
  const maxValue = Math.max(...allValues, 0, 1)
  const ticks = buildTicks(minValue, maxValue)
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xStep = labels.length > 1 ? plotWidth / (labels.length - 1) : 0
  const valueRange = maxValue - minValue || 1

  function getX(index: number) {
    return padding.left + xStep * index
  }

  function getY(value: number) {
    return padding.top + ((maxValue - value) / valueRange) * plotHeight
  }

  function buildLine(values: number[]) {
    return values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value)}`)
      .join(' ')
  }

  const bandTop = labels.map((_, index) =>
    Math.max(...series.map((item) => item.values[index] ?? 0)),
  )
  const bandBottom = labels.map((_, index) =>
    Math.min(...series.map((item) => item.values[index] ?? 0)),
  )
  const bandPath =
    labels.length > 0
      ? [
          ...bandTop.map((value, index) => `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value)}`),
          ...[...bandBottom]
            .reverse()
            .map((value, reverseIndex) => {
              const index = bandBottom.length - 1 - reverseIndex
              return `L ${getX(index)} ${getY(value)}`
            }),
          'Z',
        ].join(' ')
      : ''

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[320px] min-w-[680px] w-full"
        role="img"
        aria-label="悲观、基准、乐观三档场景的月度经营图表"
      >
        <rect x="0" y="0" width={width} height={height} fill="transparent" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={getY(tick)}
              x2={width - padding.right}
              y2={getY(tick)}
              stroke="rgba(255,255,255,0.12)"
              strokeDasharray="4 6"
            />
            <text
              x={padding.left - 10}
              y={getY(tick) + 4}
              textAnchor="end"
              fontSize="11"
              fill="rgba(231,229,228,0.7)"
            >
              {formatCompactNumber(tick)}
            </text>
          </g>
        ))}
        <line
          x1={padding.left}
          y1={getY(0)}
          x2={width - padding.right}
          y2={getY(0)}
          stroke="rgba(255,255,255,0.28)"
        />
        {bandPath ? <path d={bandPath} fill="rgba(255,255,255,0.08)" stroke="none" /> : null}
        {series.map((item) => (
          <path
            key={item.key}
            d={buildLine(item.values)}
            fill="none"
            stroke={scenarioColors[item.key]}
            strokeWidth="3"
            strokeLinecap="round"
          />
        ))}
        {labels.map((label, index) => (
          <g key={`${label}-${index}`}>
            <line
              x1={getX(index)}
              y1={height - padding.bottom}
              x2={getX(index)}
              y2={height - padding.bottom + 6}
              stroke="rgba(255,255,255,0.28)"
            />
            <text
              x={getX(index)}
              y={height - 10}
              textAnchor="middle"
              fontSize="11"
              fill="rgba(231,229,228,0.72)"
            >
              {label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
