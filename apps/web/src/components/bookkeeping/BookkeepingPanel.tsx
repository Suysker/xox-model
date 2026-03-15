import { Building2, Lock, LockOpen, ReceiptText, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { EntryAllocation, EntryResponse, PeriodResponse, SubjectResponse } from '../../lib/api'
import { cx, formatCurrency } from '../../lib/format'
import type { MonthlyScenarioResult } from '../../types'
import { CompactNumberInput, Panel, SectionTitle, SegmentTabs, StatCard } from '../common/ui'

export type BookkeepingSubmitPayload = {
  direction: 'income' | 'expense'
  amount: number
  occurredAt?: string
  counterparty?: string
  description?: string
  relatedEntityType?: 'teamMember' | 'employee'
  relatedEntityId?: string
  relatedEntityName?: string
  allocations: EntryAllocation[]
}

type SubjectCategory = 'revenue' | 'member' | 'employee' | 'operating' | 'training' | 'stage' | 'other'

type RelatedEntityOption = {
  id: string
  name: string
  type: 'teamMember' | 'employee'
  caption: string
  plannedAmount: number
}

type MemberIncomeDraft = {
  offlineUnits: number
  onlineUnits: number
}

type MemberRevenueRow = {
  member: MonthlyScenarioResult['members'][number]
  plannedAmount: number
  plannedOfflineUnits: number
  plannedOnlineUnits: number
  postedAmount: number
  draftOfflineUnits: number
  draftOnlineUnits: number
  draftAmount: number
  draftCommission: number
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
  other: '其他',
}

export function BookkeepingPanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  subjects: SubjectResponse[]
  entries: EntryResponse[]
  loading: boolean
  baselineMonthResult: MonthlyScenarioResult | null
  offlineUnitPrice: number
  onlineUnitPrice: number
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
  const [memberIncomeDrafts, setMemberIncomeDrafts] = useState<Record<string, MemberIncomeDraft>>({})
  const [incomeOccurredOn, setIncomeOccurredOn] = useState(() => getTodayInputDate())
  const [expenseOccurredOn, setExpenseOccurredOn] = useState(() => getTodayInputDate())
  const incomeOccurredOnInputRef = useRef<HTMLInputElement | null>(null)
  const expenseOccurredOnInputRef = useRef<HTMLInputElement | null>(null)

  const selectedPeriod = props.periods.find((period) => period.id === props.selectedPeriodId) ?? null
  const isLocked = selectedPeriod?.status === 'locked'

  const subjectOptions = useMemo(
    () =>
      props.subjects
        .filter(
          (subject) =>
            subject.subjectType === (direction === 'income' ? 'revenue' : 'cost') &&
            (direction === 'income' || subject.subjectKey !== 'cost.member.commission'),
        )
        .sort(compareSubjects),
    [direction, props.subjects],
  )

  const categoryOptions = useMemo(() => {
    const seen = new Set<SubjectCategory>()
    const items: Array<{ value: SubjectCategory; label: string }> = []

    subjectOptions.forEach((subject) => {
      const category = getSubjectCategory(subject)
      if (!seen.has(category)) {
        seen.add(category)
        items.push({ value: category, label: categoryLabels[category] })
      }
    })

    return items
  }, [subjectOptions])

  const visibleSubjects = useMemo(
    () => subjectOptions.filter((subject) => getSubjectCategory(subject) === selectedCategory),
    [selectedCategory, subjectOptions],
  )
  const selectedSubject = subjectOptions.find((subject) => subject.subjectKey === selectedSubjectKey) ?? null

  const postedAmountsBySubject = useMemo(() => {
    const next = new Map<string, number>()
    props.entries.forEach((entry) => {
      if (entry.status === 'voided') return
      entry.allocations.forEach((allocation) => {
        next.set(allocation.subjectKey, (next.get(allocation.subjectKey) ?? 0) + allocation.amount)
      })
    })
    return next
  }, [props.entries])

  const postedAmountsBySubjectAndEntity = useMemo(() => {
    const next = new Map<string, number>()
    props.entries.forEach((entry) => {
      if (entry.status === 'voided') return
      entry.allocations.forEach((allocation) => {
        const key = `${allocation.subjectKey}:${entry.relatedEntityId ?? 'none'}`
        next.set(key, (next.get(key) ?? 0) + allocation.amount)
      })
    })
    return next
  }, [props.entries])

  const relatedOptions = useMemo(
    () => buildRelatedEntityOptions(selectedSubjectKey, props.baselineMonthResult),
    [props.baselineMonthResult, selectedSubjectKey],
  )
  const selectedRelatedEntity = relatedOptions.find((item) => item.id === relatedEntityId) ?? null
  const relatedSelectionRequired = relatedOptions.length > 0
  const plannedReference = selectedRelatedEntity?.plannedAmount ?? selectedSubject?.plannedAmount ?? 0
  const selectedPostedAmount = selectedSubject ? postedAmountsBySubject.get(selectedSubject.subjectKey) ?? 0 : 0
  const selectedGapAmount = selectedSubject ? selectedSubject.plannedAmount - selectedPostedAmount : 0
  const canSubmit = Boolean(
    selectedSubject &&
      amount > 0 &&
      (!relatedSelectionRequired || selectedRelatedEntity) &&
      !props.loading &&
      !isLocked,
  )

  const offlineRevenueSubject = subjectOptions.find((subject) => subject.subjectKey === 'revenue.offline_sales') ?? null
  const onlineRevenueSubject = subjectOptions.find((subject) => subject.subjectKey === 'revenue.online_sales') ?? null

  const memberRevenueRows = useMemo<MemberRevenueRow[]>(
    () =>
      (props.baselineMonthResult?.members ?? []).map((member) => {
        const draft = memberIncomeDrafts[member.memberId] ?? { offlineUnits: 0, onlineUnits: 0 }
        const plannedOfflineUnits = member.monthlyUnits
        const plannedOnlineUnits = member.monthlyUnits * (props.baselineMonthResult?.onlineSalesFactor ?? 0)
        const plannedAmount = roundMoney(member.grossSales + plannedOnlineUnits * props.onlineUnitPrice)
        const postedAmount =
          (postedAmountsBySubjectAndEntity.get(`revenue.offline_sales:${member.memberId}`) ?? 0) +
          (postedAmountsBySubjectAndEntity.get(`revenue.online_sales:${member.memberId}`) ?? 0)
        const draftAmount = roundMoney(
          draft.offlineUnits * props.offlineUnitPrice + draft.onlineUnits * props.onlineUnitPrice,
        )

        return {
          member,
          plannedAmount,
          plannedOfflineUnits,
          plannedOnlineUnits,
          postedAmount,
          draftOfflineUnits: draft.offlineUnits,
          draftOnlineUnits: draft.onlineUnits,
          draftAmount,
          draftCommission: roundMoney(draftAmount * getMemberCommissionRate(member)),
        }
      }),
    [
      memberIncomeDrafts,
      postedAmountsBySubjectAndEntity,
      props.baselineMonthResult,
      props.offlineUnitPrice,
      props.onlineUnitPrice,
    ],
  )

  const memberRevenueSummary = useMemo(
    () =>
      memberRevenueRows.reduce(
        (sum, row) => ({
          plannedRevenue: sum.plannedRevenue + row.plannedAmount,
          postedAmount: sum.postedAmount + row.postedAmount,
          draftCommission: sum.draftCommission + row.draftCommission,
        }),
        { plannedRevenue: 0, postedAmount: 0, draftCommission: 0 },
      ),
    [memberRevenueRows],
  )

  const historyGroups = useMemo(() => {
    const groupedDerived = new Map<string, EntryResponse[]>()
    const manualEntries: EntryResponse[] = []

    ;[...props.entries]
      .sort(compareEntryHistory)
      .forEach((entry) => {
        if (entry.entryOrigin === 'derived' && entry.sourceEntryId) {
          groupedDerived.set(entry.sourceEntryId, [...(groupedDerived.get(entry.sourceEntryId) ?? []), entry])
          return
        }
        manualEntries.push(entry)
      })

    return manualEntries.map((entry) => ({ entry, derivedEntries: groupedDerived.get(entry.id) ?? [] }))
  }, [props.entries])

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
  }, [props.selectedPeriodId, direction, selectedCategory])

  useEffect(() => {
    setMemberIncomeDrafts({})
  }, [props.selectedPeriodId])

  useEffect(() => {
    if (relatedOptions.length === 0) {
      setRelatedEntityId('')
      if (selectedSubject && amount <= 0 && selectedSubject.plannedAmount > 0) {
        setAmount(roundMoney(selectedSubject.plannedAmount))
      }
      return
    }

    if (relatedEntityId && !relatedOptions.some((option) => option.id === relatedEntityId)) {
      setRelatedEntityId('')
    }
  }, [amount, relatedEntityId, relatedOptions, selectedSubject])

  function handleSubjectSelect(subject: SubjectResponse) {
    setSelectedSubjectKey(subject.subjectKey)
    setRelatedEntityId('')
    if (getRelatedEntityType(subject.subjectKey) === null && subject.plannedAmount > 0) {
      setAmount(roundMoney(subject.plannedAmount))
      return
    }
    setAmount(0)
  }

  function handleRelatedEntitySelect(option: RelatedEntityOption) {
    setRelatedEntityId(option.id)
    if (option.plannedAmount > 0) setAmount(roundMoney(option.plannedAmount))
  }

  function setMemberDraftUnits(memberId: string, channel: keyof MemberIncomeDraft, value: number) {
    setMemberIncomeDrafts((current) => ({
      ...current,
      [memberId]: {
        offlineUnits: current[memberId]?.offlineUnits ?? 0,
        onlineUnits: current[memberId]?.onlineUnits ?? 0,
        [channel]: Math.max(0, Math.round(value)),
      },
    }))
  }

  function fillPlannedMemberUnits(memberId: string, offlineUnits: number, onlineUnits: number) {
    setMemberIncomeDrafts((current) => ({
      ...current,
      [memberId]: {
        offlineUnits: Math.max(0, Math.round(offlineUnits)),
        onlineUnits: Math.max(0, Math.round(onlineUnits)),
      },
    }))
  }

  async function handleSubmitMemberIncome(memberId: string) {
    if (!offlineRevenueSubject) return

    const member = props.baselineMonthResult?.members.find((item) => item.memberId === memberId)
    const draft = memberIncomeDrafts[memberId] ?? { offlineUnits: 0, onlineUnits: 0 }
    if (!member || (draft.offlineUnits <= 0 && draft.onlineUnits <= 0)) return
    if (draft.onlineUnits > 0 && !onlineRevenueSubject) return

    const offlineAmount = roundMoney(draft.offlineUnits * props.offlineUnitPrice)
    const onlineAmount = roundMoney(draft.onlineUnits * props.onlineUnitPrice)
    const occurredAt = resolveOccurredAt({
      ref: incomeOccurredOnInputRef,
      value: incomeOccurredOn,
      onResolved: setIncomeOccurredOn,
    })
    const allocations: EntryAllocation[] = []
    if (offlineAmount > 0) {
      allocations.push({
        subjectKey: offlineRevenueSubject.subjectKey,
        subjectName: offlineRevenueSubject.subjectName,
        subjectType: offlineRevenueSubject.subjectType,
        amount: offlineAmount,
      })
    }
    if (onlineAmount > 0 && onlineRevenueSubject) {
      allocations.push({
        subjectKey: onlineRevenueSubject.subjectKey,
        subjectName: onlineRevenueSubject.subjectName,
        subjectType: onlineRevenueSubject.subjectType,
        amount: onlineAmount,
      })
    }

    const success = await props.onSubmit({
      direction: 'income',
      amount: roundMoney(offlineAmount + onlineAmount),
      occurredAt,
      relatedEntityType: 'teamMember',
      relatedEntityId: member.memberId,
      relatedEntityName: member.name,
      description: [draft.offlineUnits > 0 ? `线下 ${formatUnits(draft.offlineUnits)} 张` : null, draft.onlineUnits > 0 ? `线上 ${formatUnits(draft.onlineUnits)} 张` : null]
        .filter((part): part is string => Boolean(part))
        .join(' / '),
      allocations,
    })

    if (success) {
      setMemberIncomeDrafts((current) => ({
        ...current,
        [memberId]: { offlineUnits: 0, onlineUnits: 0 },
      }))
    }
  }

  async function handleSubmitExpense() {
    if (!selectedSubject || !canSubmit) return
    const occurredAt = resolveOccurredAt({
      ref: expenseOccurredOnInputRef,
      value: expenseOccurredOn,
      onResolved: setExpenseOccurredOn,
    })
    const success = await props.onSubmit({
      direction,
      amount: roundMoney(amount),
      occurredAt,
      ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(selectedRelatedEntity
        ? {
            relatedEntityType: selectedRelatedEntity.type,
            relatedEntityId: selectedRelatedEntity.id,
            relatedEntityName: selectedRelatedEntity.name,
          }
        : {}),
      allocations: [
        {
          subjectKey: selectedSubject.subjectKey,
          subjectName: selectedSubject.subjectName,
          subjectType: selectedSubject.subjectType,
          amount: roundMoney(amount),
        },
      ],
    })
    if (success) {
      setSelectedSubjectKey('')
      setRelatedEntityId('')
      setAmount(0)
      setCounterparty('')
      setDescription('')
      setShowDetails(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle
          icon={ReceiptText}
          eyebrow="记账"
          title="本期账本"
          aside={
            selectedPeriod ? (
              <button
                type="button"
                onClick={props.onToggleLock}
                className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700"
              >
                {isLocked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {isLocked ? '解锁期间' : '锁定期间'}
              </button>
            ) : null
          }
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
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="计划收入" value={formatCurrency(selectedPeriod.plannedRevenue)} />
            <StatCard label="计划成本" value={formatCurrency(selectedPeriod.plannedCost)} />
            <StatCard label="实际收入" value={formatCurrency(selectedPeriod.actualRevenue)} />
            <StatCard label="实际成本" value={formatCurrency(selectedPeriod.actualCost)} />
          </div>
        ) : null}
      </Panel>

      <Panel>
        <SectionTitle icon={WalletCards} eyebrow="录入" title="记一笔" />
        <div className="mt-5 space-y-4">
          <SegmentTabs value={direction} items={directionTabs} onChange={setDirection} />

          {direction === 'income' ? (
            <IncomeEntrySection
              rows={memberRevenueRows}
              occurredOn={incomeOccurredOn}
              occurredOnInputRef={incomeOccurredOnInputRef}
              plannedRevenue={memberRevenueSummary.plannedRevenue}
              postedAmount={memberRevenueSummary.postedAmount}
              draftCommission={memberRevenueSummary.draftCommission}
              isLocked={isLocked}
              loading={props.loading}
              onOccurredOnChange={setIncomeOccurredOn}
              onMemberUnitsChange={setMemberDraftUnits}
              onFillPlannedMember={fillPlannedMemberUnits}
              onSubmitMember={(memberId) => void handleSubmitMemberIncome(memberId)}
            />
          ) : (
            <ExpenseComposer
              isLocked={isLocked}
              loading={props.loading}
              categoryOptions={categoryOptions}
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
              visibleSubjects={visibleSubjects}
              selectedSubjectKey={selectedSubjectKey}
              selectedSubject={selectedSubject}
              postedAmountsBySubject={postedAmountsBySubject}
              relatedOptions={relatedOptions}
              relatedEntityId={relatedEntityId}
              onSelectSubject={handleSubjectSelect}
              onSelectEntity={handleRelatedEntitySelect}
              relatedSelectionRequired={relatedSelectionRequired}
              selectedRelatedEntity={selectedRelatedEntity}
              plannedReference={plannedReference}
              selectedPostedAmount={selectedPostedAmount}
              selectedGapAmount={selectedGapAmount}
              expenseOccurredOn={expenseOccurredOn}
              expenseOccurredOnInputRef={expenseOccurredOnInputRef}
              onExpenseOccurredOnChange={setExpenseOccurredOn}
              amount={amount}
              onAmountChange={setAmount}
              counterparty={counterparty}
              onCounterpartyChange={setCounterparty}
              description={description}
              onDescriptionChange={setDescription}
              showDetails={showDetails}
              onToggleDetails={() => setShowDetails((current) => !current)}
              canSubmit={canSubmit}
              onSubmit={() => void handleSubmitExpense()}
            />
          )}
        </div>
      </Panel>

      <HistorySection historyGroups={historyGroups} isLocked={isLocked} onVoid={props.onVoid} />
    </div>
  )
}

