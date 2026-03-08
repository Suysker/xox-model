import { CalendarRange, RefreshCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { formatDecimal } from '../../lib/format'
import type { MonthlyPlan, MonthlyPlanTemplate } from '../../types'
import { CompactNumberInput, Panel, SectionTitle, SegmentTabs, TextAreaField } from '../common/ui'

type MatrixTab = 'sales' | 'training' | 'special' | 'notes'
type EditableTab = Exclude<MatrixTab, 'notes'>
type MonthNumberKey =
  | 'events'
  | 'salesMultiplier'
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'
  | 'extraPerEventCost'
  | 'extraFixedCost'
  | 'vjCost'
  | 'originalSongCost'
  | 'makeupCost'
  | 'travelCost'
  | 'streamingCost'
  | 'mealCost'
type MonthTextKey = 'notes'

const trainingColumns: Array<{ key: MonthNumberKey; label: string; step: number | 'any' }> = [
  { key: 'rehearsalCount', label: '排练次数', step: 1 },
  { key: 'rehearsalCost', label: '排练单价', step: 50 },
  { key: 'teacherCount', label: '老师次数', step: 1 },
  { key: 'teacherCost', label: '老师单价', step: 50 },
  { key: 'extraPerEventCost', label: '额外每场', step: 100 },
  { key: 'extraFixedCost', label: '额外固定', step: 100 },
]

const specialColumns: Array<{ key: MonthNumberKey; label: string; step: number | 'any' }> = [
  { key: 'vjCost', label: 'VJ', step: 100 },
  { key: 'originalSongCost', label: '原创', step: 100 },
  { key: 'makeupCost', label: '化妆', step: 100 },
  { key: 'travelCost', label: '路费', step: 100 },
  { key: 'streamingCost', label: '推流', step: 100 },
  { key: 'mealCost', label: '聚餐', step: 100 },
]

export function TimelineEditor(props: {
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  onTemplateNumberChange: (key: MonthNumberKey, value: number) => void
  onTemplateMaterialToggle: (value: boolean) => void
  onTextChange: (id: string, key: MonthTextKey, value: string) => void
  onNumberChange: (id: string, key: MonthNumberKey, value: number) => void
  onMaterialToggle: (id: string, value: boolean) => void
  onApplyTemplateToAll: (tab: EditableTab) => void
  onResetMonthFromTemplate: (id: string, tab: EditableTab) => void
}) {
  const [tab, setTab] = useState<MatrixTab>('sales')

  return (
    <Panel>
      <SectionTitle
        icon={CalendarRange}
        eyebrow="Inputs"
        title="月度经营排期"
        description="先定默认基线，再只改少数例外月份。经营节奏改成可视化编辑，不再让你在横向表格里填满一排。"
      />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentTabs<MatrixTab>
          value={tab}
          items={[
            { value: 'sales', label: '经营节奏' },
            { value: 'training', label: '训练与补充成本' },
            { value: 'special', label: '专项项目' },
            { value: 'notes', label: '备注' },
          ]}
          onChange={setTab}
        />

        {tab !== 'notes' ? (
          <button
            type="button"
            onClick={() => props.onApplyTemplateToAll(tab)}
            className="inline-flex items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
          >
            同步默认
          </button>
        ) : null}
      </div>

      {tab === 'sales' ? (
        <SalesTimelineStudio
          template={props.template}
          months={props.months}
          onTemplateNumberChange={props.onTemplateNumberChange}
          onTemplateMaterialToggle={props.onTemplateMaterialToggle}
          onNumberChange={props.onNumberChange}
          onMaterialToggle={props.onMaterialToggle}
          onResetMonthFromTemplate={props.onResetMonthFromTemplate}
        />
      ) : null}

      {tab === 'training' ? (
        <CostTimelineStudio
          title="训练与补充成本"
          description="把训练节奏先定成默认基线，再只改少数异常月份。"
          template={props.template}
          months={props.months}
          columns={trainingColumns}
          sectionKey="training"
          onTemplateNumberChange={props.onTemplateNumberChange}
          onNumberChange={props.onNumberChange}
          onResetMonthFromTemplate={props.onResetMonthFromTemplate}
        />
      ) : null}

      {tab === 'special' ? (
        <CostTimelineStudio
          title="专项项目"
          description="原创、VJ、化妆、推流这些零散成本改成月卡片，不再横向挤成表格。"
          template={props.template}
          months={props.months}
          columns={specialColumns}
          sectionKey="special"
          onTemplateNumberChange={props.onTemplateNumberChange}
          onNumberChange={props.onNumberChange}
          onResetMonthFromTemplate={props.onResetMonthFromTemplate}
        />
      ) : null}

      {tab === 'notes' ? (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {props.months.map((month) => (
            <div key={month.id} className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-4">
              <p className="text-sm font-semibold text-stone-950">{month.label}</p>
              <div className="mt-3">
                <TextAreaField
                  label="月份备注"
                  helper="例如启动月、上新歌、冲销量、巡演或休息。"
                  value={month.notes}
                  onChange={(value) => props.onTextChange(month.id, 'notes', value)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  )
}

function SalesTimelineStudio(props: {
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  onTemplateNumberChange: (key: MonthNumberKey, value: number) => void
  onTemplateMaterialToggle: (value: boolean) => void
  onNumberChange: (id: string, key: MonthNumberKey, value: number) => void
  onMaterialToggle: (id: string, value: boolean) => void
  onResetMonthFromTemplate: (id: string, tab: EditableTab) => void
}) {
  return (
    <div className="mt-5 space-y-4">
      <section className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">经营基线</h3>
            <p className="mt-1 text-sm leading-6 text-stone-600">先设默认场次和销售系数，再在下面按月份拉曲线。</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[620px]">
            <FieldTile label="默认场次">
              <CompactNumberInput
                value={props.template.events}
                min={0}
                step={1}
                align="center"
                onChange={(value) => props.onTemplateNumberChange('events', value)}
              />
            </FieldTile>
            <FieldTile label="默认销售系数">
              <CompactNumberInput
                value={props.template.salesMultiplier}
                min={0}
                step="any"
                align="center"
                onChange={(value) => props.onTemplateNumberChange('salesMultiplier', value)}
              />
            </FieldTile>
            <FieldTile label="默认耗材">
              <TogglePill
                active={props.template.includeMaterialCost}
                activeLabel="计入耗材"
                inactiveLabel="不计耗材"
                onClick={() => props.onTemplateMaterialToggle(!props.template.includeMaterialCost)}
              />
            </FieldTile>
          </div>
        </div>
      </section>

      <CurveEditor
        title="场次曲线"
        helper="用滑条直接拉月度场次，曲线会实时反映排期起伏。"
        months={props.months}
        templateValue={props.template.events}
        values={props.months.map((month) => month.events)}
        valueFormatter={(value) => `${Math.round(value)} 场`}
        step={1}
        min={0}
        max={Math.max(props.template.events + 4, ...props.months.map((month) => month.events + 2), 6)}
        onChange={(monthId, value) => props.onNumberChange(monthId, 'events', Math.round(value))}
      />

      <CurveEditor
        title="销售系数曲线"
        helper="看成一条增长或收缩曲线，不要再逐格填数字。"
        months={props.months}
        templateValue={props.template.salesMultiplier}
        values={props.months.map((month) => month.salesMultiplier)}
        valueFormatter={(value) => `${formatDecimal(value)}x`}
        step={0.01}
        min={0}
        max={Math.max(2, props.template.salesMultiplier + 0.6, ...props.months.map((month) => month.salesMultiplier + 0.25))}
        onChange={(monthId, value) => props.onNumberChange(monthId, 'salesMultiplier', Number(value.toFixed(2)))}
      />

      <section className="rounded-[24px] border border-stone-900/10 bg-white p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">月度开关与恢复</h3>
            <p className="mt-1 text-sm leading-6 text-stone-600">耗材是否计入和恢复默认，都在这里按月份处理。</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {props.months.map((month) => (
            <article key={month.id} className="rounded-[20px] border border-stone-900/10 bg-stone-50/80 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-stone-950">{month.label}</p>
                <button
                  type="button"
                  onClick={() => props.onResetMonthFromTemplate(month.id, 'sales')}
                  className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-100"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  默认
                </button>
              </div>

              <div className="mt-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">耗材</p>
                <div className="mt-2">
                  <TogglePill
                    active={month.includeMaterialCost}
                    activeLabel="计入"
                    inactiveLabel="不计"
                    onClick={() => props.onMaterialToggle(month.id, !month.includeMaterialCost)}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function CostTimelineStudio(props: {
  title: string
  description: string
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  columns: Array<{ key: MonthNumberKey; label: string; step: number | 'any' }>
  sectionKey: EditableTab
  onTemplateNumberChange: (key: MonthNumberKey, value: number) => void
  onNumberChange: (id: string, key: MonthNumberKey, value: number) => void
  onResetMonthFromTemplate: (id: string, tab: EditableTab) => void
}) {
  return (
    <div className="mt-5 space-y-4">
      <section className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-stone-950">{props.title}默认值</h3>
            <p className="mt-1 text-sm leading-6 text-stone-600">{props.description}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {props.columns.map((column) => (
            <FieldTile key={column.key} label={column.label}>
              <CompactNumberInput
                value={props.template[column.key]}
                min={0}
                step={column.step}
                align="center"
                onChange={(value) => props.onTemplateNumberChange(column.key, value)}
              />
            </FieldTile>
          ))}
        </div>
      </section>

      <section className="rounded-[24px] border border-stone-900/10 bg-white p-4">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">月份差异卡片</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">只对例外月份做改动，默认值已经由上面的基线负责。</p>
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {props.months.map((month) => (
            <article key={month.id} className="rounded-[20px] border border-stone-900/10 bg-stone-50/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-stone-950">{month.label}</p>
                <button
                  type="button"
                  onClick={() => props.onResetMonthFromTemplate(month.id, props.sectionKey)}
                  className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-100"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  恢复默认
                </button>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {props.columns.map((column) => (
                  <FieldTile key={`${month.id}-${column.key}`} label={column.label}>
                    <CompactNumberInput
                      value={month[column.key]}
                      min={0}
                      step={column.step}
                      align="center"
                      onChange={(value) => props.onNumberChange(month.id, column.key, value)}
                    />
                  </FieldTile>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function CurveEditor(props: {
  title: string
  helper: string
  months: MonthlyPlan[]
  templateValue: number
  values: number[]
  valueFormatter: (value: number) => string
  step: number
  min: number
  max: number
  onChange: (monthId: string, value: number) => void
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-white p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">{props.title}</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">{props.helper}</p>
        </div>
        <span className="rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-600">
          默认：{props.valueFormatter(props.templateValue)}
        </span>
      </div>

      <div className="mt-4 rounded-[22px] border border-white/10 bg-stone-950 p-4 text-white">
        <CurvePreview
          months={props.months}
          values={props.values}
          maxValue={props.max}
          templateValue={props.templateValue}
          valueFormatter={props.valueFormatter}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {props.months.map((month, index) => (
          <article key={month.id} className="rounded-[20px] border border-stone-900/10 bg-stone-50/80 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-stone-950">{month.label}</p>
              <span className="text-xs font-semibold text-stone-500">{props.valueFormatter(props.values[index] ?? 0)}</span>
            </div>

            <input
              type="range"
              min={props.min}
              max={props.max}
              step={props.step}
              value={props.values[index] ?? 0}
              onChange={(event) => props.onChange(month.id, Number(event.target.value))}
              className="mt-4 h-2 w-full cursor-pointer accent-amber-500"
            />

            <div className="mt-3">
              <CompactNumberInput
                value={props.values[index] ?? 0}
                min={props.min}
                max={props.max}
                step={props.step}
                size="sm"
                align="center"
                onChange={(value) => props.onChange(month.id, value)}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function CurvePreview(props: {
  months: MonthlyPlan[]
  values: number[]
  templateValue: number
  maxValue: number
  valueFormatter: (value: number) => string
}) {
  const width = 760
  const height = 220
  const padding = { top: 18, right: 18, bottom: 34, left: 44 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xStep = props.months.length > 1 ? plotWidth / (props.months.length - 1) : 0
  const labelStride = Math.max(1, Math.ceil(props.months.length / 6))
  const maxValue = Math.max(props.maxValue, props.templateValue, 1)

  function getX(index: number) {
    return padding.left + xStep * index
  }

  function getY(value: number) {
    return padding.top + ((maxValue - value) / maxValue) * plotHeight
  }

  const path = props.values
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${getX(index)} ${getY(value)}`)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-[220px] w-full" role="img" aria-label="月份节奏曲线">
      {[0, maxValue / 2, maxValue].map((tick) => (
        <g key={tick}>
          <line
            x1={padding.left}
            y1={getY(tick)}
            x2={width - padding.right}
            y2={getY(tick)}
            stroke="rgba(255,255,255,0.12)"
            strokeDasharray="4 6"
          />
          <text x={padding.left - 10} y={getY(tick) + 4} textAnchor="end" fontSize="11" fill="rgba(231,229,228,0.72)">
            {props.valueFormatter(tick)}
          </text>
        </g>
      ))}

      <line
        x1={padding.left}
        y1={getY(props.templateValue)}
        x2={width - padding.right}
        y2={getY(props.templateValue)}
        stroke="rgba(245,158,11,0.6)"
        strokeDasharray="8 6"
      />

      <path d={path} fill="none" stroke="rgba(16,185,129,0.95)" strokeWidth="4" strokeLinecap="round" />

      {props.values.map((value, index) => (
        <g key={`${props.months[index]?.id ?? index}-point`}>
          <circle
            cx={getX(index)}
            cy={getY(value)}
            r="4.5"
            fill="#10b981"
            stroke="rgba(12,10,9,0.9)"
            strokeWidth="1.5"
          />
          {index === 0 || index === props.values.length - 1 || index % labelStride === 0 ? (
            <text
              x={getX(index)}
              y={getY(value) - 12}
              textAnchor="middle"
              fontSize="10"
              fontWeight="700"
              fill="rgba(250,250,249,0.9)"
            >
              {props.valueFormatter(value)}
            </text>
          ) : null}
        </g>
      ))}

      {props.months.map((month, index) => (
        <g key={month.id}>
          <line
            x1={getX(index)}
            y1={height - padding.bottom}
            x2={getX(index)}
            y2={height - padding.bottom + 6}
            stroke="rgba(255,255,255,0.3)"
          />
          {index === 0 || index === props.months.length - 1 || index % labelStride === 0 ? (
            <text
              x={getX(index)}
              y={height - 10}
              textAnchor="middle"
              fontSize="11"
              fill="rgba(231,229,228,0.72)"
            >
              {month.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  )
}

function FieldTile(props: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="rounded-[18px] border border-stone-900/10 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">{props.label}</p>
      <div className="mt-3">{props.children}</div>
    </div>
  )
}

function TogglePill(props: {
  active: boolean
  activeLabel: string
  inactiveLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        props.active
          ? 'h-10 w-full rounded-xl border border-emerald-200 bg-emerald-100 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-200'
          : 'h-10 w-full rounded-xl border border-stone-900/10 bg-stone-100/80 text-sm font-semibold text-stone-600 transition hover:bg-white'
      }
    >
      {props.active ? props.activeLabel : props.inactiveLabel}
    </button>
  )
}
