import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, ReceiptText, Search } from 'lucide-react'
import type { EntryAllocation, EntryResponse, SubjectResponse } from '../../lib/api'
import { cx, formatCurrency } from '../../lib/format'
import type { MonthlyScenarioResult } from '../../types'
import { BodyCell as HistoryCell, DenseFieldInput, HeaderCell as HistoryHeader, Panel, SectionTitle, SegmentTabs } from '../common/ui'

type HistoryDirectionFilter = 'all' | 'income' | 'expense'
type HistoryStatusFilter = 'all' | 'posted' | 'voided'
type HistoryDateFilterMode = 'all' | 'day' | 'week'

type HistoryAllocationDraft = {
  id: string
  subjectKey: string
  amount: number
}

type HistoryNumericDraft = {
  entryId: string
  allocations: HistoryAllocationDraft[]
}

type QuantityEditState = {
  offlineUnits: number
  onlineUnits: number
  hasOffline: boolean
  hasOnline: boolean
}

const OFFLINE_REVENUE_KEY = 'revenue.offline_sales'
const ONLINE_REVENUE_KEY = 'revenue.online_sales'

const historyDirectionTabs: Array<{ value: HistoryDirectionFilter; label: string }> = [
  { value: 'all', label: '全部方向' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
]

const historyStatusTabs: Array<{ value: HistoryStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'posted', label: '已过账' },
  { value: 'voided', label: '已作废' },
]

const historyDateTabs: Array<{ value: HistoryDateFilterMode; label: string }> = [
  { value: 'all', label: '全部日期' },
  { value: 'day', label: '某一天' },
  { value: 'week', label: '某一周' },
]

