import { Coins } from 'lucide-react'
import { formatCurrency } from '../../lib/format'
import type { Employee, ModelConfig, TeamMember } from '../../types'
import { CompactNumberInput, Panel, SectionTitle } from '../common/ui'

type OperatingNumberKey = keyof ModelConfig['operating']

export function CostWorkbench(props: {
  operating: ModelConfig['operating']
  teamMembers: TeamMember[]
  employees: Employee[]
  onOperatingChange: (key: OperatingNumberKey, value: number) => void
}) {
  const memberMonthlyPayroll = props.teamMembers.reduce((sum, member) => sum + member.monthlyBasePay, 0)
  const employeeMonthlyPayroll = props.employees.reduce((sum, employee) => sum + employee.monthlyBasePay, 0)
  const memberTravelPerEvent = props.teamMembers.reduce((sum, member) => sum + member.perEventTravelCost, 0)
  const employeePerEvent = props.employees.reduce((sum, employee) => sum + employee.perEventCost, 0)

  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="Inputs"
        title="成本结构"
        description="先定义长期成本口径：每月固定、每场固定、每张成本。训练、新歌、VJ 等默认月度项在下方表格里统一维护。"
      />

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <CostBlock
          title="每月固定成本"
          description="行政、场地、设备等不随场次变化的固定口径。"
          summary={formatCurrency(props.operating.monthlyFixedCost)}
          value={props.operating.monthlyFixedCost}
          step={100}
          onChange={(value) => props.onOperatingChange('monthlyFixedCost', value)}
          hints={[
            `成员底薪合计：${formatCurrency(memberMonthlyPayroll)}`,
            `员工月薪合计：${formatCurrency(employeeMonthlyPayroll)}`,
          ]}
        />

        <CostBlock
          title="每场固定成本"
          description="每场都会发生的执行成本基线，不含成员路费和员工场次成本。"
          summary={formatCurrency(props.operating.perEventOperatingCost)}
          value={props.operating.perEventOperatingCost}
          step={100}
          onChange={(value) => props.onOperatingChange('perEventOperatingCost', value)}
          hints={[
            `成员路费 / 场：${formatCurrency(memberTravelPerEvent)}`,
            `员工执行 / 场：${formatCurrency(employeePerEvent)}`,
          ]}
        />

        <CostBlock
          title="每张成本"
          description="随着卖张量一起放大的耗材成本，例如拍立得相纸。"
          summary={`${formatCurrency(props.operating.materialCostPerUnit)}/张`}
          value={props.operating.materialCostPerUnit}
          step={1}
          onChange={(value) => props.onOperatingChange('materialCostPerUnit', value)}
          hints={[
            '是否计入耗材，在下方「专项与耗材」表里按月切换。',
            '月度表和经营明细会自动按卖张量放大这部分成本。',
          ]}
        />
      </div>
    </Panel>
  )
}

function CostBlock(props: {
  title: string
  description: string
  summary: string
  value: number
  step: number | 'any'
  onChange: (value: number) => void
  hints: string[]
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">{props.title}</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">{props.description}</p>
        </div>
        <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700">
          {props.summary}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_136px] items-center gap-3">
        <p className="text-sm font-medium text-stone-700">默认值</p>
        <CompactNumberInput
          value={props.value}
          min={0}
          step={props.step}
          size="sm"
          align="right"
          onChange={props.onChange}
        />
      </div>

      <div className="mt-4 grid gap-2">
        {props.hints.map((hint) => (
          <div key={hint} className="rounded-[16px] border border-stone-900/10 bg-white px-3 py-2 text-xs text-stone-500">
            {hint}
          </div>
        ))}
      </div>
    </section>
  )
}
