import { Plus, Trash2, Users } from 'lucide-react'
import type { EmploymentType, ScenarioKey } from '../../types'
import { CompactNumberInput, HeaderCell, Panel, SectionTitle } from '../common/ui'
import { formatCurrency, formatDecimal } from '../../lib/format'

const employmentOptions: Array<{ label: string; value: EmploymentType }> = [
  { label: '底薪', value: 'salary' },
  { label: '兼职', value: 'partTime' },
]

const scenarioOrder: ScenarioKey[] = ['pessimistic', 'base', 'optimistic']

type TeamMembersTableProps = {
  members: Array<{
    id: string
    name: string
    employmentType: EmploymentType
    commissionRate: number
    monthlyBasePay: number
    perEventTravelCost: number
    departureMonthIndex: number | null
    unitsPerEvent: Record<ScenarioKey, number>
  }>
  cycleMonths: Array<{ label: string; value: number }>
  onAdd: () => void
  onNameChange: (id: string, value: string) => void
  onEmploymentTypeChange: (id: string, value: EmploymentType) => void
  onCommissionChange: (id: string, value: number) => void
  onBasePayChange: (id: string, value: number) => void
  onTravelCostChange: (id: string, value: number) => void
  onDepartureMonthChange: (id: string, value: number | null) => void
  onUnitsChange: (id: string, key: ScenarioKey, value: number) => void
  onRemove: (id: string) => void
}

export function TeamMembersTable(props: TeamMembersTableProps) {
  const salariedCount = props.members.filter((member) => member.employmentType === 'salary').length
  const baseUnitsPerEvent = props.members.reduce((sum, member) => sum + member.unitsPerEvent.base, 0)
  const totalTravel = props.members.reduce((sum, member) => sum + member.perEventTravelCost, 0)
  const departureMonthOptions = [
    { label: '在团', value: '' },
    ...props.cycleMonths.map((month) => ({
      label: `做到${month.label}`,
      value: String(month.value),
    })),
  ]

  return (
    <Panel>
      <SectionTitle
        icon={Users}
        eyebrow="输入"
        title="团队成员假设"
        description="这里只录偶像成员本身的收入参数。员工场补和执行成本已经拆到下面的员工配置，不再混在成员表里。"
        aside={
          <button
            type="button"
            onClick={props.onAdd}
            className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
          >
            <Plus className="h-4 w-4" />
            添加成员
          </button>
        }
      />

      <div className="mt-5 flex flex-wrap gap-3">
        <SummaryPill label="成员数量" value={`${props.members.length} 人`} />
        <SummaryPill label="底薪成员" value={`${salariedCount} 人`} />
        <SummaryPill label="基准单场合计" value={`${formatDecimal(baseUnitsPerEvent)} 张`} />
        <SummaryPill label="成员路费 / 场" value={formatCurrency(totalTravel)} />
      </div>

      <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-white">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[6%]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell rowSpan={2} align="center">
                成员
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                类型
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                提成 %
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                底薪 / 月
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                路费 / 场
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                离团至
              </HeaderCell>
              <HeaderCell colSpan={3} align="center">
                单场张数
              </HeaderCell>
              <HeaderCell rowSpan={2} align="center">
                删
              </HeaderCell>
            </tr>
            <tr className="border-b border-stone-900/10">
              <HeaderCell align="center">悲</HeaderCell>
              <HeaderCell align="center">基</HeaderCell>
              <HeaderCell align="center">乐</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.members.map((member) => (
              <tr key={member.id} className="border-b border-stone-900/10 last:border-none">
                <td className="px-3 py-2.5 text-center">
                  <input
                    className="h-9 w-full rounded-lg border border-stone-900/10 bg-stone-50 px-3 text-center text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={member.name}
                    onChange={(event) => props.onNameChange(member.id, event.target.value)}
                  />
                </td>
                <td className="px-2 py-2.5 text-center">
                  <select
                    className={
                      member.employmentType === 'salary'
                        ? 'h-9 w-full rounded-lg border border-amber-200 bg-amber-50 px-2 text-center text-sm font-semibold text-amber-800 outline-none transition focus:border-amber-400'
                        : 'h-9 w-full rounded-lg border border-sky-200 bg-sky-50 px-2 text-center text-sm font-semibold text-sky-800 outline-none transition focus:border-sky-400'
                    }
                    value={member.employmentType}
                    onChange={(event) =>
                      props.onEmploymentTypeChange(member.id, event.target.value as EmploymentType)
                    }
                  >
                    {employmentOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={member.commissionRate * 100}
                    min={0}
                    max={100}
                    step="any"
                    size="sm"
                    align="center"
                    onChange={(value) => props.onCommissionChange(member.id, value / 100)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={member.monthlyBasePay}
                    min={0}
                    step={100}
                    size="sm"
                    align="center"
                    onChange={(value) => props.onBasePayChange(member.id, value)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={member.perEventTravelCost}
                    min={0}
                    step={100}
                    size="sm"
                    align="center"
                    onChange={(value) => props.onTravelCostChange(member.id, value)}
                  />
                </td>
                <td className="px-2 py-2.5 text-center">
                  <select
                    className="h-9 w-full rounded-lg border border-stone-900/10 bg-stone-50 px-2 text-center text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={member.departureMonthIndex === null ? '' : String(member.departureMonthIndex)}
                    onChange={(event) =>
                      props.onDepartureMonthChange(
                        member.id,
                        event.target.value === '' ? null : Number(event.target.value),
                      )
                    }
                  >
                    {departureMonthOptions.map((option) => (
                      <option key={option.label} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
                {scenarioOrder.map((key) => (
                  <td key={key} className="px-2 py-2.5">
                    <CompactNumberInput
                      value={member.unitsPerEvent[key]}
                      min={0}
                      step={1}
                      size="sm"
                      align="center"
                      onChange={(value) => props.onUnitsChange(member.id, key, value)}
                    />
                  </td>
                ))}
                <td className="px-2 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => props.onRemove(member.id)}
                    disabled={props.members.length === 1}
                    aria-label={`删除 ${member.name}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SummaryPill(props: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-[160px] rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className="mt-1.5 text-lg font-bold text-stone-950">{props.value}</p>
    </div>
  )
}
