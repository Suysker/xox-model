import { Coins } from 'lucide-react'
import { formatCurrency } from '../../lib/format'
import type { ModelConfig } from '../../types'
import { NumberField, Panel, SectionTitle, StatCard } from '../common/ui'

type OperatingNumberKey = keyof ModelConfig['operating']

export function OperatingWorkbench(props: {
  operating: ModelConfig['operating']
  onChange: (key: OperatingNumberKey, value: number) => void
}) {
  const baseCostPerEvent =
    props.operating.perEventOperatingCost + props.operating.materialCostPerUnit * 100

  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="Inputs"
        title="经营底盘"
        description="这里定义团的底层经济引擎。固定成本、场次成本和按张耗材分开录入，后面每个月只需要调整排期和专项支出。"
      />
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <NumberField
          label="前期已投入"
          helper="已经花出去但尚未回收的启动资金。"
          value={props.operating.initialInvestment}
          step={1000}
          min={0}
          suffix="元"
          onChange={(value) => props.onChange('initialInvestment', value)}
        />
        <NumberField
          label="单张售价"
          helper="默认按对话中的 88 元。"
          value={props.operating.unitPrice}
          step={1}
          min={0}
          suffix="元"
          onChange={(value) => props.onChange('unitPrice', value)}
        />
        <NumberField
          label="基础固定成本 / 月"
          helper="例如设备、场地摊销、行政费用。"
          value={props.operating.monthlyFixedCost}
          step={100}
          min={0}
          suffix="元"
          onChange={(value) => props.onChange('monthlyFixedCost', value)}
        />
        <NumberField
          label="基础场次成本 / 场"
          helper="例如每场固定发生的运营费用。"
          value={props.operating.perEventOperatingCost}
          step={100}
          min={0}
          suffix="元"
          onChange={(value) => props.onChange('perEventOperatingCost', value)}
        />
        <NumberField
          label="耗材成本 / 张"
          helper="例如拍立得、周边耗材。"
          value={props.operating.materialCostPerUnit}
          step={1}
          min={0}
          suffix="元"
          onChange={(value) => props.onChange('materialCostPerUnit', value)}
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="前期资金池" value={formatCurrency(props.operating.initialInvestment)} />
        <StatCard label="每百张耗材" value={formatCurrency(props.operating.materialCostPerUnit * 100)} />
        <StatCard label="每场基础支出参考" value={formatCurrency(baseCostPerEvent)} />
      </div>
    </Panel>
  )
}
