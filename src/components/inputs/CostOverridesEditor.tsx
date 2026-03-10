import { Plus, Receipt, RefreshCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ModelConfig, MonthlyPlan, MonthlyPlanTemplate, StageCostMode } from '../../types'
import { BodyCell, CompactNumberInput, HeaderCell, Panel, SectionTitle, SegmentTabs } from '../common/ui'

type CostTab = 'training' | 'special'
type TrainingNumberKey =
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'
  | 'extraPerEventCost'
  | 'extraFixedCost'

const trainingColumns: Array<{ key: TrainingNumberKey; label: string; step: number | 'any' }> = [
  { key: 'rehearsalCount', label: '排练次数', step: 1 },
  { key: 'rehearsalCost', label: '排练单价', step: 50 },
  { key: 'teacherCount', label: '老师次数', step: 1 },
  { key: 'teacherCost', label: '老师单价', step: 50 },
  { key: 'extraPerEventCost', label: '额外每场', step: 100 },
  { key: 'extraFixedCost', label: '额外固定', step: 100 },
]

const stageModeOrder: Record<StageCostMode, number> = {
  perUnit: 0,
  perEvent: 1,
  monthly: 2,
}

function getStageHeaderLabel(mode: StageCostMode) {
  if (mode === 'perEvent') {
    return '单价 / 场次'
  }

  if (mode === 'perUnit') {
    return '单价 / 系数'
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
    <div className="mx-auto grid max-w-[114px] grid-cols-[1fr_auto_40px] items-center gap-1">
      <CompactNumberInput
        value={props.amount}
        min={0}
        step="any"
        size="sm"
        align="center"
        className="w-full"
        onChange={props.onAmountChange}
      />
      <span className="text-xs font-semibold text-stone-400">/</span>
      <CompactNumberInput
        value={props.count}
        min={0}
        step={1}
        size="sm"
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
    <div className="mx-auto grid max-w-[120px] grid-cols-[1fr_auto_44px] items-center gap-1">
      {props.onAmountChange ? (
        <CompactNumberInput
          value={props.amount}
          min={0}
          step="any"
          size="sm"
          align="center"
          className="w-full"
          onChange={props.onAmountChange}
        />
      ) : (
        <div className="flex h-9 items-center justify-center rounded-lg border border-stone-900/10 bg-stone-50 px-2.5 text-sm font-medium text-stone-500">
          {formatSplitValue(props.amount)}
        </div>
      )}
      <span className="text-xs font-semibold text-stone-400">/</span>
      {props.onFactorChange ? (
        <CompactNumberInput
          value={props.factor}
          min={0}
          max={1}
          step={0.05}
          size="sm"
          align="center"
          className="w-full"
          onChange={(value) => props.onFactorChange?.(clampUnitFactor(value))}
        />
      ) : (
        <div className="flex h-9 items-center justify-center rounded-lg border border-stone-900/10 bg-stone-50 px-2 text-sm font-medium text-stone-500">
          {formatSplitValue(props.factor)}
        </div>
      )}
    </div>
  )
}

