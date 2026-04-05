import { BriefcaseBusiness, Plus, Trash2 } from 'lucide-react'
import type { Employee } from '../../types'
import { CompactNumberInput, HeaderCell, InlineStatPill, Panel, SectionTitle } from '../common/ui'
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
        eyebrow="输入"
        title="运营员工配置"
        aside={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <InlineStatPill label="员工数量" value={`${props.employees.length} 人`} className="min-w-[150px]" />
            <InlineStatPill label="月固定人力" value={formatCurrency(monthlyPayroll)} className="min-w-[188px]" />
            <InlineStatPill label="单场员工成本" value={formatCurrency(perEventPayroll)} className="min-w-[196px]" />
            <button
              type="button"
              onClick={props.onAdd}
              className="inline-flex h-[54px] items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-5 text-sm font-medium text-white transition hover:bg-stone-800"
            >
              <Plus className="h-4 w-4" />
              添加员工
            </button>
          </div>
        }
      />

      <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-white">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[132px]" />
            <col className="w-[128px]" />
            <col className="w-[110px]" />
            <col className="w-[110px]" />
            <col className="w-[56px]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell align="center" className="px-2 py-2 text-[11px]">员工</HeaderCell>
              <HeaderCell align="center" className="px-2 py-2 text-[11px]">岗位</HeaderCell>
              <HeaderCell align="center" className="px-2 py-2 text-[11px]">月薪/月</HeaderCell>
              <HeaderCell align="center" className="px-2 py-2 text-[11px]">场次成本/场</HeaderCell>
              <HeaderCell align="center" className="px-2 py-2 text-[11px]">删</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.employees.map((employee) => (
              <tr key={employee.id} className="border-b border-stone-900/10 last:border-none">
                <td className="px-2 py-1.5 text-center">
                  <input
                    className="h-8 w-full rounded-md border border-stone-900/10 bg-stone-50 px-2.5 text-center text-[11px] font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={employee.name}
                    onChange={(event) => props.onNameChange(employee.id, event.target.value)}
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    className="h-8 w-full rounded-md border border-stone-900/10 bg-stone-50 px-2.5 text-center text-[11px] font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
                    value={employee.role}
                    onChange={(event) => props.onRoleChange(employee.id, event.target.value)}
                  />
                </td>
                <td className="px-1.5 py-1.5">
                  <CompactNumberInput
                    value={employee.monthlyBasePay}
                    min={0}
                    step={100}
                    size="xs"
                    align="center"
                    onChange={(value) => props.onBasePayChange(employee.id, value)}
                  />
                </td>
                <td className="px-1.5 py-1.5">
                  <CompactNumberInput
                    value={employee.perEventCost}
                    min={0}
                    step={50}
                    size="xs"
                    align="center"
                    onChange={(value) => props.onPerEventCostChange(employee.id, value)}
                  />
                </td>
                <td className="px-1.5 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => props.onRemove(employee.id)}
                    aria-label={`删除 ${employee.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-600 transition hover:bg-stone-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