function ExpenseComposer(props: {
  isLocked: boolean
  loading: boolean
  categoryOptions: Array<{ value: SubjectCategory; label: string }>
  selectedCategory: SubjectCategory
  onSelectCategory: (value: SubjectCategory) => void
  visibleSubjects: SubjectResponse[]
  selectedSubjectKey: string
  selectedSubject: SubjectResponse | null
  postedAmountsBySubject: Map<string, number>
  relatedOptions: RelatedEntityOption[]
  relatedEntityId: string
  onSelectSubject: (subject: SubjectResponse) => void
  onSelectEntity: (entity: RelatedEntityOption) => void
  relatedSelectionRequired: boolean
  selectedRelatedEntity: RelatedEntityOption | null
  plannedReference: number
  selectedPostedAmount: number
  selectedGapAmount: number
  expenseOccurredOn: string
  expenseOccurredOnInputRef: RefObject<HTMLInputElement | null>
  onExpenseOccurredOnChange: (value: string) => void
  amount: number
  onAmountChange: (value: number) => void
  counterparty: string
  onCounterpartyChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  showDetails: boolean
  onToggleDetails: () => void
  canSubmit: boolean
  onSubmit: () => void
}) {
  return (
    <>
      {props.categoryOptions.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {props.categoryOptions.map((item) => (
            <button
              key={item.value}
              type="button"
              disabled={props.isLocked}
              onClick={() => props.onSelectCategory(item.value)}
              className={cx(
                'rounded-full border px-3 py-2 text-sm font-semibold transition',
                props.selectedCategory === item.value
                  ? 'border-amber-300 bg-amber-100 text-amber-800'
                  : 'border-stone-900/10 bg-stone-50 text-stone-600 hover:bg-white',
                props.isLocked && 'cursor-not-allowed opacity-60',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-stone-950">选择科目</h3>
          <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
            {props.visibleSubjects.length} 项
          </span>
        </div>

        <div className="mt-4 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
          {props.visibleSubjects.map((subject) => (
            <button
              key={subject.subjectKey}
              type="button"
              disabled={props.isLocked}
              onClick={() => props.onSelectSubject(subject)}
              className={cx(
                'rounded-[18px] border px-3 py-2.5 text-left transition',
                props.selectedSubjectKey === subject.subjectKey
                  ? 'border-stone-950 bg-stone-950 text-white shadow-[0_12px_28px_rgba(41,37,36,0.14)]'
                  : 'border-stone-900/10 bg-white text-stone-900 hover:bg-stone-100',
                props.isLocked && 'cursor-not-allowed opacity-60',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{subject.subjectName}</span>
                <span
                  className={
                    props.selectedSubjectKey === subject.subjectKey
                      ? 'rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100'
                      : 'rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-500'
                  }
                >
                  {formatCurrency(subject.plannedAmount)}
                </span>
              </div>
              <div
                className={
                  props.selectedSubjectKey === subject.subjectKey
                    ? 'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-200'
                    : 'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500'
                }
              >
                <span>已记 {formatCurrency(props.postedAmountsBySubject.get(subject.subjectKey) ?? 0)}</span>
                <span>剩余 {formatCurrency(subject.plannedAmount - (props.postedAmountsBySubject.get(subject.subjectKey) ?? 0))}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {props.relatedOptions.length > 0 ? (
        <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-stone-950">
              {props.selectedRelatedEntity?.type === 'employee' || getRelatedEntityType(props.selectedSubjectKey) === 'employee'
                ? '归属员工'
                : '归属成员'}
            </h3>
            <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
              选中后带入计划金额
            </span>
          </div>

          <div className="mt-4 grid gap-2 lg:grid-cols-2 xl:grid-cols-4">
            {props.relatedOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={props.isLocked}
                onClick={() => props.onSelectEntity(option)}
                className={cx(
                  'rounded-[18px] border px-3 py-2.5 text-left transition',
                  props.relatedEntityId === option.id
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-stone-900/10 bg-white hover:bg-stone-100',
                  props.isLocked && 'cursor-not-allowed opacity-60',
                )}
              >
                <div className="text-sm font-semibold text-stone-950">{option.name}</div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-stone-500">
                  <span>{option.caption}</span>
                  <span className="font-semibold text-stone-700">{formatCurrency(option.plannedAmount)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-[28px] border border-stone-900/10 bg-stone-950 p-4 text-white shadow-[0_18px_50px_rgba(41,37,36,0.18)]">
        <div className="flex flex-wrap gap-2">
          <LedgerPill dark label="科目" value={props.selectedSubject?.subjectName ?? '待选择'} />
          <LedgerPill dark label={props.relatedSelectionRequired ? '归属对象' : '归属'} value={props.selectedRelatedEntity?.name ?? (props.relatedSelectionRequired ? '待选择' : '无需')} />
          <LedgerPill dark label="计划参考" value={props.plannedReference > 0 ? formatCurrency(props.plannedReference) : '无'} />
          <LedgerPill dark label="本期已记" value={props.selectedSubject ? formatCurrency(props.selectedPostedAmount) : '无'} />
          <LedgerPill dark label="剩余" value={props.selectedSubject ? formatCurrency(props.selectedGapAmount) : '无'} tone="accent" />
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-[180px_minmax(0,1fr)_220px_132px] xl:items-end">
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-200">业务发生日</span>
            <input
              ref={props.expenseOccurredOnInputRef}
              type="date"
              value={props.expenseOccurredOn}
              disabled={props.isLocked}
              onInput={(event) => props.onExpenseOccurredOnChange((event.target as HTMLInputElement).value)}
              onChange={(event) => props.onExpenseOccurredOnChange(event.target.value)}
              className="h-11 rounded-2xl border border-white/10 bg-white px-4 text-sm font-semibold text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={props.isLocked}
              onClick={props.onToggleDetails}
              className="rounded-full border border-white/10 bg-white/8 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.showDetails ? '收起补充信息' : '补充对方与备注'}
            </button>
            {!props.selectedSubject ? <span className="text-xs font-medium text-stone-300">先选科目，再录金额。</span> : null}
          </div>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-200">金额</span>
            <CompactNumberInput
              value={props.amount}
              onChange={props.onAmountChange}
              min={0}
              step={0.01}
              className="h-11 rounded-2xl border-white/10 bg-white"
              inputClassName="text-lg font-semibold"
              align="right"
            />
          </label>

          <button
            type="button"
            onClick={props.onSubmit}
            disabled={!props.canSubmit}
            className="inline-flex h-11 items-center justify-center rounded-2xl bg-amber-300 px-4 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-stone-400"
          >
            {props.loading ? '保存中...' : '确认入账'}
          </button>
        </div>

        {props.showDetails ? (
          <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-200">对方单位</span>
              <div className="relative">
                <Building2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                <input
                  disabled={props.isLocked}
                  value={props.counterparty}
                  onChange={(event) => props.onCounterpartyChange(event.target.value)}
                  className="h-11 w-full rounded-2xl border border-white/10 bg-white px-11 pr-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-200">备注</span>
              <textarea
                disabled={props.isLocked}
                value={props.description}
                onChange={(event) => props.onDescriptionChange(event.target.value)}
                className="min-h-24 rounded-2xl border border-white/10 bg-white px-4 py-3 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>
        ) : null}
      </section>
    </>
  )
}

function IncomeEntrySection(props: {
  rows: MemberRevenueRow[]
  occurredOn: string
  occurredOnInputRef: RefObject<HTMLInputElement | null>
  plannedRevenue: number
  postedAmount: number
  draftCommission: number
  isLocked: boolean
  loading: boolean
  onOccurredOnChange: (value: string) => void
  onMemberUnitsChange: (memberId: string, channel: keyof MemberIncomeDraft, value: number) => void
  onFillPlannedMember: (memberId: string, offlineUnits: number, onlineUnits: number) => void
  onSubmitMember: (memberId: string) => void
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-stone-950">团员收入台账</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-xs font-semibold tracking-[0.16em] text-stone-500">业务发生日</span>
            <input
              ref={props.occurredOnInputRef}
              type="date"
              value={props.occurredOn}
              disabled={props.isLocked}
              onInput={(event) => props.onOccurredOnChange((event.target as HTMLInputElement).value)}
              onChange={(event) => props.onOccurredOnChange(event.target.value)}
              className="h-10 rounded-2xl border border-stone-900/10 bg-white px-3 text-sm font-semibold text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <LedgerPill label="计划收入" value={formatCurrency(props.plannedRevenue)} />
          <LedgerPill label="已记收入" value={formatCurrency(props.postedAmount)} />
          <LedgerPill label="待计提提成" value={formatCurrency(props.draftCommission)} tone="accent" />
        </div>
      </div>

      {props.rows.length > 0 ? (
        <>
          <div className="mt-4 hidden overflow-hidden rounded-[20px] border border-stone-900/10 bg-white md:block">
            <table className="w-full table-fixed border-collapse text-[12px]">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead className="bg-stone-100/90 text-stone-600">
                <tr className="border-b border-stone-900/10">
                  <HistoryHeader>团员</HistoryHeader>
                  <HistoryHeader align="right">计划收入</HistoryHeader>
                  <HistoryHeader align="right">已记收入</HistoryHeader>
                  <HistoryHeader align="center">线下张数</HistoryHeader>
                  <HistoryHeader align="center">线上张数</HistoryHeader>
                  <HistoryHeader align="right">本次收入</HistoryHeader>
                  <HistoryHeader align="right">自动提成</HistoryHeader>
                  <HistoryHeader align="center">操作</HistoryHeader>
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row) => (
                  <tr key={row.member.memberId} className="border-b border-stone-900/10 last:border-none">
                    <HistoryCell className="min-w-0 whitespace-nowrap text-stone-950">
                      <div className="flex items-center gap-2 overflow-hidden">
                        <span className="shrink-0 font-semibold">{row.member.name}</span>
                        <span className="truncate text-[11px] text-stone-500">
                          {(row.member.employmentType === 'salary' ? '底薪' : '兼职') + ` · 线${formatUnits(row.plannedOfflineUnits)} / 上${formatUnits(row.plannedOnlineUnits)}`}
                        </span>
                      </div>
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold text-stone-950">{formatCurrency(row.plannedAmount)}</HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap text-stone-700">{formatCurrency(row.postedAmount)}</HistoryCell>
                    <HistoryCell align="center">
                      <CompactNumberInput
                        value={row.draftOfflineUnits}
                        onChange={(value) => props.onMemberUnitsChange(row.member.memberId, 'offlineUnits', value)}
                        min={0}
                        step={1}
                        size="sm"
                        className="h-8 rounded-xl bg-stone-50"
                        align="right"
                        inputClassName="text-sm font-semibold"
                      />
                    </HistoryCell>
                    <HistoryCell align="center">
                      <CompactNumberInput
                        value={row.draftOnlineUnits}
                        onChange={(value) => props.onMemberUnitsChange(row.member.memberId, 'onlineUnits', value)}
                        min={0}
                        step={1}
                        size="sm"
                        className="h-8 rounded-xl bg-stone-50"
                        align="right"
                        inputClassName="text-sm font-semibold"
                      />
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold text-stone-950">{formatCurrency(row.draftAmount)}</HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold text-amber-700">{formatCurrency(row.draftCommission)}</HistoryCell>
                    <HistoryCell align="center">
                      <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={props.isLocked}
                          onClick={() => props.onFillPlannedMember(row.member.memberId, row.plannedOfflineUnits, row.plannedOnlineUnits)}
                          className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          计划
                        </button>
                        <button
                          type="button"
                          disabled={props.isLocked || row.draftAmount <= 0 || props.loading}
                          onClick={() => props.onSubmitMember(row.member.memberId)}
                          className="rounded-full border border-stone-900/10 bg-stone-950 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          入账
                        </button>
                      </div>
                    </HistoryCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-3 md:hidden">
            {props.rows.map((row) => (
              <article key={row.member.memberId} className="rounded-[20px] border border-stone-900/10 bg-white p-4">
                <div className="truncate text-base font-semibold text-stone-950">{row.member.name}</div>
                <div className="truncate text-xs text-stone-500">
                  {(row.member.employmentType === 'salary' ? '底薪' : '兼职') + ` · 线${formatUnits(row.plannedOfflineUnits)} / 上${formatUnits(row.plannedOnlineUnits)}`}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <LedgerPill label="计划收入" value={formatCurrency(row.plannedAmount)} />
                  <LedgerPill label="本次收入" value={formatCurrency(row.draftAmount)} />
                  <LedgerPill label="自动提成" value={formatCurrency(row.draftCommission)} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold tracking-[0.16em] text-stone-500">线下张数</span>
                    <CompactNumberInput
                      value={row.draftOfflineUnits}
                      onChange={(value) => props.onMemberUnitsChange(row.member.memberId, 'offlineUnits', value)}
                      min={0}
                      step={1}
                      className="h-11 rounded-2xl bg-stone-50"
                      align="right"
                      inputClassName="font-semibold"
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold tracking-[0.16em] text-stone-500">线上张数</span>
                    <CompactNumberInput
                      value={row.draftOnlineUnits}
                      onChange={(value) => props.onMemberUnitsChange(row.member.memberId, 'onlineUnits', value)}
                      min={0}
                      step={1}
                      className="h-11 rounded-2xl bg-stone-50"
                      align="right"
                      inputClassName="font-semibold"
                    />
                  </label>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={props.isLocked}
                    onClick={() => props.onFillPlannedMember(row.member.memberId, row.plannedOfflineUnits, row.plannedOnlineUnits)}
                    className="flex-1 rounded-2xl border border-stone-900/10 bg-stone-50 px-3 py-2.5 text-sm font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    带入计划
                  </button>
                  <button
                    type="button"
                    disabled={props.isLocked || row.draftAmount <= 0 || props.loading}
                    onClick={() => props.onSubmitMember(row.member.memberId)}
                    className="flex-1 rounded-2xl border border-stone-900/10 bg-stone-950 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    入账
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-[20px] border border-dashed border-stone-900/10 bg-white/80 px-4 py-10 text-center text-sm text-stone-500">
          当前期间没有可按团员记录的收入计划。
        </div>
      )}
    </section>
  )
}

function HistorySection(props: {
  historyGroups: Array<{ entry: EntryResponse; derivedEntries: EntryResponse[] }>
  isLocked: boolean
  onVoid: (entryId: string) => void
}) {
  return (
    <Panel>
      <SectionTitle icon={ReceiptText} eyebrow="历史" title="账本记录" />

      {props.historyGroups.length > 0 ? (
        <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10 bg-white">
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-[12px]">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[8%]" />
                <col className="w-[35%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[8%]" />
              </colgroup>
              <thead className="bg-stone-100/90 text-stone-600">
                <tr className="border-b border-stone-900/10">
                  <HistoryHeader>时间</HistoryHeader>
                  <HistoryHeader>方向</HistoryHeader>
                  <HistoryHeader>摘要</HistoryHeader>
                  <HistoryHeader>关联对象</HistoryHeader>
                  <HistoryHeader align="right">金额</HistoryHeader>
                  <HistoryHeader align="center">状态</HistoryHeader>
                  <HistoryHeader align="center">操作</HistoryHeader>
                </tr>
              </thead>
              <tbody>
                {props.historyGroups.map(({ entry, derivedEntries }) => (
                  <tr key={entry.id} className="border-b border-stone-900/10 last:border-none">
                    <HistoryCell className="whitespace-nowrap text-stone-500">
                      {formatEntryDate(entry.occurredAt)} · 记账 {formatPostedAt(entry.postedAt)}
                    </HistoryCell>
                    <HistoryCell>
                      <span
                        className={cx(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          entry.direction === 'income'
                            ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border border-rose-200 bg-rose-50 text-rose-700',
                        )}
                      >
                        {entry.direction === 'income' ? '收入' : '支出'}
                      </span>
                    </HistoryCell>
                    <HistoryCell className="min-w-0">
                      <div className="truncate font-medium text-stone-900">{buildHistorySummary(entry, derivedEntries)}</div>
                    </HistoryCell>
                    <HistoryCell className="truncate text-stone-600">{relatedEntityLabel(entry)}</HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold text-stone-950">
                      {formatCurrency(entry.amount)}
                    </HistoryCell>
                    <HistoryCell align="center">
                      <span
                        className={cx(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          entry.status === 'voided'
                            ? 'border border-stone-900/10 bg-stone-100 text-stone-500'
                            : 'border border-amber-200 bg-amber-50 text-amber-800',
                        )}
                      >
                        {entry.status === 'voided' ? '已作废' : '已过账'}
                      </span>
                    </HistoryCell>
                    <HistoryCell align="center">
                      {entry.status !== 'voided' ? (
                        <button
                          type="button"
                          disabled={props.isLocked}
                          onClick={() => props.onVoid(entry.id)}
                          className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          作废
                        </button>
                      ) : (
                        <span className="text-xs font-semibold text-stone-400">已结束</span>
                      )}
                    </HistoryCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden">
            {props.historyGroups.map(({ entry, derivedEntries }, index) => (
              <article
                key={entry.id}
                className={cx('px-4 py-3', index !== props.historyGroups.length - 1 && 'border-b border-stone-900/10')}
              >
                <div className="truncate text-sm font-semibold text-stone-950">{buildHistorySummary(entry, derivedEntries)}</div>
                <div className="mt-1 truncate text-xs text-stone-500">
                  {formatEntryDate(entry.occurredAt)} · 记账 {formatPostedAt(entry.postedAt)} · {relatedEntityLabel(entry)}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-stone-950">{formatCurrency(entry.amount)}</div>
                  {entry.status !== 'voided' ? (
                    <button
                      type="button"
                      disabled={props.isLocked}
                      onClick={() => props.onVoid(entry.id)}
                      className="rounded-full border border-stone-900/10 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      作废
                    </button>
                  ) : (
                    <span className="text-xs font-semibold text-stone-400">已作废</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-[24px] border border-dashed border-stone-900/10 bg-stone-50/80 px-4 py-10 text-center text-sm text-stone-500">
          当前期间还没有过账记录。
        </div>
      )}
    </Panel>
  )
}

function LedgerPill(props: { label: string; value: string; tone?: 'default' | 'accent'; dark?: boolean }) {
  return (
    <div
      className={cx(
        'rounded-[18px] border px-4 py-3',
        props.dark
          ? props.tone === 'accent'
            ? 'border-amber-300/40 bg-amber-300/12'
            : 'border-white/10 bg-white/8'
          : props.tone === 'accent'
            ? 'border-amber-200 bg-amber-50'
            : 'border-stone-900/10 bg-white',
      )}
    >
      <p className={props.dark ? 'text-xs font-semibold tracking-[0.16em] text-stone-400' : 'text-xs font-semibold tracking-[0.16em] text-stone-500'}>
        {props.label}
      </p>
      <p className={cx('mt-1.5 text-sm font-semibold', props.dark ? (props.tone === 'accent' ? 'text-amber-200' : 'text-white') : 'text-stone-950')}>
        {props.value}
      </p>
    </div>
  )
}

function HistoryHeader(props: { children: string; align?: 'left' | 'center' | 'right' }) {
  return (
    <th
      className={cx(
        'whitespace-nowrap px-3 py-2 text-[11px] font-semibold tracking-[0.12em]',
        props.align === 'right' ? 'text-right' : props.align === 'center' ? 'text-center' : 'text-left',
      )}
    >
      {props.children}
    </th>
  )
}

function HistoryCell(props: { children: ReactNode; className?: string; align?: 'left' | 'center' | 'right' }) {
  return (
    <td
      className={cx(
        'px-3 py-2 align-middle',
        props.align === 'right' ? 'text-right' : props.align === 'center' ? 'text-center' : 'text-left',
        props.className,
      )}
    >
      {props.children}
    </td>
  )
}

function allocationTitle(allocations: EntryAllocation[]) {
  if (allocations.length === 0) return '未挂科目'
  const keys = new Set(allocations.map((allocation) => allocation.subjectKey))
  if (keys.has('revenue.offline_sales') && keys.has('revenue.online_sales') && keys.size === 2) return '团员营收'
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
  return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)} ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}`
}

function relatedEntityLabel(entry: EntryResponse) {
  const parts = [entry.relatedEntityName, entry.counterparty].filter((value): value is string => Boolean(value))
  return parts.length > 0 ? parts.join(' / ') : '—'
}

function compareSubjects(left: SubjectResponse, right: SubjectResponse) {
  return getPriority(left.subjectKey) - getPriority(right.subjectKey) || right.plannedAmount - left.plannedAmount || left.subjectName.localeCompare(right.subjectName, 'zh-CN')
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
  if (subject.subjectType === 'revenue') return 'revenue'
  if (subject.subjectKey.startsWith('cost.member.')) return 'member'
  if (subject.subjectKey.startsWith('cost.employee.')) return 'employee'
  if (subject.subjectKey.startsWith('cost.training.')) return 'training'
  if (subject.subjectKey.startsWith('cost.stage.')) return 'stage'
  if (subject.subjectKey.startsWith('cost.operating.')) return 'operating'
  return 'other'
}

function getRelatedEntityType(subjectKey: string): 'teamMember' | 'employee' | null {
  if (subjectKey.startsWith('cost.member.')) return 'teamMember'
  if (subjectKey.startsWith('cost.employee.')) return 'employee'
  return null
}

function buildRelatedEntityOptions(subjectKey: string, month: MonthlyScenarioResult | null) {
  if (!month) return [] satisfies RelatedEntityOption[]
  if (subjectKey === 'cost.member.base_pay') return month.members.map((member) => ({ id: member.memberId, name: member.name, type: 'teamMember' as const, caption: '成员底薪', plannedAmount: member.basePayCost }))
  if (subjectKey === 'cost.member.travel') return month.members.map((member) => ({ id: member.memberId, name: member.name, type: 'teamMember' as const, caption: '成员路费', plannedAmount: member.travelCost }))
  if (subjectKey === 'cost.employee.base_pay') return month.employees.map((employee) => ({ id: employee.employeeId, name: employee.name, type: 'employee' as const, caption: `${employee.role} · 月薪`, plannedAmount: employee.basePayCost }))
  if (subjectKey === 'cost.employee.per_event') return month.employees.map((employee) => ({ id: employee.employeeId, name: employee.name, type: 'employee' as const, caption: `${employee.role} · 场次`, plannedAmount: employee.perEventCost }))
  return [] satisfies RelatedEntityOption[]
}

function compareEntryHistory(left: EntryResponse, right: EntryResponse) {
  return new Date(right.postedAt ?? right.occurredAt).getTime() - new Date(left.postedAt ?? left.occurredAt).getTime()
}

function getMemberCommissionRate(member: MonthlyScenarioResult['members'][number]) {
  if (member.grossSales <= 0 || member.commissionCost <= 0) return 0
  return member.commissionCost / member.grossSales
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function formatUnits(value: number) {
  return Math.abs(value - Math.round(value)) < 0.001 ? String(Math.round(value)) : value.toFixed(1)
}

function getTodayInputDate() {
  const now = new Date()
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

function toOccurredAtIso(dateValue: string) {
  return `${dateValue || getTodayInputDate()}T12:00:00`
}

function resolveOccurredAt(params: { ref: RefObject<HTMLInputElement | null>; value: string; onResolved: (value: string) => void }) {
  const resolvedDate = params.ref.current?.value || params.value || getTodayInputDate()
  if (resolvedDate !== params.value) params.onResolved(resolvedDate)
  return toOccurredAtIso(resolvedDate)
}