export function CostOverridesEditor(props: {
  template: MonthlyPlanTemplate
  months: MonthlyPlan[]
  stageCostItems: ModelConfig['stageCostItems']
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
  const [tab, setTab] = useState<CostTab>('training')
  const orderedStageCostItems = props.stageCostItems
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const modeGap = stageModeOrder[left.item.mode] - stageModeOrder[right.item.mode]
      return modeGap !== 0 ? modeGap : left.index - right.index
    })
    .map((entry) => entry.item)

  return (
    <Panel>
      <SectionTitle
        icon={Receipt}
        eyebrow="Inputs"
        title="阶段成本与月度差异"
        description="训练成本继续按月份维护；专项成本收成一张表，直接新增列、改名称、改费用类型，再按默认和月份录入。"
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
                        onChange={(value) => props.onTrainingTemplateChange(column.key, value)}
                      />
                    </BodyCell>
                  ))}
                  <BodyCell align="center" className="text-xs font-semibold text-stone-400">
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
                          onChange={(value) => props.onTrainingMonthChange(month.id, column.key, value)}
                        />
                      </BodyCell>
                    ))}
                    <BodyCell align="center">
                      <button
                        type="button"
                        onClick={() => props.onResetMonthFromTemplate(month.id, 'training')}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-700 transition hover:bg-stone-100"
                        aria-label={`恢复${month.label}训练默认值`}
                        title={`恢复${month.label}训练默认值`}
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
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
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-stone-950">专项与耗材表</h3>
              <p className="mt-1 text-sm leading-6 text-stone-600">
                每一列就是一个成本项。列头可直接改名称和费用类型；按月只录金额，按场在同一格里录单价和场次，按张在同一格里录单价和系数。
              </p>
            </div>
            <button
              type="button"
              onClick={props.onStageCostItemAdd}
              className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
            >
              <Plus className="h-4 w-4" />
              添加成本列
            </button>
          </div>

          <div className="mt-4 rounded-[20px] border border-stone-900/10">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[92px]" />
                {orderedStageCostItems.map((item) => (
                  <col key={`${item.id}-column`} className="w-[138px]" />
                ))}
                <col className="w-[84px]" />
              </colgroup>

              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell align="center" rowSpan={2}>
                    月份
                  </HeaderCell>
                  {orderedStageCostItems.map((item) => (
                    <th
                      key={item.id}
                      className="border-l border-stone-900/10 px-2 py-2 align-top"
                    >
                      <div className="grid gap-2">
                        <input
                          type="text"
                          value={item.name}
                          placeholder="成本名称"
                          onChange={(event) => props.onStageCostItemNameChange(item.id, event.target.value)}
                          className="h-9 min-w-0 rounded-lg border border-stone-900/10 bg-white px-2.5 text-center text-xs font-semibold text-stone-900 outline-none transition focus:border-emerald-500"
                        />
                        <div className="grid grid-cols-[1fr_30px] gap-1.5">
                          <select
                            value={item.mode}
                            onChange={(event) =>
                              props.onStageCostItemModeChange(item.id, event.target.value as StageCostMode)
                            }
                            className="h-8 rounded-lg border border-stone-900/10 bg-white px-2 text-center text-[11px] font-semibold text-stone-700 outline-none transition focus:border-emerald-500"
                          >
                            <option value="monthly">按月</option>
                            <option value="perEvent">按场</option>
                            <option value="perUnit">按张</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => props.onStageCostItemRemove(item.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
                            aria-label={`删除${item.name}`}
                            title={`删除${item.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </th>
                  ))}
                  <HeaderCell align="center" rowSpan={2}>
                    恢复
                  </HeaderCell>
                </tr>
                <tr className="border-b border-stone-900/10">
                  {orderedStageCostItems.map((item) => (
                    <HeaderCell key={`${item.id}-detail`} align="center">
                      {getStageHeaderLabel(item.mode)}
                    </HeaderCell>
                  ))}
                </tr>
              </thead>

              <tbody>
                <tr className="border-b border-stone-900/10 bg-amber-50/60">
                  <BodyCell align="center" className="font-semibold text-amber-900">
                    默认
                  </BodyCell>
                  {orderedStageCostItems.map((item) => {
                    const value = getStageValue(props.template.specialCosts, item.id)

                    if (item.mode === 'perEvent') {
                      return (
                        <BodyCell key={`${item.id}-template-event`} align="center">
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
                        <BodyCell key={`${item.id}-template-unit`} align="center">
                          <PerUnitCostCell
                            amount={value?.amount ?? 0}
                            factor={1}
                            onAmountChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'amount', nextValue)}
                          />
                        </BodyCell>
                      )
                    }

                    return (
                      <BodyCell key={`${item.id}-template-amount`} align="center">
                        <CompactNumberInput
                          value={value?.amount ?? 0}
                          min={0}
                          step="any"
                          size="sm"
                          align="center"
                          className="mx-auto max-w-[96px]"
                          onChange={(nextValue) => props.onTemplateStageCostChange(item.id, 'amount', nextValue)}
                        />
                      </BodyCell>
                    )
                  })}
                  <BodyCell align="center" className="text-xs font-semibold text-stone-400">
                    --
                  </BodyCell>
                </tr>

                {props.months.map((month) => (
                  <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                    <BodyCell align="center" className="font-semibold text-stone-900">
                      {month.label}
                    </BodyCell>
                    {orderedStageCostItems.map((item) => {
                      const value = getStageValue(month.specialCosts, item.id)
                      const templateValue = getStageValue(props.template.specialCosts, item.id)

                      if (item.mode === 'perEvent') {
                        return (
                          <BodyCell key={`${month.id}-${item.id}-event`} align="center">
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
                          <BodyCell key={`${month.id}-${item.id}-factor`} align="center">
                            <PerUnitCostCell
                              amount={templateValue?.amount ?? 0}
                              factor={getPerUnitFactor(templateValue?.amount ?? 0, value?.amount ?? 0)}
                              onFactorChange={(nextValue) =>
                                props.onMonthStageCostChange(month.id, item.id, 'amount', (templateValue?.amount ?? 0) * nextValue)
                              }
                            />
                          </BodyCell>
                        )
                      }

                      return (
                        <BodyCell key={`${month.id}-${item.id}-amount`} align="center">
                          <CompactNumberInput
                            value={value?.amount ?? 0}
                            min={0}
                            step="any"
                            size="sm"
                            align="center"
                            className="mx-auto max-w-[96px]"
                            onChange={(nextValue) => props.onMonthStageCostChange(month.id, item.id, 'amount', nextValue)}
                          />
                        </BodyCell>
                      )
                    })}
                    <BodyCell align="center">
                      <button
                        type="button"
                        onClick={() => props.onResetMonthFromTemplate(month.id, 'special')}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-700 transition hover:bg-stone-100"
                        aria-label={`恢复${month.label}专项默认值`}
                        title={`恢复${month.label}专项默认值`}
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
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
