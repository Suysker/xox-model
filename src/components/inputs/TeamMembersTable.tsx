import { Plus, Users } from 'lucide-react'
import type { EmploymentType, ScenarioKey, TeamMember } from '../../types'
import { cx } from '../../lib/format'
import { formatDecimal } from '../../lib/format'
import { BodyCell, CompactNumberInput, HeaderCell, Panel, SectionTitle, StatCard } from '../common/ui'

const employmentOptions: Array<{ label: string; value: EmploymentType }> = [
  { label: '底薪成员', value: 'salary' },
  { label: '兼职成员', value: 'partTime' },
]

const scenarioOrder: ScenarioKey[] = ['pessimistic', 'base', 'optimistic']

export function TeamMembersTable(props: {
  members: TeamMember[]
  onAdd: () => void
  onNameChange: (id: string, value: string) => void
  onEmploymentTypeChange: (id: string, value: EmploymentType) => void
  onCommissionChange: (id: string, value: number) => void
  onBasePayChange: (id: string, value: number) => void
  onAllowanceChange: (id: string, value: number) => void
  onUnitsChange: (id: string, key: ScenarioKey, value: number) => void
  onRemove: (id: string) => void
}) {
  const salariedCount = props.members.filter((member) => member.employmentType === 'salary').length
  const baseUnitsPerEvent = props.members.reduce((sum, member) => sum + member.unitsPerEvent.base, 0)

  return (
    <Panel>
      <SectionTitle
        icon={Users}
        eyebrow="Inputs"
        title="团队成员假设"
        description="成员是收入引擎。这里直接按成员录入提成、底薪、场补，以及悲观 / 基准 / 乐观的单场张数。"
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

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="成员数量" value={`${props.members.length} 人`} />
        <StatCard label="底薪成员" value={`${salariedCount} 人`} />
        <StatCard label="基准单场合计" value={`${formatDecimal(baseUnitsPerEvent)} 张`} />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-[860px] w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-stone-100 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell rowSpan={2}>成员</HeaderCell>
              <HeaderCell rowSpan={2}>类型</HeaderCell>
              <HeaderCell rowSpan={2}>提成</HeaderCell>
              <HeaderCell rowSpan={2}>底薪 / 月</HeaderCell>
              <HeaderCell rowSpan={2}>场补 / 场</HeaderCell>
              <HeaderCell colSpan={3} align="center">
                单场张数假设
              </HeaderCell>
              <HeaderCell rowSpan={2} align="right">
                操作
              </HeaderCell>
            </tr>
            <tr className="border-b border-stone-900/10">
              <HeaderCell>悲观</HeaderCell>
              <HeaderCell>基准</HeaderCell>
              <HeaderCell>乐观</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.members.map((member) => (
              <tr key={member.id} className="border-b border-stone-900/10 last:border-none">
                <BodyCell className="min-w-36">
                  <input
                    className="h-10 w-full rounded-xl border border-stone-900/10 bg-stone-50 px-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={member.name}
                    onChange={(event) => props.onNameChange(member.id, event.target.value)}
                  />
                </BodyCell>
                <BodyCell className="min-w-32">
                  <select
                    className={cx(
                      'h-10 w-full rounded-xl border px-3 text-sm font-medium outline-none transition focus:bg-white',
                      member.employmentType === 'salary'
                        ? 'border-amber-200 bg-amber-50 text-amber-800 focus:border-amber-400'
                        : 'border-sky-200 bg-sky-50 text-sky-800 focus:border-sky-400',
                    )}
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
                </BodyCell>
                <BodyCell>
                  <CompactNumberInput
                    value={member.commissionRate * 100}
                    min={0}
                    max={100}
                    step="any"
                    suffix="%"
                    onChange={(value) => props.onCommissionChange(member.id, value / 100)}
                  />
                </BodyCell>
                <BodyCell>
                  <CompactNumberInput
                    value={member.monthlyBasePay}
                    min={0}
                    step={100}
                    suffix="元"
                    onChange={(value) => props.onBasePayChange(member.id, value)}
                  />
                </BodyCell>
                <BodyCell>
                  <CompactNumberInput
                    value={member.eventAllowance}
                    min={0}
                    step={50}
                    suffix="元"
                    onChange={(value) => props.onAllowanceChange(member.id, value)}
                  />
                </BodyCell>
                {scenarioOrder.map((key) => (
                  <BodyCell key={key}>
                    <CompactNumberInput
                      value={member.unitsPerEvent[key]}
                      min={0}
                      step={1}
                      suffix="张"
                      onChange={(value) => props.onUnitsChange(member.id, key, value)}
                    />
                  </BodyCell>
                ))}
                <BodyCell align="right">
                  <button
                    type="button"
                    onClick={() => props.onRemove(member.id)}
                    disabled={props.members.length === 1}
                    className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    删除
                  </button>
                </BodyCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
