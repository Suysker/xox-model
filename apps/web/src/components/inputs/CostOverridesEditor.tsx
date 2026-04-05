import { Plus, Receipt, RefreshCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type {
  CostCategory,
  Employee,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  StageCostMode,
  TeamMember,
} from '../../types'
import { BodyCell, CompactNumberInput, HeaderCell, Panel, SegmentTabs } from '../common/ui'

type CostTab = 'training' | 'special'
type TrainingNumberKey =
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'

const trainingColumns: Array<{ key: TrainingNumberKey; label: string; step: number | 'any' }> = [
  { key: 'rehearsalCount', label: '排练次数', step: 1 },
  { key: 'rehearsalCost', label: '排练单价', step: 50 },
  { key: 'teacherCount', label: '老师次数', step: 1 },
  { key: 'teacherCost', label: '老师单价', step: 50 },
]

function getStageHeaderLabel(mode: StageCostMode) {
  if (mode === 'perEvent') {
    return '单价 × 场次'
  }

  if (mode === 'perUnit') {
    return '单价 × 系数'
  }

  return '金额'
}

function getStageValue(
  values: MonthlyPlan['specialCosts'] | MonthlyPlanTemplate['specialCosts'],
  itemId: string,
) {
  return values.find((value) => value.itemId === itemId)
}

function clampUnitFactor(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(1, Math.max(0, value))
}

function getPerUnitFactor(baseAmount: number, currentAmount: number) {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    return 0
  }

  return clampUnitFactor(currentAmount / baseAmount)
}

