import { ReceiptText } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'
import { formatCurrency, formatDateTime } from '../../lib/format'
import type { EntryResponse, PeriodResponse, SubjectResponse } from '../../lib/api'

export function BookkeepingPanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  subjects: SubjectResponse[]
  entries: EntryResponse[]
  loading: boolean
  form: {
    direction: 'income' | 'expense'
    amount: number
    subjectKey: string
    counterparty: string
    description: string
  }
  onSelectPeriod: (id: string) => void
  onFormChange: (next: Partial<{ direction: 'income' | 'expense'; amount: number; subjectKey: string; counterparty: string; description: string }>) => void
  onSubmit: () => void
  onVoid: (entryId: string) => void
}) {
  const selectedPeriod = props.periods.find((period) => period.id === props.selectedPeriodId)

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={ReceiptText}
          eyebrow="Bookkeeping"
          title="Actual entries"
          description="Record actual income and cost entries against the baseline forecast subjects of the selected period."
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
          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Planned revenue</p>
              <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.plannedRevenue)}</p>
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Planned cost</p>
              <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.plannedCost)}</p>
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Actual revenue</p>
              <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.actualRevenue)}</p>
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Actual cost</p>
              <p className="mt-2 text-lg font-bold text-stone-950">{formatCurrency(selectedPeriod.actualCost)}</p>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">Direction</span>
            <select
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500"
              value={props.form.direction}
              onChange={(event) => props.onFormChange({ direction: event.target.value as 'income' | 'expense' })}
            >
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">Amount</span>
            <input
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500"
              type="number"
              min={0}
              value={props.form.amount}
              onChange={(event) => props.onFormChange({ amount: Number(event.target.value) })}
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">Forecast subject</span>
            <select
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500"
              value={props.form.subjectKey}
              onChange={(event) => props.onFormChange({ subjectKey: event.target.value })}
            >
              <option value="">Select a subject</option>
              {props.subjects.map((subject) => (
                <option key={subject.subjectKey} value={subject.subjectKey}>
                  {subject.subjectName}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">Counterparty</span>
            <input
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500"
              value={props.form.counterparty}
              onChange={(event) => props.onFormChange({ counterparty: event.target.value })}
            />
          </label>
        </div>

        <label className="mt-4 grid gap-2">
          <span className="text-sm font-semibold text-stone-700">Description</span>
          <textarea
            className="min-h-24 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 py-3 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500"
            value={props.form.description}
            onChange={(event) => props.onFormChange({ description: event.target.value })}
          />
        </label>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={props.onSubmit}
            disabled={props.loading || !props.form.subjectKey || props.form.amount <= 0 || !props.selectedPeriodId}
            className="rounded-2xl bg-stone-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.loading ? 'Saving...' : 'Post entry'}
          </button>
        </div>
      </Panel>

      <Panel>
        <SectionTitle icon={ReceiptText} eyebrow="History" title="Posted entries" />
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-y-2">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-stone-500">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Counterparty</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {props.entries.map((entry) => (
                <tr key={entry.id} className="rounded-[18px] bg-stone-50/90 text-sm text-stone-700">
                  <td className="px-3 py-3">{formatDateTime(entry.occurredAt)}</td>
                  <td className="px-3 py-3">{entry.direction}</td>
                  <td className="px-3 py-3">{entry.allocations[0]?.subjectName ?? '-'}</td>
                  <td className="px-3 py-3 font-semibold text-stone-950">{formatCurrency(entry.amount)}</td>
                  <td className="px-3 py-3">{entry.counterparty ?? '-'}</td>
                  <td className="px-3 py-3">
                    {entry.status === 'voided' ? (
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">Voided</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => props.onVoid(entry.id)}
                        className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700"
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {props.entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-stone-500">
                    No entries posted for this period.
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