export function HistorySection(props: {
  historyGroups: Array<{ entry: EntryResponse; derivedEntries: EntryResponse[] }>
  isLocked: boolean
  loading: boolean
  subjects: SubjectResponse[]
  plannedMonthResult: MonthlyScenarioResult | null
  offlineUnitPrice: number
  onlineUnitPrice: number
  onUpdate: (
    entryId: string,
    payload: {
      amount: number
      occurredAt?: string
      counterparty?: string
      description?: string
      relatedEntityType?: 'teamMember' | 'employee'
      relatedEntityId?: string
      relatedEntityName?: string
      allocations: EntryAllocation[]
    },
  ) => Promise<boolean | void>
  onVoid: (entryId: string) => Promise<boolean | void>
  onRestore: (entryId: string) => Promise<boolean | void>
}) {
  const [directionFilter, setDirectionFilter] = useState<HistoryDirectionFilter>('all')
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>('all')
  const [dateFilterMode, setDateFilterMode] = useState<HistoryDateFilterMode>('all')
  const [keyword, setKeyword] = useState('')
  const [selectedDay, setSelectedDay] = useState('')
  const [selectedWeek, setSelectedWeek] = useState('')
  const [rowDrafts, setRowDrafts] = useState<Record<string, HistoryNumericDraft>>({})

  const filteredHistoryGroups = useMemo(
    () =>
      props.historyGroups.filter(({ entry, derivedEntries }) => {
        if (directionFilter !== 'all' && entry.direction !== directionFilter) return false
        if (statusFilter !== 'all' && entry.status !== statusFilter) return false

        const occurredOn = toInputDate(entry.occurredAt)
        if (dateFilterMode === 'day' && selectedDay && occurredOn !== selectedDay) return false
        if (dateFilterMode === 'week' && selectedWeek && toWeekInputValue(entry.occurredAt) !== selectedWeek) return false

        const normalizedKeyword = keyword.trim().toLowerCase()
        if (!normalizedKeyword) return true

        return matchesHistoryKeyword(entry, derivedEntries, normalizedKeyword)
      }),
    [dateFilterMode, directionFilter, keyword, props.historyGroups, selectedDay, selectedWeek, statusFilter],
  )

  useEffect(() => {
    const activeEntries = new Map(props.historyGroups.map((group) => [group.entry.id, group.entry]))
    setRowDrafts((current) => {
      let changed = false
      const next = { ...current }

      Object.entries(next).forEach(([entryId, draft]) => {
        const entry = activeEntries.get(entryId)
        if (!entry || entry.status === 'voided' || !isHistoryDraftDirty(entry, draft)) {
          delete next[entryId]
          changed = true
        }
      })

      return changed ? next : current
    })
  }, [props.historyGroups])

  const hasHistory = props.historyGroups.length > 0
  const hasFilteredHistory = filteredHistoryGroups.length > 0
  const hasActiveDateFilter = dateFilterMode !== 'all'

  function handleDateFilterModeChange(nextMode: HistoryDateFilterMode) {
    setDateFilterMode(nextMode)
    if (nextMode === 'day' && !selectedDay) setSelectedDay(getTodayInputDate())
    if (nextMode === 'week' && !selectedWeek) setSelectedWeek(getCurrentWeekInputValue())
  }

  function getDraft(entry: EntryResponse) {
    return rowDrafts[entry.id] ?? createHistoryDraft(entry)
  }

  function updateDraft(entry: EntryResponse, updater: (draft: HistoryNumericDraft) => HistoryNumericDraft) {
    setRowDrafts((current) => {
      const base = current[entry.id] ?? createHistoryDraft(entry)
      const nextDraft = updater(base)
      if (!isHistoryDraftDirty(entry, nextDraft)) {
        if (!(entry.id in current)) return current
        const next = { ...current }
        delete next[entry.id]
        return next
      }
      return { ...current, [entry.id]: nextDraft }
    })
  }

  function handleAllocationAmountChange(entry: EntryResponse, allocationId: string, amount: number) {
    updateDraft(entry, (draft) => ({
      ...draft,
      allocations: draft.allocations.map((allocation) =>
        allocation.id === allocationId ? { ...allocation, amount: roundMoney(amount) } : allocation,
      ),
    }))
  }

  function handleQuantityChange(entry: EntryResponse, subjectKey: string, units: number) {
    const unitPrice = subjectKey === OFFLINE_REVENUE_KEY ? props.offlineUnitPrice : props.onlineUnitPrice
    updateDraft(entry, (draft) => {
      const nextAmount = roundMoney(Math.max(0, Math.round(units)) * unitPrice)
      return {
        ...draft,
        allocations: draft.allocations.map((allocation) =>
          allocation.subjectKey === subjectKey ? { ...allocation, amount: nextAmount } : allocation,
        ),
      }
    })
  }

  async function handleSaveRow(entry: EntryResponse, draft: HistoryNumericDraft) {
    const quantityState = getQuantityEditState(entry, draft, props.offlineUnitPrice, props.onlineUnitPrice)
    const payload = buildHistoryUpdatePayload(entry, draft, quantityState)
    if (!payload) return

    const success = await props.onUpdate(entry.id, payload)
    if (success) {
      setRowDrafts((current) => {
        if (!(entry.id in current)) return current
        const next = { ...current }
        delete next[entry.id]
        return next
      })
    }
  }

  return (
    <Panel>
      <SectionTitle icon={ReceiptText} eyebrow="历史" title="账本记录" />

      {hasHistory ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <SegmentTabs compact value={directionFilter} items={historyDirectionTabs} onChange={setDirectionFilter} />
            <SegmentTabs compact value={statusFilter} items={historyStatusTabs} onChange={setStatusFilter} />

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-stone-900/10 bg-white px-3 py-2">
              <CalendarRange className="h-4 w-4 text-stone-400" />
              <span className="text-xs font-semibold tracking-[0.12em] text-stone-500">业务日期</span>
              <div className="inline-flex flex-wrap gap-1 rounded-full border border-stone-900/10 bg-stone-100/70 p-1">
                {historyDateTabs.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => handleDateFilterModeChange(item.value)}
                    className={cx(
                      'rounded-full px-3 py-1.5 text-xs font-medium transition',
                      dateFilterMode === item.value ? 'bg-stone-950 text-white' : 'text-stone-600 hover:bg-white',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {dateFilterMode === 'day' ? (
                <DenseFieldInput
                  type="date"
                  value={selectedDay}
                  onChange={(event) => setSelectedDay(event.target.value)}
                  fieldSize="sm"
                  className="h-8 rounded-xl px-3"
                />
              ) : null}
              {dateFilterMode === 'week' ? (
                <DenseFieldInput
                  type="week"
                  value={selectedWeek}
                  onChange={(event) => setSelectedWeek(event.target.value)}
                  fieldSize="sm"
                  className="h-8 rounded-xl px-3"
                />
              ) : null}
              {hasActiveDateFilter ? (
                <button
                  type="button"
                  onClick={() => setDateFilterMode('all')}
                  className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-600 transition hover:bg-white"
                >
                  回到全部
                </button>
              ) : null}
            </div>

            <label className="relative min-w-[220px] flex-1 md:ml-auto md:max-w-[320px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="筛科目、成员、对方单位"
                className="h-10 w-full rounded-2xl border border-stone-900/10 bg-white pl-10 pr-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300"
              />
            </label>

            <span className="rounded-full border border-stone-900/10 bg-stone-50 px-3 py-2 text-xs font-semibold text-stone-600">
              {filteredHistoryGroups.length} 条
            </span>
          </div>

          {hasFilteredHistory ? (
            <div className="mt-4 overflow-hidden rounded-[24px] border border-stone-900/10 bg-white">
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-[12px]">
                  <colgroup>
                    <col className="w-[18%]" />
                    <col className="w-[7%]" />
                    <col className="w-[35%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <thead className="bg-stone-100/90 text-stone-600">
                    <tr className="border-b border-stone-900/10">
                      <HistoryHeader align="center">时间</HistoryHeader>
                      <HistoryHeader align="center">方向</HistoryHeader>
                      <HistoryHeader align="center">摘要</HistoryHeader>
                      <HistoryHeader align="center">关联对象</HistoryHeader>
                      <HistoryHeader align="center">金额</HistoryHeader>
                      <HistoryHeader align="center">操作</HistoryHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistoryGroups.map(({ entry, derivedEntries }) => {
                      const draft = getDraft(entry)
                      const totalAmount = sumDraftAmount(draft)
                      const isDirty = Boolean(rowDrafts[entry.id])
                      const quantityState = getQuantityEditState(entry, draft, props.offlineUnitPrice, props.onlineUnitPrice)
                      const isVoided = entry.status === 'voided'
                      const canSave =
                        !isVoided &&
                        !props.isLocked &&
                        !props.loading &&
                        isDirty &&
                        canSaveHistoryDraft(draft)

                      return (
                        <tr key={entry.id} className="border-b border-stone-900/10 last:border-none">
                          <HistoryCell className={cx('whitespace-nowrap tabular-nums text-stone-500', isVoided && 'line-through text-stone-400')}>
                            {formatEntryDate(entry.occurredAt)} · 记账 {formatPostedAt(entry.postedAt)}
                          </HistoryCell>
                          <HistoryCell align="center">
                            <span
                              className={cx(
                                'rounded-full px-2.5 py-1 text-xs font-semibold',
                                isVoided && 'opacity-45',
                                entry.direction === 'income'
                                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : 'border border-rose-200 bg-rose-50 text-rose-700',
                              )}
                            >
                              {entry.direction === 'income' ? '收入' : '支出'}
                            </span>
                          </HistoryCell>
                          <HistoryCell className="min-w-0">
                            <HistorySummaryEditor
                              entry={entry}
                              derivedEntries={derivedEntries}
                              quantityState={quantityState}
                              isLocked={props.isLocked}
                              loading={props.loading}
                              onQuantityChange={(subjectKey, units) => handleQuantityChange(entry, subjectKey, units)}
                            />
                          </HistoryCell>
                          <HistoryCell className={cx('truncate text-stone-600', isVoided && 'line-through text-stone-400')}>{relatedEntityLabel(entry)}</HistoryCell>
                          <HistoryCell align="right" className={cx('whitespace-nowrap', isVoided && 'line-through text-stone-400')}>
                            <HistoryAmountEditor
                              entry={entry}
                              draft={draft}
                              totalAmount={totalAmount}
                              quantityState={quantityState}
                              isLocked={props.isLocked}
                              loading={props.loading}
                              onAmountChange={(allocationId, amount) => handleAllocationAmountChange(entry, allocationId, amount)}
                            />
                          </HistoryCell>
                          <HistoryCell align="center">
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              {!isVoided ? (
                                <>
                                <button
                                  type="button"
                                  disabled={!canSave}
                                  onClick={() => void handleSaveRow(entry, draft)}
                                  className="rounded-full bg-stone-950 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
                                >
                                  保存
                                </button>
                                <button
                                  type="button"
                                  disabled={props.isLocked || props.loading}
                                  onClick={() => props.onVoid(entry.id)}
                                  className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    作废
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={props.isLocked || props.loading}
                                  onClick={() => void props.onRestore(entry.id)}
                                  className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  取消作废
                                </button>
                              )}
                            </div>
                          </HistoryCell>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 p-4 md:hidden">
                {filteredHistoryGroups.map(({ entry, derivedEntries }) => {
                  const draft = getDraft(entry)
                  const totalAmount = sumDraftAmount(draft)
                  const isDirty = Boolean(rowDrafts[entry.id])
                  const quantityState = getQuantityEditState(entry, draft, props.offlineUnitPrice, props.onlineUnitPrice)
                  const isVoided = entry.status === 'voided'
                  const canSave =
                    !isVoided && !props.isLocked && !props.loading && isDirty && canSaveHistoryDraft(draft)

                  return (
                    <article key={entry.id} className={cx('rounded-[20px] border border-stone-900/10 bg-white p-4', isVoided && 'bg-stone-50/80')}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className={cx('truncate text-base font-semibold text-stone-950', isVoided && 'line-through text-stone-400')}>
                            {buildHistorySummary(entry, derivedEntries)}
                          </div>
                          <div className={cx('mt-1 text-xs text-stone-500', isVoided && 'line-through text-stone-400')}>
                            {formatEntryDate(entry.occurredAt)} · 记账 {formatPostedAt(entry.postedAt)}
                          </div>
                        </div>
                        <span
                          className={cx(
                            'rounded-full px-2.5 py-1 text-xs font-semibold',
                            isVoided && 'opacity-45',
                            entry.direction === 'income'
                              ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border border-rose-200 bg-rose-50 text-rose-700',
                          )}
                        >
                          {entry.direction === 'income' ? '收入' : '支出'}
                        </span>
                      </div>

                      <div className={cx('mt-2 text-sm text-stone-600', isVoided && 'line-through text-stone-400')}>{relatedEntityLabel(entry)}</div>

                      <div className="mt-3">
                        <HistorySummaryEditor
                          entry={entry}
                          derivedEntries={derivedEntries}
                          quantityState={quantityState}
                          isLocked={props.isLocked}
                          loading={props.loading}
                          onQuantityChange={(subjectKey, units) => handleQuantityChange(entry, subjectKey, units)}
                        />
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-3">
                        <span className={cx('text-sm font-semibold text-stone-500', isVoided && 'line-through text-stone-400')}>金额</span>
                        <HistoryAmountEditor
                          entry={entry}
                          draft={draft}
                          totalAmount={totalAmount}
                          quantityState={quantityState}
                          isLocked={props.isLocked}
                          loading={props.loading}
                          onAmountChange={(allocationId, amount) => handleAllocationAmountChange(entry, allocationId, amount)}
                        />
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {!isVoided ? (
                          <>
                          <button
                            type="button"
                            disabled={!canSave}
                            onClick={() => void handleSaveRow(entry, draft)}
                            className="rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            disabled={props.isLocked || props.loading}
                            onClick={() => props.onVoid(entry.id)}
                            className="rounded-full border border-stone-900/10 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            作废
                          </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={props.isLocked || props.loading}
                            onClick={() => void props.onRestore(entry.id)}
                            className="rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            取消作废
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-[24px] border border-dashed border-stone-900/10 bg-stone-50/80 px-4 py-10 text-center text-sm text-stone-500">
              当前筛选条件下还没有记录。
            </div>
          )}
        </>
      ) : (
        <div className="mt-5 rounded-[24px] border border-dashed border-stone-900/10 bg-stone-50/80 px-4 py-10 text-center text-sm text-stone-500">
          当前期间还没有过账记录。
        </div>
      )}
    </Panel>
  )
}

function HistorySummaryEditor(props: {
  entry: EntryResponse
  derivedEntries: EntryResponse[]
  quantityState: QuantityEditState | null
  isLocked: boolean
  loading: boolean
  onQuantityChange: (subjectKey: string, units: number) => void
}) {
  if (props.entry.status === 'voided') {
    return (
      <div className="truncate line-through font-medium text-stone-400">
        {buildHistorySummary(props.entry, props.derivedEntries)}
      </div>
    )
  }

  if (props.quantityState) {
    return (
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap">
        <span className="shrink-0 font-medium text-stone-900">{allocationTitle(props.entry.allocations)}</span>
        {props.quantityState.hasOffline ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold tracking-[0.12em] text-stone-500">线下</span>
            <HistoryUnitCell
              labelHidden
              label="线下张数"
              value={props.quantityState.offlineUnits}
              disabled={props.isLocked || props.loading}
              onChange={(value) => props.onQuantityChange(OFFLINE_REVENUE_KEY, value)}
            />
            <span className="shrink-0 text-[11px] font-semibold text-stone-500">张</span>
          </div>
        ) : null}
        {props.quantityState.hasOnline ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold tracking-[0.12em] text-stone-500">线上</span>
            <HistoryUnitCell
              labelHidden
              label="线上张数"
              value={props.quantityState.onlineUnits}
              disabled={props.isLocked || props.loading}
              onChange={(value) => props.onQuantityChange(ONLINE_REVENUE_KEY, value)}
            />
            <span className="shrink-0 text-[11px] font-semibold text-stone-500">张</span>
          </div>
        ) : null}
        {props.derivedEntries.length > 0 ? (
          <span className="shrink-0 text-[11px] font-medium text-stone-500">· 自动提成 {summarizeDerivedEntries(props.derivedEntries)}</span>
        ) : null}
      </div>
    )
  }

  return <div className="truncate font-medium text-stone-900">{buildHistorySummary(props.entry, props.derivedEntries)}</div>
}

function HistoryAmountEditor(props: {
  entry: EntryResponse
  draft: HistoryNumericDraft
  totalAmount: number
  quantityState: QuantityEditState | null
  isLocked: boolean
  loading: boolean
  onAmountChange: (allocationId: string, amount: number) => void
}) {
  if (props.entry.status === 'voided') {
    return <span className="font-semibold tabular-nums text-stone-400">{formatRmb(props.entry.amount)}</span>
  }

  if (props.quantityState) {
    return <span className="font-semibold tabular-nums text-amber-700">{formatRmb(props.totalAmount)}</span>
  }

  if (props.draft.allocations.length === 1) {
    return (
      <div className="ml-auto">
        <HistoryNumberInput
          value={props.draft.allocations[0]?.amount ?? 0}
          disabled={props.isLocked || props.loading}
          step={0.01}
          align="right"
          prefix="￥"
          minChars={2}
          maxChars={10}
          onChange={(value) => props.onAmountChange(props.draft.allocations[0]!.id, value)}
        />
      </div>
    )
  }

  return (
    <div className="grid justify-items-end gap-1">
      {props.draft.allocations.map((allocation) => (
        <HistoryNumberInput
          key={allocation.id}
          value={allocation.amount}
          disabled={props.isLocked || props.loading}
          step={0.01}
          align="right"
          prefix="￥"
          minChars={2}
          maxChars={9}
          onChange={(value) => props.onAmountChange(allocation.id, value)}
        />
      ))}
      <span className="text-[11px] font-semibold tabular-nums text-amber-700">{formatRmb(props.totalAmount)}</span>
    </div>
  )
}

function HistoryUnitCell(props: {
  label: string
  labelHidden?: boolean
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className={cx('grid gap-1', props.labelHidden && 'contents')}>
      {props.labelHidden ? null : <span className="text-[11px] font-semibold tracking-[0.12em] text-stone-500">{props.label}</span>}
      <HistoryNumberInput
        value={props.value}
        disabled={props.disabled}
        step={1}
        align="center"
        minChars={1}
        maxChars={6}
        onChange={props.onChange}
      />
    </label>
  )
}

function HistoryNumberInput(props: {
  value: number
  disabled: boolean
  step: number
  align: 'left' | 'center' | 'right'
  prefix?: string
  minChars?: number
  maxChars?: number
  onChange: (value: number) => void
}) {
  const displayValue = props.value === 0 ? '' : formatHistoryInputValue(props.value, props.step)
  const widthChars = Math.min(Math.max(displayValue.length || 1, props.minChars ?? 2), props.maxChars ?? 10)

  return (
    <div
      className={cx(
        'inline-flex h-8 items-center gap-1 rounded-xl border border-stone-900/10 bg-stone-50 px-2',
        props.disabled && 'opacity-60',
      )}
    >
      {props.prefix ? <span className="shrink-0 text-[13px] font-medium text-stone-500">{props.prefix}</span> : null}
      <input
        type="number"
        value={displayValue}
        min={0}
        step={props.step}
        disabled={props.disabled}
        onChange={(event) => {
          if (event.target.value === '') {
            props.onChange(0)
            return
          }
          const nextValue = Number(event.target.value)
          props.onChange(Number.isFinite(nextValue) ? nextValue : 0)
        }}
        className={cx(
          'h-full bg-transparent text-[13px] font-medium text-stone-900 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          props.align === 'center' ? 'text-center' : props.align === 'right' ? 'text-right' : 'text-left',
        )}
        style={{ width: `${widthChars + 1}ch` }}
      />
    </div>
  )
}

function createHistoryDraft(entry: EntryResponse): HistoryNumericDraft {
  return {
    entryId: entry.id,
    allocations: entry.allocations.map((allocation, index) => ({
      id: `${entry.id}-${index}-${allocation.subjectKey}`,
      subjectKey: allocation.subjectKey,
      amount: allocation.amount,
    })),
  }
}

function buildHistoryUpdatePayload(entry: EntryResponse, draft: HistoryNumericDraft, quantityState: QuantityEditState | null) {
  const allocations = entry.allocations
    .map((allocation, index) => {
      const draftAllocation = draft.allocations[index]
      const amount = roundMoney(draftAllocation?.amount ?? allocation.amount)
      if (amount <= 0) return null
      return { ...allocation, amount }
    })
    .filter((allocation): allocation is EntryAllocation => Boolean(allocation))

  if (allocations.length === 0) return null

  return {
    amount: roundMoney(allocations.reduce((sum, allocation) => sum + allocation.amount, 0)),
    ...(quantityState ? { description: buildQuantityDescription(quantityState) } : {}),
    allocations,
  }
}

function canSaveHistoryDraft(draft: HistoryNumericDraft) {
  return draft.allocations.some((allocation) => allocation.amount > 0) && draft.allocations.every((allocation) => allocation.amount >= 0)
}

function isHistoryDraftDirty(entry: EntryResponse, draft: HistoryNumericDraft) {
  const baseline = createHistoryDraft(entry)
  return JSON.stringify(compactHistoryDraft(draft)) !== JSON.stringify(compactHistoryDraft(baseline))
}

function compactHistoryDraft(draft: HistoryNumericDraft) {
  return draft.allocations.map((allocation) => ({
    subjectKey: allocation.subjectKey,
    amount: roundMoney(allocation.amount),
  }))
}

function sumDraftAmount(draft: HistoryNumericDraft) {
  return roundMoney(draft.allocations.reduce((sum, allocation) => sum + allocation.amount, 0))
}

function getQuantityEditState(
  entry: EntryResponse,
  draft: HistoryNumericDraft,
  offlineUnitPrice: number,
  onlineUnitPrice: number,
): QuantityEditState | null {
  if (entry.direction !== 'income' || entry.relatedEntityType !== 'teamMember') return null
  if (draft.allocations.length === 0) return null
  if (draft.allocations.some((allocation) => allocation.subjectKey !== OFFLINE_REVENUE_KEY && allocation.subjectKey !== ONLINE_REVENUE_KEY)) {
    return null
  }

  const offlineAmount = draft.allocations.find((allocation) => allocation.subjectKey === OFFLINE_REVENUE_KEY)?.amount ?? 0
  const onlineAmount = draft.allocations.find((allocation) => allocation.subjectKey === ONLINE_REVENUE_KEY)?.amount ?? 0
  const offlineUnits = offlineAmount > 0 ? deriveUnitsFromAmount(offlineAmount, offlineUnitPrice) : 0
  const onlineUnits = onlineAmount > 0 ? deriveUnitsFromAmount(onlineAmount, onlineUnitPrice) : 0

  if ((offlineAmount > 0 && offlineUnits === null) || (onlineAmount > 0 && onlineUnits === null)) {
    return null
  }

  return {
    offlineUnits: offlineUnits ?? 0,
    onlineUnits: onlineUnits ?? 0,
    hasOffline: draft.allocations.some((allocation) => allocation.subjectKey === OFFLINE_REVENUE_KEY),
    hasOnline: draft.allocations.some((allocation) => allocation.subjectKey === ONLINE_REVENUE_KEY),
  }
}

function deriveUnitsFromAmount(amount: number, unitPrice: number) {
  if (unitPrice <= 0) return null
  const units = amount / unitPrice
  const rounded = Math.round(units)
  return Math.abs(units - rounded) <= 0.01 ? rounded : null
}

function buildQuantityDescription(state: QuantityEditState) {
  return [state.hasOffline && state.offlineUnits > 0 ? `线下 ${formatUnits(state.offlineUnits)} 张` : null, state.hasOnline && state.onlineUnits > 0 ? `线上 ${formatUnits(state.onlineUnits)} 张` : null]
    .filter((part): part is string => Boolean(part))
    .join(' / ')
}

function allocationTitle(allocations: EntryAllocation[]) {
  if (allocations.length === 0) return '未挂科目'
  const keys = new Set(allocations.map((allocation) => allocation.subjectKey))
  if (keys.has(OFFLINE_REVENUE_KEY) && keys.has(ONLINE_REVENUE_KEY) && keys.size === 2) return '团员营收'
  return [...new Set(allocations.map((allocation) => allocation.subjectName))].join(' / ')
}

function summarizeDerivedEntries(entries: EntryResponse[]) {
  return entries.map((entry) => `${allocationTitle(entry.allocations)} ${formatCurrency(entry.amount)}`).join(' / ')
}

function buildHistorySummary(entry: EntryResponse, derivedEntries: EntryResponse[]) {
  return [allocationTitle(entry.allocations), entry.description, derivedEntries.length > 0 ? `自动提成 ${summarizeDerivedEntries(derivedEntries)}` : null]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

function relatedEntityLabel(entry: EntryResponse) {
  const parts = [entry.relatedEntityName, entry.counterparty].filter((value): value is string => Boolean(value))
  return parts.length > 0 ? parts.join(' / ') : '无'
}

function matchesHistoryKeyword(entry: EntryResponse, derivedEntries: EntryResponse[], keyword: string) {
  const haystack = [
    allocationTitle(entry.allocations),
    entry.description,
    summarizeDerivedEntries(derivedEntries),
    relatedEntityLabel(entry),
    entry.counterparty,
    entry.relatedEntityName,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()

  return haystack.includes(keyword)
}

function formatEntryDate(value: string | null) {
  if (!value) return '未设置'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未设置'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function formatPostedAt(value: string | null) {
  if (!value) return '未过账'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未过账'
  return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)} ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)}`
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function formatRmb(value: number) {
  return formatCurrency(value).replace('¥', '￥')
}

function formatHistoryInputValue(value: number, step: number) {
  if (value === 0) return ''
  if (step >= 1) return String(Math.round(value))
  const rounded = roundMoney(value)
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function formatUnits(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function getTodayInputDate() {
  const now = new Date()
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

function getCurrentWeekInputValue() {
  return toWeekInputValueFromDate(new Date())
}

function toInputDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

function toWeekInputValue(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return toWeekInputValueFromDate(date)
}

function toWeekInputValueFromDate(value: Date) {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  const day = date.getDay() || 7
  date.setDate(date.getDate() + 4 - day)
  const yearStart = new Date(date.getFullYear(), 0, 1)
  const weekNumber = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`
}