function formatSplitValue(value: number) {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function EventCostCell(props: {
  amount: number
  count: number
  onAmountChange: (value: number) => void
  onCountChange: (value: number) => void
}) {
  return (
    <div className="mx-auto grid max-w-[92px] grid-cols-[1fr_auto_30px] items-center gap-0.5">
      <CompactNumberInput
        value={props.amount}
        min={0}
        step="any"
        size="xs"
        align="center"
        className="w-full"
        onChange={props.onAmountChange}
      />
      <span className="text-xs font-semibold text-stone-400">×</span>
      <CompactNumberInput
        value={props.count}
        min={0}
        step={1}
        size="xs"
        align="center"
        className="w-full"
        onChange={props.onCountChange}
      />
    </div>
  )
}

function PerUnitCostCell(props: {
  amount: number
  factor: number
  onAmountChange?: ((value: number) => void) | undefined
  onFactorChange?: ((value: number) => void) | undefined
}) {
  return (
    <div className="mx-auto grid max-w-[98px] grid-cols-[1fr_auto_34px] items-center gap-0.5">
      {props.onAmountChange ? (
        <CompactNumberInput
          value={props.amount}
          min={0}
          step="any"
          size="xs"
          align="center"
          className="w-full"
          onChange={props.onAmountChange}
        />
      ) : (
        <div className="flex h-8 items-center justify-center rounded-md border border-stone-900/10 bg-stone-50 px-2 text-[11px] font-medium text-stone-500">
          {formatSplitValue(props.amount)}
        </div>
      )}
      <span className="text-xs font-semibold text-stone-400">×</span>
      {props.onFactorChange ? (
        <CompactNumberInput
          value={props.factor}
          min={0}
          max={1}
          step={0.05}
          size="xs"
          align="center"
          className="w-full"
          onChange={(value) => props.onFactorChange?.(clampUnitFactor(value))}
        />
      ) : (
        <div className="flex h-8 items-center justify-center rounded-md border border-stone-900/10 bg-stone-50 px-2 text-[11px] font-medium text-stone-500">
          {formatSplitValue(props.factor)}
        </div>
      )}
    </div>
  )
}

function MonthResetCell(props: {
  label: string
  resetLabel?: string | undefined
  onReset?: (() => void) | undefined
  tone?: 'default' | 'template' | undefined
}) {
  return (
    <div className={props.onReset ? 'relative min-h-[24px] w-full pr-6' : 'w-full'}>
      <span
        className={
          props.tone === 'template'
            ? 'block text-[12px] font-semibold leading-none text-amber-900'
            : 'block text-[12px] font-semibold leading-none text-stone-900'
        }
      >
        {props.label}
      </span>
      {props.onReset ? (
        <button
          type="button"
          onClick={props.onReset}
          className="absolute right-0 top-0 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-700 transition hover:bg-stone-100"
          aria-label={props.resetLabel}
          title={props.resetLabel}
        >
          <RefreshCcw className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )
}

export function CostOverridesEditor(props: {
  operating: ModelConfig['operating']
  teamMembers: TeamMember[]
  employees: Employee[]
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  stageCostItems: ModelConfig['stageCostItems']
  onCostItemAdd: (category: CostCategory) => void
  onCostItemRemove: (category: CostCategory, id: string) => void
  onCostItemNameChange: (category: CostCategory, id: string, value: string) => void
  onCostItemAmountChange: (category: CostCategory, id: string, value: number) => void
  onTrainingTemplateChange: (key: TrainingNumberKey, value: number) => void
  onTrainingMonthChange: (id: string, key: TrainingNumberKey, value: number) => void
  onApplyTemplateToAll: (section: 'training' | 'special') => void
  onResetMonthFromTemplate: (id: string, section: 'training' | 'special') => void
  onStageCostItemAdd: () => void
  onStageCostItemRemove: (id: string) => void
  onStageCostItemNameChange: (id: string, value: string) => void
  onStageCostItemModeChange: (id: string, value: StageCostMode) => void
  onTemplateStageCostChange: (itemId: string, key: 'amount' | 'count', value: number) => void
  onMonthStageCostChange: (monthId: string, itemId: string, key: 'amount' | 'count', value: number) => void
}) {
  const [tab, setTab] = useState<CostTab>('special')
  const orderedStageCostItems = props.stageCostItems

  return (
    <Panel>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-stone-900/10 bg-stone-950 p-3 text-amber-100">
            <Receipt className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">输入</p>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-bold text-stone-950">成本编辑</h2>
              <SegmentTabs<CostTab>
                value={tab}
                items={[
                  { value: 'special', label: '专项与耗材' },
                  { value: 'training', label: '训练与补充' },
                ]}
                onChange={setTab}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {tab === 'special' ? (
            <>
              <button
                type="button"
                onClick={() => props.onApplyTemplateToAll('special')}
                className="inline-flex items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
              >
                同步默认
              </button>
              <button
                type="button"
                onClick={props.onStageCostItemAdd}
                className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
              >
                <Plus className="h-4 w-4" />
                添加成本列
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => props.onApplyTemplateToAll('training')}
              className="inline-flex items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
            >
              同步默认
            </button>
          )}
        </div>
      </div>

      {tab === 'training' ? (
        <section className="mt-5 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-3">
            <div className="rounded-[20px] border border-stone-900/10">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[88px]" />
                  {trainingColumns.map((column) => (
                    <col key={`${column.key}-column`} />
                  ))}
                </colgroup>
                <thead className="bg-stone-100/90 text-stone-700">
                  <tr className="border-b border-stone-900/10">
                    <HeaderCell align="center" className="px-2 py-2 text-[11px]">月份</HeaderCell>
                    {trainingColumns.map((column) => (
                      <HeaderCell key={column.key} align="center" className="px-2 py-2 text-[11px]">
                        {column.label}
                      </HeaderCell>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-stone-900/10 bg-amber-50/60">
                    <BodyCell align="left" className="px-2 py-1.5">
                      <MonthResetCell label="默认" tone="template" />
                    </BodyCell>
                    {trainingColumns.map((column) => (
                      <BodyCell key={`template-${column.key}`} align="center" className="px-2 py-1.5">
                        <CompactNumberInput
                          value={props.template[column.key]}
                          min={0}
                          step={column.step}
                          size="xs"
                          align="center"
                          className="mx-auto max-w-[104px]"
                          onChange={(value) => props.onTrainingTemplateChange(column.key, value)}
                        />
                      </BodyCell>
                    ))}
                  </tr>

                  {props.months.map((month) => (
                    <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                      <BodyCell align="left" className="px-2 py-1.5">
                        <MonthResetCell
                          label={month.label}
                          resetLabel={`恢复${month.label}训练默认值`}
                          onReset={() => props.onResetMonthFromTemplate(month.id, 'training')}
                        />
                      </BodyCell>
                      {trainingColumns.map((column) => (
                        <BodyCell key={`${month.id}-${column.key}`} align="center" className="px-2 py-1.5">
                          <CompactNumberInput
                            value={month[column.key]}
                            min={0}
                            step={column.step}
                            size="xs"
                            align="center"
                            className="mx-auto max-w-[104px]"
                            onChange={(value) => props.onTrainingMonthChange(month.id, column.key, value)}
                          />
                        </BodyCell>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </section>
      ) : null}

      {tab === 'special' ? (
        <section className="mt-5 rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-3">
            <div className="overflow-x-auto rounded-[20px] border border-stone-900/10 pb-1">
              <table className="w-max min-w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[80px]" />
                  {orderedStageCostItems.map((item) => (
                    <col key={`${item.id}-column`} className="w-[114px]" />
                  ))}
                </colgroup>

                <thead className="bg-stone-100/90 text-stone-700">
                  <tr className="border-b border-stone-900/10">
                    <HeaderCell align="center" rowSpan={2} className="px-2 py-2 text-[11px]">
                      月份
                    </HeaderCell>
                    {orderedStageCostItems.map((item) => (
                      <th key={item.id} className="border-l border-stone-900/10 px-1 py-1.5 align-top">
                        <div className="grid gap-1">
                          <input
                            type="text"
                            value={item.name}
                            placeholder="成本名称"
                            onChange={(event) => props.onStageCostItemNameChange(item.id, event.target.value)}
                            className="h-7 min-w-0 rounded-lg border border-stone-900/10 bg-white px-1.5 text-center text-[11px] font-semibold text-stone-900 outline-none transition focus:border-emerald-500"
                          />
                          <div className="grid grid-cols-[1fr_24px] gap-0.5">
                            <select
                              value={item.mode}
                              onChange={(event) =>
                                props.onStageCostItemModeChange(item.id, event.target.value as StageCostMode)
                              }
                              className="h-[26px] rounded-lg border border-stone-900/10 bg-white px-1 text-center text-[10px] font-semibold text-stone-700 outline-none transition focus:border-emerald-500"
                            >
                              <option value="monthly">按月</option>
                              <option value="perEvent">按场</option>
                              <option value="perUnit">按张</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => props.onStageCostItemRemove(item.id)}
                              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
                              aria-label={`删除${item.name}`}
                              title={`删除${item.name}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-900/10">
                    {orderedStageCostItems.map((item) => (
                      <HeaderCell key={`${item.id}-detail`} align="center" className="px-1.5 py-1.5 text-[10px]">
                        {getStageHeaderLabel(item.mode)}
                      </HeaderCell>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  <tr className="border-b border-stone-900/10 bg-amber-50/60">
                    <BodyCell align="left" className="px-2 py-1.5">
                      <MonthResetCell label="默认" tone="template" />
                    </BodyCell>
                    {orderedStageCostItems.map((item) => {
                      const value = getStageValue(props.template.specialCosts, item.id)

                      if (item.mode === 'perEvent') {
                        return (
                          <BodyCell key={`${item.id}-template-event`} align="center" className="px-1.5 py-1.5">
                            <EventCostCell
                              amount={value?.amount ?? 0}
                              count={value?.count ?? 0}
                              onAmountChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'amount', nextValue)}
                              onCountChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'count', nextValue)}
                            />
                          </BodyCell>
                        )
                      }

                      if (item.mode === 'perUnit') {
                        return (
                          <BodyCell key={`${item.id}-template-unit`} align="center" className="px-1.5 py-1.5">
                            <PerUnitCostCell
                              amount={value?.amount ?? 0}
                              factor={1}
                              onAmountChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'amount', nextValue)}
                            />
                          </BodyCell>
                        )
                      }

                      return (
                        <BodyCell key={`${item.id}-template-amount`} align="center" className="px-1.5 py-1.5">
                          <CompactNumberInput
                            value={value?.amount ?? 0}
                            min={0}
                            step="any"
                            size="xs"
                            align="center"
                            className="mx-auto max-w-[80px]"
                            onChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'amount', nextValue)}
                          />
                        </BodyCell>
                      )
                    })}
                  </tr>

                  {props.months.map((month) => (
                    <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                      <BodyCell align="left" className="px-2 py-1.5">
                        <MonthResetCell
                          label={month.label}
                          resetLabel={`恢复${month.label}专项默认值`}
                          onReset={() => props.onResetMonthFromTemplate(month.id, 'special')}
                        />
                      </BodyCell>
                      {orderedStageCostItems.map((item) => {
                        const value = getStageValue(month.specialCosts, item.id)
                        const templateValue = getStageValue(props.template.specialCosts, item.id)

                        if (item.mode === 'perEvent') {
                          return (
                            <BodyCell key={`${month.id}-${item.id}-event`} align="center" className="px-1.5 py-1.5">
                              <EventCostCell
                                amount={value?.amount ?? 0}
                                count={value?.count ?? 0}
                                onAmountChange={(nextValue) =>
                                  props.onMonthStageCostChange(month.id, item.id, 'amount', nextValue)
                                }
                                onCountChange={(nextValue) =>
                                  props.onMonthStageCostChange(month.id, item.id, 'count', nextValue)
                                }
                              />
                            </BodyCell>
                          )
                        }

                        if (item.mode === 'perUnit') {
                          return (
                            <BodyCell key={`${month.id}-${item.id}-factor`} align="center" className="px-1.5 py-1.5">
                              <PerUnitCostCell
                                amount={templateValue?.amount ?? 0}
                                factor={getPerUnitFactor(templateValue?.amount ?? 0, value?.amount ?? 0)}
                                onFactorChange={(nextValue) =>
                                  props.onMonthStageCostChange(
                                    month.id,
                                    item.id,
                                    'amount',
                                    (templateValue?.amount ?? 0) * nextValue,
                                  )
                                }
                              />
                            </BodyCell>
                          )
                        }

                        return (
                          <BodyCell key={`${month.id}-${item.id}-amount`} align="center" className="px-1.5 py-1.5">
                            <CompactNumberInput
                              value={value?.amount ?? 0}
                              min={0}
                              step="any"
                              size="xs"
                              align="center"
                              className="mx-auto max-w-[80px]"
                              onChange={(nextValue) => props.onMonthStageCostChange(month.id, item.id, 'amount', nextValue)}
                            />
                          </BodyCell>
                        )
                      })}
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
