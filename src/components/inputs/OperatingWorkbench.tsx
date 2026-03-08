import { CalendarRange, Coins } from 'lucide-react'
import { monthLabelOptions } from '../../lib/defaults'
import type { ModelConfig, PlanningConfig } from '../../types'
import { CompactNumberInput, NumberField, Panel, SectionTitle } from '../common/ui'

type OperatingNumberKey = keyof ModelConfig['operating']
type PlanningKey = keyof PlanningConfig

export function OperatingWorkbench(props: {
  operating: ModelConfig['operating']
  planning: PlanningConfig
  onOperatingChange: (key: OperatingNumberKey, value: number) => void
  onPlanningChange: (key: PlanningKey, value: number) => void
}) {
  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="Inputs"
        title="经营底盘"
        description="这里只放长期假设：前期投入、单价、固定成本、场次成本、耗材，以及经营从几月开始、规划多少期。月度排期页只做默认基线和月度曲线覆盖。"
      />

      <div className="mt-6 grid gap-6">
        <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-stone-900/10 bg-white p-3 text-stone-900">
              <Coins className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-stone-950">资金与单价</h3>
              <p className="mt-1 text-sm leading-6 text-stone-600">这些是整套模型的基础口径，不需要再看重复换算卡片。</p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <NumberField
              label="前期已投入"
              helper="已经花出去但尚未回收的启动资金。"
              value={props.operating.initialInvestment}
              step={1000}
              min={0}
              suffix="元"
              onChange={(value) => props.onOperatingChange('initialInvestment', value)}
            />
            <NumberField
              label="单张售价"
              helper="默认按对话中的 88 元。"
              value={props.operating.unitPrice}
              step={1}
              min={0}
              suffix="元"
              onChange={(value) => props.onOperatingChange('unitPrice', value)}
            />
            <NumberField
              label="基础固定成本 / 月"
              helper="例如设备、场地摊销、行政费用。"
              value={props.operating.monthlyFixedCost}
              step={100}
              min={0}
              suffix="元"
              onChange={(value) => props.onOperatingChange('monthlyFixedCost', value)}
            />
            <NumberField
              label="基础场次成本 / 场"
              helper="例如每场固定发生的运营费用。"
              value={props.operating.perEventOperatingCost}
              step={100}
              min={0}
              suffix="元"
              onChange={(value) => props.onOperatingChange('perEventOperatingCost', value)}
            />
            <NumberField
              label="耗材成本 / 张"
              helper="例如拍立得、周边耗材。"
              value={props.operating.materialCostPerUnit}
              step={1}
              min={0}
              suffix="元"
              onChange={(value) => props.onOperatingChange('materialCostPerUnit', value)}
            />
          </div>
        </section>

        <section className="rounded-[24px] border border-stone-900/10 bg-white p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-stone-900/10 bg-stone-950 p-3 text-amber-100">
              <CalendarRange className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-stone-950">经营周期</h3>
              <p className="mt-1 text-sm leading-6 text-stone-600">先定起始月份和规划期数，下面的月度排期就按这个周期生成。</p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-[220px_240px_1fr]">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-800">经营开始月份</span>
              <select
                className="h-11 rounded-2xl border border-stone-900/10 bg-stone-100/80 px-4 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                value={props.planning.startMonth}
                onChange={(event) => props.onPlanningChange('startMonth', Number(event.target.value))}
              >
                {monthLabelOptions.map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-800">规划月数</span>
              <div className="flex items-center gap-2">
                <CompactNumberInput
                  value={props.planning.horizonMonths}
                  min={1}
                  max={24}
                  step={1}
                  suffix="月"
                  onChange={(value) => props.onPlanningChange('horizonMonths', value)}
                />
                <button
                  type="button"
                  onClick={() => props.onPlanningChange('horizonMonths', props.planning.horizonMonths + 6)}
                  className="h-10 rounded-xl border border-stone-900/10 bg-white px-3 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
                >
                  +6 月
                </button>
              </div>
            </label>

            <div className="rounded-[18px] border border-stone-900/10 bg-stone-50/80 px-4 py-3 text-sm leading-7 text-stone-600">
              经营底盘决定模型周期，月度排期里会先给你一条默认基线；你调完后同步默认，再只改少数例外月份。
            </div>
          </div>
        </section>
      </div>
    </Panel>
  )
}
