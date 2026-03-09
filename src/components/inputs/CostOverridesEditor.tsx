import { Receipt, RefreshCcw } from 'lucide-react'
import { useState } from 'react'
import type { MonthlyPlan, MonthlyPlanTemplate } from '../../types'
import { cx } from '../../lib/format'
import { BodyCell, CompactNumberInput, HeaderCell, Panel, SectionTitle, SegmentTabs } from '../common/ui'

type CostTab = 'training' | 'special'
type CostNumberKey =
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'
  | 'extraPerEventCost'
  | 'extraFixedCost'
  | 'vjCost'
  | 'originalSongCost'
  | 'makeupPerEventCost'
  | 'streamingPerEventCost'
  | 'mealPerEventCost'

const trainingColumns: Array<{ key: CostNumberKey; label: string; step: number | 'any' }> = [
  { key: 'rehearsalCount', label: '排练次数', step: 1 },
  { key: 'rehearsalCost', label: '排练单价', step: 50 },
  { key: 'teacherCount', label: '老师次数', step: 1 },
  { key: 'teacherCost', label: '老师单价', step: 50 },
  { key: 'extraPerEventCost', label: '额外每场', step: 100 },
  { key: 'extraFixedCost', label: '额外固定', step: 100 },
]

const specialColumns: Array<{ key: CostNumberKey; label: string; step: number | 'any' }> = [
  { key: 'vjCost', label: 'VJ/月', step: 100 },
  { key: 'originalSongCost', label: '原创/月', step: 100 },
  { key: 'makeupPerEventCost', label: '化妆/场', step: 100 },
  { key: 'streamingPerEventCost', label: '推流/场', step: 100 },
  { key: 'mealPerEventCost', label: '聚餐/场', step: 100 },
]

