import {
  Lock,
  LockOpen,
  Plus,
  ReceiptText,
  SplitSquareHorizontal,
  Trash2,
  UserRound,
  WalletCards,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { EntryAllocation, EntryResponse, PeriodResponse, SubjectResponse } from '../../lib/api'
import { cx, formatCurrency, formatDateTime } from '../../lib/format'
import type { MonthlyScenarioResult } from '../../types'
import { CompactNumberInput, Panel, SectionTitle, SegmentTabs, StatCard } from '../common/ui'

export type BookkeepingSubmitPayload = {
  direction: 'income' | 'expense'
  amount: number
  counterparty?: string
  description?: string
  relatedEntityType?: 'teamMember' | 'employee'
  relatedEntityId?: string
  relatedEntityName?: string
  allocations: EntryAllocation[]
}

type SubjectCategory = 'revenue' | 'member' | 'employee' | 'operating' | 'training' | 'stage' | 'other'

type AllocationDraft = {
  subjectKey: string
  amount: number
}

type RelatedEntityOption = {
  id: string
  name: string
  type: 'teamMember' | 'employee'
  caption: string
  plannedAmount: number
}

const directionTabs: Array<{ value: 'income' | 'expense'; label: string }> = [
  { value: 'income', label: '记收入' },
  { value: 'expense', label: '记支出' },
]

const categoryLabels: Record<SubjectCategory, string> = {
  revenue: '营收',
  member: '成员',
  employee: '员工',
  operating: '经营',
  training: '排练',
  stage: '舞台',
  other: '其它',
}

export function BookkeepingPanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  subjects: SubjectResponse[]
  entries: EntryResponse[]
  loading: boolean
  baselineMonthResult: MonthlyScenarioResult | null
  onSelectPeriod: (id: string) => void
  onSubmit: (payload: BookkeepingSubmitPayload) => Promise<boolean | void>
  onVoid: (entryId: string) => void
  onToggleLock: () => void
}) {
  const [direction, setDirection] = useState<'income' | 'expense'>('income')
  const [selectedCategory, setSelectedCategory] = useState<SubjectCategory>('revenue')
  const [selectedSubjectKey, setSelectedSubjectKey] = useState('')
  const [relatedEntityId, setRelatedEntityId] = useState('')
  const [amount, setAmount] = useState(0)
  const [counterparty, setCounterparty] = useState('')
  const [description, setDescription] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [splitMode, setSplitMode] = useState(false)
  const [allocations, setAllocations] = useState<AllocationDraft[]>([{ subjectKey: '', amount: 0 }])

  const selectedPeriod = props.periods.find((period) => period.id === props.selectedPeriodId) ?? null
  const isLocked = selectedPeriod?.status === 'locked'

  const subjectOptions = useMemo(
    () =>
      props.subjects
        .filter((subject) => subject.subjectType === (direction === 'income' ? 'revenue' : 'cost'))
        .sort((left, right) => compareSubjects(left, right)),
    [direction, props.subjects],
  )

  const categoryOptions = useMemo(() => {
    const seen = new Set<SubjectCategory>()
    const items: Array<{ value: SubjectCategory; label: string }> = []

    subjectOptions.forEach((subject) => {
      const category = getSubjectCategory(subject)
      if (seen.has(category)) {
        return
      }
      seen.add(category)
      items.push({ value: category, label: categoryLabels[category] })
    })

    return items
  }, [subjectOptions])

  const visibleSubjects = useMemo(
    () => subjectOptions.filter((subject) => getSubjectCategory(subject) === selectedCategory),
    [selectedCategory, subjectOptions],
  )

  const subjectByKey = useMemo(
    () => new Map(subjectOptions.map((subject) => [subject.subjectKey, subject])),
    [subjectOptions],
  )

  const selectedSubject = selectedSubjectKey ? subjectByKey.get(selectedSubjectKey) ?? null : null
  const relatedOptions = useMemo(
    () => buildRelatedEntityOptions(selectedSubjectKey, props.baselineMonthResult),
    [props.baselineMonthResult, selectedSubjectKey],
  )
  const selectedRelatedEntity = relatedOptions.find((item) => item.id === relatedEntityId) ?? null

  const submitAllocations = useMemo(() => {
    if (!splitMode) {
      if (!selectedSubject || amount <= 0) {
        return []
      }

      return [
        {
          subjectKey: selectedSubject.subjectKey,
          subjectName: selectedSubject.subjectName,
          subjectType: selectedSubject.subjectType,
          amount: roundMoney(amount),
        },
      ] satisfies EntryAllocation[]
    }

    return allocations
      .map((allocation) => {
        const subject = subjectByKey.get(allocation.subjectKey)
        if (!subject || allocation.amount <= 0) {
          return null
        }

        return {
          subjectKey: subject.subjectKey,
          subjectName: subject.subjectName,
          subjectType: subject.subjectType,
          amount: roundMoney(allocation.amount),
        } satisfies EntryAllocation
      })
      .filter((allocation): allocation is EntryAllocation => allocation !== null)
  }, [allocations, amount, selectedSubject, splitMode, subjectByKey])

  const allocationTotal = submitAllocations.reduce((sum, allocation) => sum + allocation.amount, 0)
  const isAmountValid = amount > 0 && Math.abs(allocationTotal - amount) < 0.005
  const canSubmit = Boolean(props.selectedPeriodId && submitAllocations.length > 0 && isAmountValid && !isLocked)

  useEffect(() => {
    if (categoryOptions.length === 0) {
      setSelectedCategory(direction === 'income' ? 'revenue' : 'member')
      return
    }

    if (!categoryOptions.some((item) => item.value === selectedCategory)) {
      setSelectedCategory(categoryOptions[0]?.value ?? (direction === 'income' ? 'revenue' : 'member'))
    }
  }, [categoryOptions, direction, selectedCategory])

  useEffect(() => {
    setSelectedSubjectKey('')
    setRelatedEntityId('')
    setAmount(0)
    setCounterparty('')
    setDescription('')
    setShowDetails(false)
    setSplitMode(false)
    setAllocations([{ subjectKey: '', amount: 0 }])
  }, [props.selectedPeriodId])

  useEffect(() => {
    setSelectedSubjectKey('')
    setRelatedEntityId('')
    setAmount(0)
    setShowDetails(false)
    setSplitMode(false)
    setAllocations([{ subjectKey: '', amount: 0 }])
  }, [direction, selectedCategory])

  useEffect(() => {
    if (relatedOptions.length === 0) {
      setRelatedEntityId('')
      return
    }

    if (relatedEntityId && !relatedOptions.some((option) => option.id === relatedEntityId)) {
      setRelatedEntityId('')
    }
  }, [relatedEntityId, relatedOptions])

  function handleSubjectSelect(subject: SubjectResponse) {
    setSelectedSubjectKey(subject.subjectKey)
    setRelatedEntityId('')

    if (splitMode) {
      setAllocations([{ subjectKey: subject.subjectKey, amount }])
      return
    }

    if (amount <= 0 && getRelatedEntityType(subject.subjectKey) === null && subject.plannedAmount > 0) {
      setAmount(roundMoney(subject.plannedAmount))
    }
  }

  function handleRelatedEntitySelect(option: RelatedEntityOption) {
    setRelatedEntityId(option.id)
    if (!splitMode && option.plannedAmount > 0) {
      setAmount(roundMoney(option.plannedAmount))
    }
  }

  function handleSplitModeChange(nextValue: boolean) {
    setSplitMode(nextValue)

    if (nextValue) {
      setAllocations([{ subjectKey: selectedSubjectKey, amount }])
    } else {
      setAllocations([{ subjectKey: selectedSubjectKey, amount }])
    }
  }

  async function handleSubmit() {
    if (!canSubmit) {
      return
    }

    const success = await props.onSubmit({
      direction,
      amount: roundMoney(amount),
      ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(selectedRelatedEntity
        ? {
            relatedEntityType: selectedRelatedEntity.type,
            relatedEntityId: selectedRelatedEntity.id,
            relatedEntityName: selectedRelatedEntity.name,
          }
        : {}),
      allocations: submitAllocations,
    })

    if (success) {
      setSelectedSubjectKey('')
      setRelatedEntityId('')
      setAmount(0)
      setCounterparty('')
      setDescription('')
      setShowDetails(false)
      setSplitMode(false)
      setAllocations([{ subjectKey: '', amount: 0 }])
    }
  }

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={ReceiptText}
          eyebrow="记账"
          title="按期间挂账"
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
              <div className="flex flex-wrap gap-2">
                {selectedPeriod.baselineVersionName ? (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                    基线 {selectedPeriod.baselineVersionName}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-50 px-3 py-2 text-xs font-semibold text-stone-600">
                  {isLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                  {isLocked ? '本期已锁定' : '本期可录入'}
                </span>
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
              <StatCard label="计划收入" value={formatCurrency(selectedPeriod.plannedRevenue)} />
              <StatCard label="计划成本" value={formatCurrency(selectedPeriod.plannedCost)} />
              <StatCard label="实际收入" value={formatCurrency(selectedPeriod.actualRevenue)} />
              <StatCard label="实际成本" value={formatCurrency(selectedPeriod.actualCost)} />
            </div>
          </>
        ) : null}
      </Panel>

      <Panel>
        <SectionTitle
          icon={WalletCards}
          eyebrow="录入"
          title="快速录入"
        />

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <SegmentTabs value={direction} items={directionTabs} onChange={setDirection} />
          {categoryOptions.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {categoryOptions.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  disabled={isLocked}
                  onClick={() => setSelectedCategory(item.value)}
                  className={cx(
                    'rounded-full border px-3 py-2 text-sm font-semibold transition',
                    selectedCategory === item.value
                      ? 'border-amber-300 bg-amber-100 text-amber-800'
                      : 'border-stone-900/10 bg-stone-50 text-stone-600 hover:bg-white',
                    isLocked && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-5 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {visibleSubjects.map((subject) => (
            <button
              key={subject.subjectKey}
              type="button"
              disabled={isLocked}
              onClick={() => handleSubjectSelect(subject)}
              className={cx(
                'rounded-[22px] border px-4 py-3 text-left transition',
                selectedSubjectKey === subject.subjectKey
                  ? 'border-stone-950 bg-stone-950 text-white shadow-[0_14px_30px_rgba(41,37,36,0.16)]'
                  : 'border-stone-900/10 bg-stone-50/80 hover:bg-white',
                isLocked && 'cursor-not-allowed opacity-60',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className={selectedSubjectKey === subject.subjectKey ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-stone-950'}>
                  {subject.subjectName}
                </span>
                <span className={selectedSubjectKey === subject.subjectKey ? 'rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100' : 'rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-500'}>
                  {formatCurrency(subject.plannedAmount)}
                </span>
              </div>
            </button>
          ))}
        </div>

        {relatedOptions.length > 0 ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {relatedOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={isLocked}
                onClick={() => handleRelatedEntitySelect(option)}
                className={cx(
                  'rounded-[20px] border px-3 py-3 text-left transition',
                  relatedEntityId === option.id ? 'border-amber-300 bg-amber-50' : 'border-stone-900/10 bg-stone-50/80 hover:bg-white',
                  isLocked && 'cursor-not-allowed opacity-60',
                )}
              >
                <div className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-stone-500" />
                  <span className="text-sm font-semibold text-stone-950">{option.name}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-stone-500">
                  <span>{option.caption}</span>
                  <span className="font-semibold text-stone-700">{formatCurrency(option.plannedAmount)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-5 rounded-[28px] border border-stone-900/10 bg-stone-950 p-4 text-white shadow-[0_18px_40px_rgba(41,37,36,0.18)]">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px_auto] xl:items-center">
            <div className="flex flex-wrap items-center gap-2">
              <SummaryChip label="科目" value={selectedSubject?.subjectName ?? '未选'} />
              {selectedRelatedEntity ? <SummaryChip label={selectedRelatedEntity.type === 'employee' ? '员工' : '成员'} value={selectedRelatedEntity.name} /> : null}
              {selectedSubject && selectedSubject.plannedAmount > 0 ? (
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setAmount(roundMoney(selectedRelatedEntity?.plannedAmount ?? selectedSubject.plannedAmount))}
                  className="rounded-full border border-white/10 bg-white/10 px-3 py-2 text-xs font-semibold text-amber-100 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  带入计划 {formatCurrency(selectedRelatedEntity?.plannedAmount ?? selectedSubject.plannedAmount)}
                </button>
              ) : null}
              <button
                type="button"
                disabled={isLocked}
                onClick={() => setShowDetails((current) => !current)}
                className="rounded-full border border-white/10 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {showDetails ? '收起补充' : '补充信息'}
              </button>
              <button
                type="button"
                disabled={isLocked}
                onClick={() => handleSplitModeChange(!splitMode)}
                className={cx(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition',
                  splitMode ? 'border-amber-300 bg-amber-300/15 text-amber-100' : 'border-white/10 bg-white/10 text-white hover:bg-white/15',
                  isLocked && 'cursor-not-allowed opacity-60',
                )}
              >
                <SplitSquareHorizontal className="h-3.5 w-3.5" />
                {splitMode ? '关闭分摊' : '分摊'}
              </button>
            </div>

            <div className="rounded-[20px] border border-white/10 bg-white/10 p-3">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-300">金额</p>
              <div className="mt-2">
                <CompactNumberInput
                  value={amount}
                  onChange={setAmount}
                  min={0}
                  step={0.01}
                  className="h-12 rounded-2xl border-white/0 bg-white text-stone-950"
                  inputClassName="text-lg font-semibold"
                />
              </div>
              <p className="mt-2 text-xs text-stone-300">{isAmountValid ? '金额与分摊已对齐' : `分摊合计 ${formatCurrency(allocationTotal)}`}</p>
            </div>

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={props.loading || !canSubmit}
              className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {props.loading ? '保存中...' : '确认过账'}
            </button>
          </div>

          {showDetails ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-100">对方单位</span>
                <input
                  disabled={isLocked}
                  value={counterparty}
                  onChange={(event) => setCounterparty(event.target.value)}
                  className="h-11 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-medium text-white outline-none placeholder:text-stone-400 focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <label className="grid gap-2 md:col-span-2">
                <span className="text-sm font-semibold text-stone-100">备注</span>
                <textarea
                  disabled={isLocked}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="min-h-24 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-medium text-white outline-none placeholder:text-stone-400 focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </div>
          ) : null}

          {splitMode ? (
            <div className="mt-4 grid gap-2">
              {allocations.map((allocation, index) => (
                <div key={`${index}-${allocation.subjectKey}`} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
                  <select
                    disabled={isLocked}
                    value={allocation.subjectKey}
                    onChange={(event) =>
                      setAllocations((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, subjectKey: event.target.value } : item,
                        ),
                      )
                    }
                    className="h-11 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-medium text-white outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">请选择科目</option>
                    {subjectOptions.map((subject) => (
                      <option key={subject.subjectKey} value={subject.subjectKey}>
                        {subject.subjectName}
                      </option>
                    ))}
                  </select>
                  <CompactNumberInput
                    value={allocation.amount}
                    onChange={(value) =>
                      setAllocations((current) =>
                        current.map((item, itemIndex) => (itemIndex === index ? { ...item, amount: value } : item)),
                      )
                    }
                    min={0}
                    step={0.01}
                    className="h-11 rounded-2xl border-white/0 bg-white"
                  />
                  <button
                    type="button"
                    disabled={isLocked || allocations.length === 1}
                    onClick={() => setAllocations((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    className="inline-flex h-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 px-4 text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}

              <button
                type="button"
                disabled={isLocked}
                onClick={() => setAllocations((current) => [...current, { subjectKey: '', amount: 0 }])}
                className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                新增分摊
              </button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel>
        <SectionTitle
          icon={ReceiptText}
          eyebrow="历史"
          title="已过账记录"
        />

        <div className="mt-5 grid gap-3">
          {props.entries.length > 0 ? (
            props.entries.map((entry) => (
              <article key={entry.id} className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={entry.direction === 'income' ? 'rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700' : 'rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700'}>
                        {entry.direction === 'income' ? '收入' : '支出'}
                      </span>
                      <span className={entry.status === 'voided' ? 'rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-xs font-semibold text-stone-500' : 'rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800'}>
                        {entry.status === 'voided' ? '已作废' : '已过账'}
                      </span>
                      <span className="text-xs text-stone-500">{formatDateTime(entry.occurredAt)}</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {entry.relatedEntityName ? (
                        <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700">
                          {entry.relatedEntityType === 'employee' ? '员工' : '成员'}：{entry.relatedEntityName}
                        </span>
                      ) : null}
                      {entry.counterparty ? (
                        <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700">
                          对方单位：{entry.counterparty}
                        </span>
                      ) : null}
                    </div>

                    {entry.description ? <p className="mt-3 text-sm leading-6 text-stone-600">{entry.description}</p> : null}
                  </div>

                  <div className="text-right">
                    <p className="text-xs font-semibold tracking-[0.16em] text-stone-500">金额</p>
                    <p className="mt-2 text-xl font-bold text-stone-950">{formatCurrency(entry.amount)}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {entry.allocations.map((allocation) => (
                    <span key={`${entry.id}-${allocation.subjectKey}`} className="rounded-full border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700">
                      {allocation.subjectName} · {formatCurrency(allocation.amount)}
                    </span>
                  ))}
                </div>

                {entry.status !== 'voided' ? (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      disabled={isLocked}
                      onClick={() => props.onVoid(entry.id)}
                      className="rounded-full border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      作废
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <div className="rounded-[24px] border border-dashed border-stone-900/10 bg-stone-50/80 px-4 py-10 text-center text-sm text-stone-500">
              当前期间还没有过账记录。
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}

function SummaryChip(props: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-xs font-semibold text-white">
      <span className="text-stone-300">{props.label}</span>
      <span>{props.value}</span>
    </span>
  )
}

function compareSubjects(left: SubjectResponse, right: SubjectResponse) {
  return (
    getPriority(left.subjectKey) - getPriority(right.subjectKey) ||
    right.plannedAmount - left.plannedAmount ||
    left.subjectName.localeCompare(right.subjectName, 'zh-CN')
  )
}

function getPriority(subjectKey: string) {
  const priorityMap: Record<string, number> = {
    'revenue.offline_sales': 0,
    'revenue.online_sales': 1,
    'cost.member.commission': 0,
    'cost.member.base_pay': 1,
    'cost.member.travel': 2,
    'cost.employee.base_pay': 3,
    'cost.employee.per_event': 4,
  }

  return priorityMap[subjectKey] ?? 10
}

function getSubjectCategory(subject: SubjectResponse): SubjectCategory {
  if (subject.subjectType === 'revenue') {
    return 'revenue'
  }

  if (subject.subjectKey.startsWith('cost.member.')) {
    return 'member'
  }

  if (subject.subjectKey.startsWith('cost.employee.')) {
    return 'employee'
  }

  if (subject.subjectKey.startsWith('cost.training.')) {
    return 'training'
  }

  if (subject.subjectKey.startsWith('cost.stage.')) {
    return 'stage'
  }

  if (subject.subjectKey.startsWith('cost.operating.')) {
    return 'operating'
  }

  return 'other'
}

function getRelatedEntityType(subjectKey: string): 'teamMember' | 'employee' | null {
  if (subjectKey === 'revenue.offline_sales' || subjectKey.startsWith('cost.member.')) {
    return 'teamMember'
  }

  if (subjectKey.startsWith('cost.employee.')) {
    return 'employee'
  }

  return null
}

function buildRelatedEntityOptions(subjectKey: string, month: MonthlyScenarioResult | null) {
  if (!month) {
    return [] satisfies RelatedEntityOption[]
  }

  if (subjectKey === 'revenue.offline_sales') {
    return [...month.members]
      .map((member) => ({
        id: member.memberId,
        name: member.name,
        type: 'teamMember' as const,
        caption: member.employmentType === 'salary' ? '底薪成员 · 本期营收' : '兼职成员 · 本期营收',
        plannedAmount: member.grossSales,
      }))
      .sort((left, right) => right.plannedAmount - left.plannedAmount)
  }

  if (subjectKey === 'cost.member.commission') {
    return month.members.map((member) => ({
      id: member.memberId,
      name: member.name,
      type: 'teamMember' as const,
      caption: '成员提成',
      plannedAmount: member.commissionCost,
    }))
  }

  if (subjectKey === 'cost.member.base_pay') {
    return month.members.map((member) => ({
      id: member.memberId,
      name: member.name,
      type: 'teamMember' as const,
      caption: '成员底薪',
      plannedAmount: member.basePayCost,
    }))
  }

  if (subjectKey === 'cost.member.travel') {
    return month.members.map((member) => ({
      id: member.memberId,
      name: member.name,
      type: 'teamMember' as const,
      caption: '成员路费',
      plannedAmount: member.travelCost,
    }))
  }

  if (subjectKey === 'cost.employee.base_pay') {
    return month.employees.map((employee) => ({
      id: employee.employeeId,
      name: employee.name,
      type: 'employee' as const,
      caption: `${employee.role} · 月薪`,
      plannedAmount: employee.basePayCost,
    }))
  }

  if (subjectKey === 'cost.employee.per_event') {
    return month.employees.map((employee) => ({
      id: employee.employeeId,
      name: employee.name,
      type: 'employee' as const,
      caption: `${employee.role} · 场次`,
      plannedAmount: employee.perEventCost,
    }))
  }

  return [] satisfies RelatedEntityOption[]
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}
