import { Coins, Plus, Trash2 } from 'lucide-react'
import { formatCurrency } from '../../lib/format'
import type { CostCategory, Employee, ModelConfig, TeamMember } from '../../types'
import { CompactNumberInput, Panel, SectionTitle } from '../common/ui'

type CostItemRow = ModelConfig['operating']['monthlyFixedCosts'][number]

export function CostWorkbench(props: {
  operating: ModelConfig['operating']
  teamMembers: TeamMember[]
  employees: Employee[]
  onCostItemAdd: (category: CostCategory) => void
  onCostItemRemove: (category: CostCategory, id: string) => void
  onCostItemNameChange: (category: CostCategory, id: string, value: string) => void
  onCostItemAmountChange: (category: CostCategory, id: string, value: number) => void
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
        description="这里维护长期基线成本项。按每月固定、每场固定、每张成本分别建项；成员和员工的工资、路费仍在各自模块里配置。"
      />

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <CostItemSection
          category="monthlyFixed"
          title="每月固定成本"
          description="不随场次变化的长期经营成本项。"
          summary={formatCurrency(sumCostItems(props.operating.monthlyFixedCosts))}
          items={props.operating.monthlyFixedCosts}
          systemHints={[
            `成员底薪另计：${formatCurrency(memberMonthlyPayroll)}`,
            `员工月薪另计：${formatCurrency(employeeMonthlyPayroll)}`,
          ]}
          onAdd={props.onCostItemAdd}
          onRemove={props.onCostItemRemove}
          onNameChange={props.onCostItemNameChange}
          onAmountChange={props.onCostItemAmountChange}
        />

        <CostItemSection
          category="perEvent"
          title="每场固定成本"
          description="每办一场就会发生一次的长期成本项。"
          summary={formatCurrency(sumCostItems(props.operating.perEventCosts))}
          items={props.operating.perEventCosts}
          systemHints={[
            `成员路费另计：${formatCurrency(memberTravelPerEvent)}/场`,
            `员工执行另计：${formatCurrency(employeePerEvent)}/场`,
          ]}
          onAdd={props.onCostItemAdd}
          onRemove={props.onCostItemRemove}
          onNameChange={props.onCostItemNameChange}
          onAmountChange={props.onCostItemAmountChange}
        />

        <CostItemSection
          category="perUnit"
          title="每张成本"
          description="随卖张量一起放大的长期耗材成本项。"
          summary={`${formatCurrency(sumCostItems(props.operating.perUnitCosts))}/张`}
          items={props.operating.perUnitCosts}
          systemHints={[
            '下方“专项与耗材表”会按每张录入各月份耗材口径，比如 0 或 6/张。',
          ]}
          onAdd={props.onCostItemAdd}
          onRemove={props.onCostItemRemove}
          onNameChange={props.onCostItemNameChange}
          onAmountChange={props.onCostItemAmountChange}
        />
      </div>
    </Panel>
  )
}

function CostItemSection(props: {
  category: CostCategory
  title: string
  description: string
  summary: string
  items: CostItemRow[]
  systemHints: string[]
  onAdd: (category: CostCategory) => void
  onRemove: (category: CostCategory, id: string) => void
  onNameChange: (category: CostCategory, id: string, value: string) => void
  onAmountChange: (category: CostCategory, id: string, value: number) => void
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">{props.title}</h3>
          <p className="mt-1 text-sm leading-6 text-stone-600">{props.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700">
            {props.summary}
          </span>
          <button
            type="button"
            onClick={() => props.onAdd(props.category)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 text-white transition hover:bg-stone-800"
            aria-label={`新增${props.title}`}
            title={`新增${props.title}`}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-[20px] border border-stone-900/10 bg-white">
        <div className="grid grid-cols-[minmax(0,1fr)_132px_48px] items-center gap-3 border-b border-stone-900/10 bg-stone-100/90 px-3.5 py-2.5">
          <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-stone-600">成本项</p>
          <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-stone-600">金额</p>
          <span />
        </div>

        {props.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-stone-500">还没有成本项，点击右上角加号新增。</div>
        ) : (
          props.items.map((item, index) => (
            <div
              key={item.id}
              className={index !== props.items.length - 1 ? 'border-b border-stone-900/10' : undefined}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_132px_48px] items-center gap-3 px-3.5 py-3">
                <input
                  type="text"
                  value={item.name}
                  placeholder="输入成本项名称"
                  onChange={(event) => props.onNameChange(props.category, item.id, event.target.value)}
                  className="h-10 min-w-0 rounded-xl border border-stone-900/10 bg-stone-50 px-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                />
                <CompactNumberInput
                  value={item.amount}
                  min={0}
                  step={1}
                  size="sm"
                  align="right"
                  className="w-full"
                  onChange={(value) => props.onAmountChange(props.category, item.id, value)}
                />
                <button
                  type="button"
                  onClick={() => props.onRemove(props.category, item.id)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
                  aria-label={`删除${item.name}`}
                  title={`删除${item.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {props.systemHints.map((hint) => (
          <div key={hint} className="rounded-[16px] border border-stone-900/10 bg-white px-3 py-2 text-xs text-stone-500">
            {hint}
          </div>
        ))}
      </div>
    </section>
  )
}

function sumCostItems(items: CostItemRow[]) {
  return items.reduce((sum, item) => sum + item.amount, 0)
}