export function CostOverridesEditor(props: {
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  onTemplateNumberChange: (key: CostNumberKey, value: number) => void
  onNumberChange: (id: string, key: CostNumberKey, value: number) => void
  onMaterialToggle: (id: string, value: boolean) => void
  onTemplateMaterialToggle: (value: boolean) => void
  onApplyTemplateToAll: (section: 'training' | 'special') => void
  onResetMonthFromTemplate: (id: string, section: 'training' | 'special') => void
}) {
  const [tab, setTab] = useState<CostTab>('training')

  return (
    <Panel>
      <SectionTitle
        icon={Receipt}
        eyebrow="Inputs"
        title="成本月度差异"
        description="默认行定义长期基线，下面各月只改例外月份。"
      />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentTabs<CostTab>
          value={tab}
          items={[
            { value: 'training', label: '训练与补充' },
            { value: 'special', label: '专项与耗材' },
          ]}
          onChange={setTab}
        />

        <button
          type="button"
          onClick={() => props.onApplyTemplateToAll(tab)}
          className="inline-flex items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
        >
          同步默认
        </button>
      </div>

      {tab === 'training' ? (
        <section className="mt-4 rounded-[24px] border border-stone-900/10 bg-white p-4">
          <h3 className="text-lg font-semibold text-stone-950">训练与补充成本</h3>
          <div className="mt-4 rounded-[20px] border border-stone-900/10">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell align="center">月份</HeaderCell>
                  {trainingColumns.map((column) => (
                    <HeaderCell key={column.key} align="center">
                      {column.label}
                    </HeaderCell>
                  ))}
                  <HeaderCell align="center">恢复</HeaderCell>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-stone-900/10 bg-amber-50/60">
                  <BodyCell align="center" className="font-semibold text-amber-900">
                    默认
                  </BodyCell>
                  {trainingColumns.map((column) => (
                    <BodyCell key={`template-${column.key}`} align="center">
                      <CompactNumberInput
                        value={props.template[column.key]}
                        min={0}
                        step={column.step}
                        size="sm"
                        align="center"
                        className="mx-auto max-w-[110px]"
                        onChange={(value) => props.onTemplateNumberChange(column.key, value)}
                      />
                    </BodyCell>
                  ))}
                  <BodyCell align="center" className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">
                    --
                  </BodyCell>
                </tr>

                {props.months.map((month) => (
                  <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                    <BodyCell align="center" className="font-semibold text-stone-900">
                      {month.label}
                    </BodyCell>
                    {trainingColumns.map((column) => (
                      <BodyCell key={`${month.id}-${column.key}`} align="center">
                        <CompactNumberInput
                          value={month[column.key]}
                          min={0}
                          step={column.step}
                          size="sm"
                          align="center"
                          className="mx-auto max-w-[110px]"
                          onChange={(value) => props.onNumberChange(month.id, column.key, value)}
                        />
                      </BodyCell>
                    ))}
                    <BodyCell align="center">
                      <button
                        type="button"
                        onClick={() => props.onResetMonthFromTemplate(month.id, 'training')}
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
        </section>
      ) : null}

      {tab === 'special' ? (
        <section className="mt-4 rounded-[24px] border border-stone-900/10 bg-white p-4">
          <h3 className="text-lg font-semibold text-stone-950">专项与耗材</h3>
          <div className="mt-4 rounded-[20px] border border-stone-900/10">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell align="center">月份</HeaderCell>
                  {specialColumns.map((column) => (
                    <HeaderCell key={column.key} align="center">
                      {column.label}
                    </HeaderCell>
                  ))}
                  <HeaderCell align="center">耗材</HeaderCell>
                  <HeaderCell align="center">恢复</HeaderCell>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-stone-900/10 bg-amber-50/60">
                  <BodyCell align="center" className="font-semibold text-amber-900">
                    默认
                  </BodyCell>
                  {specialColumns.map((column) => (
                    <BodyCell key={`template-${column.key}`} align="center">
                      <CompactNumberInput
                        value={props.template[column.key]}
                        min={0}
                        step={column.step}
                        size="sm"
                        align="center"
                        className="mx-auto max-w-[110px]"
                        onChange={(value) => props.onTemplateNumberChange(column.key, value)}
                      />
                    </BodyCell>
                  ))}
                  <BodyCell align="center">
                    <button
                      type="button"
                      onClick={() => props.onTemplateMaterialToggle(!props.template.includeMaterialCost)}
                      className={cx(
                        'inline-flex min-w-[72px] items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold transition',
                        props.template.includeMaterialCost
                          ? 'border-emerald-200 bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                          : 'border-stone-900/10 bg-stone-100/80 text-stone-600 hover:bg-white',
                      )}
                    >
                      {props.template.includeMaterialCost ? '计入' : '关闭'}
                    </button>
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
                    {specialColumns.map((column) => (
                      <BodyCell key={`${month.id}-${column.key}`} align="center">
                        <CompactNumberInput
                          value={month[column.key]}
                          min={0}
                          step={column.step}
                          size="sm"
                          align="center"
                          className="mx-auto max-w-[110px]"
                          onChange={(value) => props.onNumberChange(month.id, column.key, value)}
                        />
                      </BodyCell>
                    ))}
                    <BodyCell align="center">
                      <button
                        type="button"
                        onClick={() => props.onMaterialToggle(month.id, !month.includeMaterialCost)}
                        className={cx(
                          'inline-flex min-w-[72px] items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold transition',
                          month.includeMaterialCost
                            ? 'border-emerald-200 bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                            : 'border-stone-900/10 bg-stone-100/80 text-stone-600 hover:bg-white',
                        )}
                      >
                        {month.includeMaterialCost ? '计入' : '关闭'}
                      </button>
                    </BodyCell>
                    <BodyCell align="center">
                      <button
                        type="button"
                        onClick={() => props.onResetMonthFromTemplate(month.id, 'special')}
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
        </section>
      ) : null}
    </Panel>
  )
}
