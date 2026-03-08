import { CalendarRange, RefreshCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { MonthlyPlan, MonthlyPlanTemplate } from '../../types'
import { CompactNumberInput, Panel, SectionTitle, SegmentTabs, TextAreaField } from '../common/ui'

type MatrixTab = 'sales' | 'training' | 'special' | 'notes'
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

const salesColumns: Array<{ key: MonthNumberKey; label: string; step: number | 'any' }> = [
  { key: 'events', label: '场次', step: 1 },
  { key: 'salesMultiplier', label: '销售系数', step: 'any' },
]

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
  onApplyTemplateToAll: (tab: Exclude<MatrixTab, 'notes'>) => void
  onResetMonthFromTemplate: (id: string, tab: Exclude<MatrixTab, 'notes'>) => void
}) {
  const [tab, setTab] = useState<MatrixTab>('sales')

  return (
    <Panel>
      <SectionTitle
        icon={CalendarRange}
        eyebrow="Inputs"
        title="月度经营排期"
        description="这里先调默认模板，再一键应用到全部月份。月度表只保留逐月差异，避免每个月都从头填一遍。"
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
          <div className="rounded-full border border-stone-900/10 bg-stone-50/80 px-4 py-2 text-sm text-stone-600">
            默认模板先定节奏，再逐月改差异
          </div>
        ) : null}
      </div>

      {tab === 'sales' ? (
        <>
          <TemplateBlock title="默认经营模板" onApply={() => props.onApplyTemplateToAll('sales')}>
            <MonthGridTable
              headers={['模板', '场次', '销售系数', '耗材', '操作']}
              body={
                <tr className="border-b border-stone-900/10 last:border-none">
                  <MonthLabelCell label="默认" description="应用到全部月份" highlight />
                  <GridCell>
                    <CompactNumberInput
                      value={props.template.events}
                      min={0}
                      step={1}
                      size="sm"
                      align="center"
                      onChange={(value) => props.onTemplateNumberChange('events', value)}
                    />
                  </GridCell>
                  <GridCell>
                    <CompactNumberInput
                      value={props.template.salesMultiplier}
                      min={0}
                      step="any"
                      size="sm"
                      align="center"
                      onChange={(value) => props.onTemplateNumberChange('salesMultiplier', value)}
                    />
                  </GridCell>
                  <GridCell>
                    <ToggleCell
                      active={props.template.includeMaterialCost}
                      activeLabel="计入"
                      inactiveLabel="不计"
                      onClick={() => props.onTemplateMaterialToggle(!props.template.includeMaterialCost)}
                    />
                  </GridCell>
                  <ActionCell>
                    <ApplyButton onClick={() => props.onApplyTemplateToAll('sales')} label="应用全部" />
                  </ActionCell>
                </tr>
              }
            />
          </TemplateBlock>

          <OverrideBlock title="逐月微调">
            <MonthGridTable
              headers={['月份', '场次', '销售系数', '耗材', '操作']}
              body={
                <>
                  {props.months.map((month) => (
                    <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                      <MonthLabelCell label={month.label} />
                      <GridCell>
                        <CompactNumberInput
                          value={month.events}
                          min={0}
                          step={1}
                          size="sm"
                          align="center"
                          onChange={(value) => props.onNumberChange(month.id, 'events', value)}
                        />
                      </GridCell>
                      <GridCell>
                        <CompactNumberInput
                          value={month.salesMultiplier}
                          min={0}
                          step="any"
                          size="sm"
                          align="center"
                          onChange={(value) => props.onNumberChange(month.id, 'salesMultiplier', value)}
                        />
                      </GridCell>
                      <GridCell>
                        <ToggleCell
                          active={month.includeMaterialCost}
                          activeLabel="计入"
                          inactiveLabel="不计"
                          onClick={() => props.onMaterialToggle(month.id, !month.includeMaterialCost)}
                        />
                      </GridCell>
                      <ActionCell>
                        <ResetButton onClick={() => props.onResetMonthFromTemplate(month.id, 'sales')} />
                      </ActionCell>
                    </tr>
                  ))}
                </>
              }
            />
          </OverrideBlock>
        </>
      ) : null}

      {tab === 'training' ? (
        <>
          <TemplateBlock title="默认训练模板" onApply={() => props.onApplyTemplateToAll('training')}>
            <MonthGridTable
              headers={['模板', ...trainingColumns.map((column) => column.label), '操作']}
              body={
                <tr className="border-b border-stone-900/10 last:border-none">
                  <MonthLabelCell label="默认" description="应用到全部月份" highlight />
                  {trainingColumns.map((column) => (
                    <GridCell key={column.key}>
                      <CompactNumberInput
                        value={props.template[column.key]}
                        min={0}
                        step={column.step}
                        size="sm"
                        align="center"
                        onChange={(value) => props.onTemplateNumberChange(column.key, value)}
                      />
                    </GridCell>
                  ))}
                  <ActionCell>
                    <ApplyButton onClick={() => props.onApplyTemplateToAll('training')} label="应用全部" />
                  </ActionCell>
                </tr>
              }
            />
          </TemplateBlock>

          <OverrideBlock title="逐月微调">
            <MonthGridTable
              headers={['月份', ...trainingColumns.map((column) => column.label), '操作']}
              body={
                <>
                  {props.months.map((month) => (
                    <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                      <MonthLabelCell label={month.label} />
                      {trainingColumns.map((column) => (
                        <GridCell key={`${month.id}-${column.key}`}>
                          <CompactNumberInput
                            value={month[column.key]}
                            min={0}
                            step={column.step}
                            size="sm"
                            align="center"
                            onChange={(value) => props.onNumberChange(month.id, column.key, value)}
                          />
                        </GridCell>
                      ))}
                      <ActionCell>
                        <ResetButton onClick={() => props.onResetMonthFromTemplate(month.id, 'training')} />
                      </ActionCell>
                    </tr>
                  ))}
                </>
              }
            />
          </OverrideBlock>
        </>
      ) : null}

      {tab === 'special' ? (
        <>
          <TemplateBlock title="默认专项模板" onApply={() => props.onApplyTemplateToAll('special')}>
            <MonthGridTable
              headers={['模板', ...specialColumns.map((column) => column.label), '操作']}
              body={
                <tr className="border-b border-stone-900/10 last:border-none">
                  <MonthLabelCell label="默认" description="应用到全部月份" highlight />
                  {specialColumns.map((column) => (
                    <GridCell key={column.key}>
                      <CompactNumberInput
                        value={props.template[column.key]}
                        min={0}
                        step={column.step}
                        size="sm"
                        align="center"
                        onChange={(value) => props.onTemplateNumberChange(column.key, value)}
                      />
                    </GridCell>
                  ))}
                  <ActionCell>
                    <ApplyButton onClick={() => props.onApplyTemplateToAll('special')} label="应用全部" />
                  </ActionCell>
                </tr>
              }
            />
          </TemplateBlock>

          <OverrideBlock title="逐月微调">
            <MonthGridTable
              headers={['月份', ...specialColumns.map((column) => column.label), '操作']}
              body={
                <>
                  {props.months.map((month) => (
                    <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                      <MonthLabelCell label={month.label} />
                      {specialColumns.map((column) => (
                        <GridCell key={`${month.id}-${column.key}`}>
                          <CompactNumberInput
                            value={month[column.key]}
                            min={0}
                            step={column.step}
                            size="sm"
                            align="center"
                            onChange={(value) => props.onNumberChange(month.id, column.key, value)}
                          />
                        </GridCell>
                      ))}
                      <ActionCell>
                        <ResetButton onClick={() => props.onResetMonthFromTemplate(month.id, 'special')} />
                      </ActionCell>
                    </tr>
                  ))}
                </>
              }
            />
          </OverrideBlock>
        </>
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

function TemplateBlock(props: {
  title: string
  onApply: () => void
  children: ReactNode
}) {
  return (
    <section className="mt-5 rounded-[24px] border border-amber-200 bg-amber-50/80 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">{props.title}</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">先把默认节奏定下来，再统一铺满全部月份。</p>
        </div>
        <ApplyButton onClick={props.onApply} label="应用到全部月份" />
      </div>
      <div className="mt-4">{props.children}</div>
    </section>
  )
}

function OverrideBlock(props: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="mt-4 rounded-[24px] border border-stone-900/10 bg-white p-4">
      <div>
        <h3 className="text-lg font-semibold text-stone-950">{props.title}</h3>
        <p className="mt-1 text-sm leading-6 text-stone-600">只有和默认模板不一样的月份才需要改，右侧可以一键恢复默认。</p>
      </div>
      <div className="mt-4">{props.children}</div>
    </section>
  )
}

function MonthGridTable(props: {
  headers: string[]
  body: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-[20px] border border-stone-900/10">
      <table className="min-w-[820px] w-full border-collapse text-sm">
        <thead className="bg-stone-100/90 text-stone-700">
          <tr className="border-b border-stone-900/10">
            {props.headers.map((header) => (
              <th key={header} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.16em]">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{props.body}</tbody>
      </table>
    </div>
  )
}

function MonthLabelCell(props: {
  label: string
  description?: string | undefined
  highlight?: boolean | undefined
}) {
  return (
    <td className={props.highlight ? 'px-3 py-2.5 align-top bg-amber-50/60' : 'px-3 py-2.5 align-top'}>
      <div>
        <p className="font-semibold text-stone-950">{props.label}</p>
        {props.description ? <p className="mt-1 text-xs text-stone-500">{props.description}</p> : null}
      </div>
    </td>
  )
}

function GridCell(props: {
  children: ReactNode
}) {
  return <td className="px-2 py-2.5">{props.children}</td>
}

function ActionCell(props: {
  children: ReactNode
}) {
  return <td className="px-3 py-2.5 text-right">{props.children}</td>
}

function ToggleCell(props: {
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
          ? 'h-9 w-full rounded-lg border border-emerald-200 bg-emerald-100 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-200'
          : 'h-9 w-full rounded-lg border border-stone-900/10 bg-stone-100/80 text-xs font-semibold text-stone-600 transition hover:bg-white'
      }
    >
      {props.active ? props.activeLabel : props.inactiveLabel}
    </button>
  )
}

function ApplyButton(props: {
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
    >
      {props.label}
    </button>
  )
}

function ResetButton(props: {
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
    >
      <RefreshCcw className="h-3.5 w-3.5" />
      恢复默认
    </button>
  )
}
