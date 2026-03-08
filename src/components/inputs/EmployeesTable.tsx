import { BriefcaseBusiness, Plus, Trash2 } from 'lucide-react'
import type { Employee } from '../../types'
import { CompactNumberInput, HeaderCell, Panel, SectionTitle } from '../common/ui'
import { formatCurrency } from '../../lib/format'

export function EmployeesTable(props: {
  employees: Employee[]
  onAdd: () => void
  onNameChange: (id: string, value: string) => void
  onRoleChange: (id: string, value: string) => void
  onBasePayChange: (id: string, value: number) => void
  onPerEventCostChange: (id: string, value: number) => void
  onRemove: (id: string) => void
}) {
  const monthlyPayroll = props.employees.reduce((sum, employee) => sum + employee.monthlyBasePay, 0)
  const perEventPayroll = props.employees.reduce((sum, employee) => sum + employee.perEventCost, 0)

  return (
    <Panel>
      <SectionTitle
        icon={BriefcaseBusiness}
        eyebrow="Inputs"
        title="运营员工配置"
        description="员工和成员分开建模。这里录场务、执行、助理等不直接卖张、但会跟月薪或场次挂钩的人力成本。"
        aside={
          <button
            type="button"
            onClick={props.onAdd}
            className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
          >
            <Plus className="h-4 w-4" />
            添加员工
          </button>
        }
      />

      <div className="mt-5 flex flex-wrap gap-3">
        <SummaryPill label="员工数量" value={`${props.employees.length} 人`} />
        <SummaryPill label="月固定人力" value={formatCurrency(monthlyPayroll)} />
        <SummaryPill label="单场员工成本" value={formatCurrency(perEventPayroll)} />
      </div>

      <div className="mt-5 overflow-x-auto rounded-[24px] border border-stone-900/10 bg-white">
        <table className="min-w-[540px] w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[132px]" />
            <col className="w-[128px]" />
            <col className="w-[110px]" />
            <col className="w-[110px]" />
            <col className="w-[56px]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell>员工</HeaderCell>
              <HeaderCell>岗位</HeaderCell>
              <HeaderCell align="center">月薪/月</HeaderCell>
              <HeaderCell align="center">场次成本/场</HeaderCell>
              <HeaderCell align="center">删</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.employees.map((employee) => (
              <tr key={employee.id} className="border-b border-stone-900/10 last:border-none">
                <td className="px-3 py-2.5">
                  <input
                    className="h-9 w-full rounded-lg border border-stone-900/10 bg-stone-50 px-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={employee.name}
                    onChange={(event) => props.onNameChange(employee.id, event.target.value)}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <input
                    className="h-9 w-full rounded-lg border border-stone-900/10 bg-stone-50 px-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={employee.role}
                    onChange={(event) => props.onRoleChange(employee.id, event.target.value)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={employee.monthlyBasePay}
                    min={0}
                    step={100}
                    size="sm"
                    align="right"
                    onChange={(value) => props.onBasePayChange(employee.id, value)}
                  />
                </td>
                <td className="px-2 py-2.5">
                  <CompactNumberInput
                    value={employee.perEventCost}
                    min={0}
                    step={50}
                    size="sm"
                    align="right"
                    onChange={(value) => props.onPerEventCostChange(employee.id, value)}
                  />
                </td>
                <td className="px-2 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => props.onRemove(employee.id)}
                    aria-label={`删除 ${employee.name}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-600 transition hover:bg-stone-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {props.employees.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-stone-500">
                  当前还没有员工配置。需要录入场务、助理或执行人员时，在这里补上。
                </td>
              </tr>
            ) : null}
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
