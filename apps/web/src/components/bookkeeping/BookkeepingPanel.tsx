import { Lock, LockOpen, Plus, ReceiptText, Trash2 } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'
import { formatCurrency, formatDateTime } from '../../lib/format'
import type { EntryResponse, PeriodResponse, SubjectResponse } from '../../lib/api'

type EntryFormState = {
  direction: 'income' | 'expense'
  amount: number
  counterparty: string
  description: string
  allocations: Array<{
    subjectKey: string
    amount: number
  }>
}

export function BookkeepingPanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  subjects: SubjectResponse[]
  entries: EntryResponse[]
  loading: boolean
  form: EntryFormState
  onSelectPeriod: (id: string) => void
  onFormChange: (next: Partial<Omit<EntryFormState, 'allocations'>>) => void
  onAllocationChange: (index: number, next: Partial<EntryFormState['allocations'][number]>) => void
  onAddAllocation: () => void
  onRemoveAllocation: (index: number) => void
  onSubmit: () => void
  onVoid: (entryId: string) => void
  onToggleLock: () => void
}) {
  const selectedPeriod = props.periods.find((period) => period.id === props.selectedPeriodId)
  const isLocked = selectedPeriod?.status === 'locked'
  const expectedType = props.form.direction === 'income' ? 'revenue' : 'cost'
  const filteredSubjects = props.subjects.filter((subject) => subject.subjectType === expectedType)
  const allocationTotal = props.form.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)
  const isAllocationValid =
    props.form.allocations.length > 0 &&
    props.form.allocations.every((allocation) => allocation.subjectKey && allocation.amount > 0) &&
    Math.abs(allocationTotal - props.form.amount) < 0.005

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={ReceiptText}
          eyebrow="记账"
          title="实际分录"
          description="按所选期间的预算科目录入实际收入和成本。"
        />

        <div className="mt-5 flex flex-wrap gap-2">
          {props.periods.map((period) => (
            <button
              key={period.id}
              type="button"
              onClick={() => props.onSelectPeriod(period.id)}
              className={
                props.selectedPeriodId === period.id
                  ? 'rounded-full border border-stone-950 bg-stone-950 px-4 py-2 text-sm font-semibold text-white'
                  : 'rounded-full border border-stone-900/10 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700'
              }
            >
              {period.monthLabel}
            </button>
          ))}
        </div>

        {selectedPeriod ? (
          <>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-stone-600">
                {isLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                {isLocked ? '已锁定期间' : '开放期间'}
              </div>
              <button
                type="button"
                onClick={props.onToggleLock}
                className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700"
              >
                {isLocked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {isLocked ? '解锁期间' : '锁定期间'}
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">计划收入</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.plannedRevenue)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">计划成本</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.plannedCost)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">实际收入</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.actualRevenue)}</p>
              </div>
              <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-stone-500">实际成本</p>
                <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.actualCost)}</p>
              </div>
            </div>
          </>
        ) : null}
      </Panel>

      <Panel>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">方向</span>
            <select
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
              value={props.form.direction}
              disabled={isLocked}
              onChange={(event) => props.onFormChange({ direction: event.target.value as 'income' | 'expense' })}
            >
              <option value="income">收入</option>
              <option value="expense">支出</option>
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">金额</span>
            <input
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
              type="number"
              min={0}
              step="0.01"
              disabled={isLocked}
              value={props.form.amount}
              onChange={(event) => props.onFormChange({ amount: Number(event.target.value) })}
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">对方单位</span>
            <input
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
              disabled={isLocked}
              value={props.form.counterparty}
              onChange={(event) => props.onFormChange({ counterparty: event.target.value })}
            />
          </label>

          <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-stone-500">分摊合计</p>
            <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(allocationTotal)}</p>
            <p className="mt-1 text-xs text-stone-500">
              分录金额 {formatCurrency(props.form.amount)} {isAllocationValid ? '已与分摊一致。' : '必须与分摊合计一致。'}
            </p>
          </div>
        </div>

        <label className="mt-4 grid gap-2">
          <span className="text-sm font-semibold text-stone-700">摘要说明</span>
          <textarea
            className="min-h-24 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 py-3 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
            disabled={isLocked}
            value={props.form.description}
            onChange={(event) => props.onFormChange({ description: event.target.value })}
          />
        </label>

        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-stone-700">预算科目分摊</p>
            <button
              type="button"
              onClick={props.onAddAllocation}
              disabled={isLocked}
              className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" />
              添加一行
            </button>
          </div>

          {props.form.allocations.map((allocation, index) => (
            <div key={`${index}-${allocation.subjectKey}`} className="grid gap-3 rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4 md:grid-cols-[minmax(0,1fr)_160px_auto]">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-700">预算科目</span>
                <select
                  className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
                  value={allocation.subjectKey}
                  disabled={isLocked}
                  onChange={(event) => props.onAllocationChange(index, { subjectKey: event.target.value })}
                >
                  <option value="">请选择科目</option>
                  {filteredSubjects.map((subject) => (
                    <option key={subject.subjectKey} value={subject.subjectKey}>
                      {subject.subjectName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-700">分摊金额</span>
                <input
                  className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 disabled:opacity-60"
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={isLocked}
                  value={allocation.amount}
                  onChange={(event) => props.onAllocationChange(index, { amount: Number(event.target.value) })}
                />
              </label>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => props.onRemoveAllocation(index)}
                  disabled={isLocked || props.form.allocations.length === 1}
                  className="inline-flex h-11 items-center justify-center rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={props.onSubmit}
            disabled={props.loading || isLocked || props.form.amount <= 0 || !props.selectedPeriodId || !isAllocationValid}
            className="rounded-2xl bg-stone-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.loading ? '保存中...' : '过账'}
          </button>
        </div>
      </Panel>

      <Panel>
        <SectionTitle icon={ReceiptText} eyebrow="历史记录" title="已过账分录" />
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-y-2">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-stone-500">
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">方向</th>
                <th className="px-3 py-2">分摊明细</th>
                <th className="px-3 py-2">金额</th>
                <th className="px-3 py-2">对方单位</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {props.entries.map((entry) => (
                <tr key={entry.id} className="rounded-[18px] bg-stone-50/90 text-sm text-stone-700">
                  <td className="px-3 py-3">{formatDateTime(entry.occurredAt)}</td>
                  <td className="px-3 py-3">{entry.direction === 'income' ? '收入' : '支出'}</td>
                  <td className="px-3 py-3">
                    <div className="space-y-1">
                      {entry.allocations.map((allocation) => (
                        <div key={`${entry.id}-${allocation.subjectKey}`} className="flex items-center justify-between gap-3">
                          <span>{allocation.subjectName}</span>
                          <span className="font-semibold text-stone-950">{formatCurrency(allocation.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3 font-semibold text-stone-950">{formatCurrency(entry.amount)}</td>
                  <td className="px-3 py-3">{entry.counterparty ?? '-'}</td>
                  <td className="px-3 py-3">
                    {entry.status === 'voided' ? (
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">已作废</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => props.onVoid(entry.id)}
                        disabled={isLocked}
                        className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        作废
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {props.entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-stone-500">
                    当前期间还没有已过账分录。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
