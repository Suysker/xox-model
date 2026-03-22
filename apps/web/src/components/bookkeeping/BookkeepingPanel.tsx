import { Building2, Lock, LockOpen, ReceiptText, Search, WalletCards } from 'lucide-react'
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

type MemberExpenseRow = {
  option: RelatedEntityOption
  postedAmount: number
  draftAmount: number
}

type HistoryDirectionFilter = 'all' | 'income' | 'expense'

type HistoryStatusFilter = 'all' | 'posted' | 'voided'

type HistoryGroup = {
  entry: EntryResponse
  derivedEntries: EntryResponse[]
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

export function BookkeepingPanel(props: {
  periods: PeriodResponse[]
  selectedPeriodId: string
  subjects: SubjectResponse[]
  entries: EntryResponse[]
  loading: boolean
  plannedMonthResult: MonthlyScenarioResult | null
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
  const [memberExpenseDrafts, setMemberExpenseDrafts] = useState<Record<string, number>>({})
  const [incomeOccurredOn, setIncomeOccurredOn] = useState(() => getTodayInputDate())
  const [otherIncomeOccurredOn, setOtherIncomeOccurredOn] = useState(() => getTodayInputDate())
  const [otherIncomeSubjectKey, setOtherIncomeSubjectKey] = useState('')
  const [otherIncomeAmount, setOtherIncomeAmount] = useState(0)
  const [otherIncomeCounterparty, setOtherIncomeCounterparty] = useState('')
  const [otherIncomeDescription, setOtherIncomeDescription] = useState('')
  const [showOtherIncomeDetails, setShowOtherIncomeDetails] = useState(false)
  const [expenseOccurredOn, setExpenseOccurredOn] = useState(() => getTodayInputDate())
  const incomeOccurredOnInputRef = useRef<HTMLInputElement | null>(null)
  const otherIncomeOccurredOnInputRef = useRef<HTMLInputElement | null>(null)
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
    () => buildRelatedEntityOptions(selectedSubjectKey, props.plannedMonthResult),
    [props.plannedMonthResult, selectedSubjectKey],
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
  const selectedOtherIncomeSubject = subjectOptions.find((subject) => subject.subjectKey === otherIncomeSubjectKey) ?? null
  const otherIncomePostedAmount = selectedOtherIncomeSubject
    ? postedAmountsBySubject.get(selectedOtherIncomeSubject.subjectKey) ?? 0
    : 0
  const otherIncomeCanSubmit = Boolean(selectedOtherIncomeSubject && otherIncomeAmount > 0 && !props.loading && !isLocked)
  const showMemberExpenseTable = direction === 'expense' && getRelatedEntityType(selectedSubjectKey) === 'teamMember' && Boolean(selectedSubject)

  const memberExpenseRows = useMemo<MemberExpenseRow[]>(
    () =>
      !showMemberExpenseTable
        ? []
        : relatedOptions.map((option) => ({
            option,
            postedAmount: postedAmountsBySubjectAndEntity.get(getEntityAllocationKey(selectedSubjectKey, option.id)) ?? 0,
            draftAmount: memberExpenseDrafts[getEntityAllocationKey(selectedSubjectKey, option.id)] ?? 0,
          })),
    [memberExpenseDrafts, postedAmountsBySubjectAndEntity, relatedOptions, selectedSubjectKey, showMemberExpenseTable],
  )

  const memberExpenseSummary = useMemo(
    () =>
      memberExpenseRows.reduce(
        (sum, row) => ({
          plannedAmount: sum.plannedAmount + row.option.plannedAmount,
          postedAmount: sum.postedAmount + row.postedAmount,
          draftAmount: sum.draftAmount + row.draftAmount,
        }),
        { plannedAmount: 0, postedAmount: 0, draftAmount: 0 },
      ),
    [memberExpenseRows],
  )

  const memberRevenueRows = useMemo<MemberRevenueRow[]>(
    () =>
      (props.plannedMonthResult?.members ?? []).map((member) => {
        const draft = memberIncomeDrafts[member.memberId] ?? { offlineUnits: 0, onlineUnits: 0 }
        const plannedOfflineUnits = member.monthlyUnits
        const plannedOnlineUnits = member.monthlyUnits * (props.plannedMonthResult?.onlineSalesFactor ?? 0)
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
      props.plannedMonthResult,
      props.offlineUnitPrice,
      props.onlineUnitPrice,
    ],
  )

  const memberRevenueSummary = useMemo(
    () =>
      memberRevenueRows.reduce(
        (sum, row) => ({
          plannedRevenue: sum.plannedRevenue + row.plannedAmount,
          plannedOfflineUnits: sum.plannedOfflineUnits + row.plannedOfflineUnits,
          plannedOnlineUnits: sum.plannedOnlineUnits + row.plannedOnlineUnits,
          postedAmount: sum.postedAmount + row.postedAmount,
          draftCommission: sum.draftCommission + row.draftCommission,
        }),
        { plannedRevenue: 0, plannedOfflineUnits: 0, plannedOnlineUnits: 0, postedAmount: 0, draftCommission: 0 },
      ),
    [memberRevenueRows],
  )

  const historyGroups = useMemo<HistoryGroup[]>(() => {
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
    setMemberExpenseDrafts({})
  }, [props.selectedPeriodId])

  useEffect(() => {
    if (direction !== 'income') {
      return
    }

    if (subjectOptions.length === 0) {
      if (otherIncomeSubjectKey) {
        setOtherIncomeSubjectKey('')
      }
      return
    }

    if (!subjectOptions.some((subject) => subject.subjectKey === otherIncomeSubjectKey)) {
      setOtherIncomeSubjectKey(subjectOptions[0]?.subjectKey ?? '')
    }
  }, [direction, otherIncomeSubjectKey, subjectOptions])

  useEffect(() => {
    if (direction !== 'income') {
      return
    }

    setOtherIncomeAmount(0)
    setOtherIncomeCounterparty('')
    setOtherIncomeDescription('')
    setShowOtherIncomeDetails(false)
  }, [direction, props.selectedPeriodId])

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

  function setMemberExpenseDraft(subjectKey: string, entityId: string, value: number) {
    const key = getEntityAllocationKey(subjectKey, entityId)
    setMemberExpenseDrafts((current) => ({
      ...current,
      [key]: Math.max(0, roundMoney(value)),
    }))
  }

  function fillPlannedMemberExpense(subjectKey: string, entityId: string, plannedAmount: number) {
    const key = getEntityAllocationKey(subjectKey, entityId)
    setMemberExpenseDrafts((current) => ({
      ...current,
      [key]: Math.max(0, roundMoney(plannedAmount)),
    }))
  }

  async function handleSubmitMemberIncome(memberId: string) {
    if (!offlineRevenueSubject) return

    const member = props.plannedMonthResult?.members.find((item) => item.memberId === memberId)
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

  async function handleSubmitOtherIncome() {
    if (!selectedOtherIncomeSubject || otherIncomeAmount <= 0) return

    const occurredAt = resolveOccurredAt({
      ref: otherIncomeOccurredOnInputRef,
      value: otherIncomeOccurredOn,
      onResolved: setOtherIncomeOccurredOn,
    })

    const success = await props.onSubmit({
      direction: 'income',
      amount: roundMoney(otherIncomeAmount),
      occurredAt,
      ...(otherIncomeCounterparty ? { counterparty: otherIncomeCounterparty } : {}),
      ...(otherIncomeDescription ? { description: otherIncomeDescription } : {}),
      allocations: [
        {
          subjectKey: selectedOtherIncomeSubject.subjectKey,
          subjectName: selectedOtherIncomeSubject.subjectName,
          subjectType: selectedOtherIncomeSubject.subjectType,
          amount: roundMoney(otherIncomeAmount),
        },
      ],
    })

    if (success) {
      setOtherIncomeAmount(0)
      setOtherIncomeCounterparty('')
      setOtherIncomeDescription('')
      setShowOtherIncomeDetails(false)
    }
  }

  async function handleSubmitMemberExpense(entityId: string) {
    if (!selectedSubject || !showMemberExpenseTable) return

    const option = relatedOptions.find((item) => item.id === entityId)
    const draftKey = getEntityAllocationKey(selectedSubject.subjectKey, entityId)
    const draftAmount = memberExpenseDrafts[draftKey] ?? 0
    if (!option || draftAmount <= 0) return

    const occurredAt = resolveOccurredAt({
      ref: expenseOccurredOnInputRef,
      value: expenseOccurredOn,
      onResolved: setExpenseOccurredOn,
    })

    const success = await props.onSubmit({
      direction: 'expense',
      amount: roundMoney(draftAmount),
      occurredAt,
      ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      relatedEntityType: option.type,
      relatedEntityId: option.id,
      relatedEntityName: option.name,
      allocations: [
        {
          subjectKey: selectedSubject.subjectKey,
          subjectName: selectedSubject.subjectName,
          subjectType: selectedSubject.subjectType,
          amount: roundMoney(draftAmount),
        },
      ],
    })

    if (success) {
      setMemberExpenseDrafts((current) => {
        const next = { ...current }
        delete next[draftKey]
        return next
      })
      setCounterparty('')
      setDescription('')
      setShowDetails(false)
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
            <>
              <IncomeEntrySection
                rows={memberRevenueRows}
                occurredOn={incomeOccurredOn}
                occurredOnInputRef={incomeOccurredOnInputRef}
                plannedRevenue={memberRevenueSummary.plannedRevenue}
                plannedOfflineUnits={memberRevenueSummary.plannedOfflineUnits}
                plannedOnlineUnits={memberRevenueSummary.plannedOnlineUnits}
                postedAmount={memberRevenueSummary.postedAmount}
                draftCommission={memberRevenueSummary.draftCommission}
                isLocked={isLocked}
                loading={props.loading}
                onOccurredOnChange={setIncomeOccurredOn}
                onMemberUnitsChange={setMemberDraftUnits}
                onFillPlannedMember={fillPlannedMemberUnits}
                onSubmitMember={(memberId) => void handleSubmitMemberIncome(memberId)}
              />
              <OtherIncomeComposer
                subjects={subjectOptions}
                selectedSubjectKey={otherIncomeSubjectKey}
                selectedSubject={selectedOtherIncomeSubject}
                postedAmount={otherIncomePostedAmount}
                occurredOn={otherIncomeOccurredOn}
                occurredOnInputRef={otherIncomeOccurredOnInputRef}
                onOccurredOnChange={setOtherIncomeOccurredOn}
                amount={otherIncomeAmount}
                onAmountChange={setOtherIncomeAmount}
                counterparty={otherIncomeCounterparty}
                onCounterpartyChange={setOtherIncomeCounterparty}
                description={otherIncomeDescription}
                onDescriptionChange={setOtherIncomeDescription}
                showDetails={showOtherIncomeDetails}
                onToggleDetails={() => setShowOtherIncomeDetails((current) => !current)}
                isLocked={isLocked}
                loading={props.loading}
                canSubmit={otherIncomeCanSubmit}
                onSelectSubject={setOtherIncomeSubjectKey}
                onSubmit={() => void handleSubmitOtherIncome()}
              />
            </>
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
              showMemberExpenseTable={showMemberExpenseTable}
              memberExpenseRows={memberExpenseRows}
              memberExpensePlannedAmount={memberExpenseSummary.plannedAmount}
              memberExpensePostedAmount={memberExpenseSummary.postedAmount}
              memberExpenseDraftAmount={memberExpenseSummary.draftAmount}
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
              onMemberAmountChange={setMemberExpenseDraft}
              onFillPlannedMemberExpense={fillPlannedMemberExpense}
              onSubmitMemberExpense={(entityId) => void handleSubmitMemberExpense(entityId)}
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
  showMemberExpenseTable: boolean
  memberExpenseRows: MemberExpenseRow[]
  memberExpensePlannedAmount: number
  memberExpensePostedAmount: number
  memberExpenseDraftAmount: number
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
  onMemberAmountChange: (subjectKey: string, entityId: string, value: number) => void
  onFillPlannedMemberExpense: (subjectKey: string, entityId: string, plannedAmount: number) => void
  onSubmitMemberExpense: (entityId: string) => void
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
          <h3 className="text-lg font-semibold text-stone-950">先选预算科目</h3>
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
                  ? 'border-amber-300 bg-amber-50 text-stone-950 shadow-[0_12px_28px_rgba(245,158,11,0.12)]'
                  : 'border-stone-900/10 bg-white text-stone-900 hover:bg-stone-100',
                props.isLocked && 'cursor-not-allowed opacity-60',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{subject.subjectName}</span>
                <span
                  className={
                    props.selectedSubjectKey === subject.subjectKey
                      ? 'rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-700'
                      : 'rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-500'
                  }
                >
                  {formatCurrency(subject.plannedAmount)}
                </span>
              </div>
              <div
                className={
                  props.selectedSubjectKey === subject.subjectKey
                    ? 'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-600'
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

      {props.showMemberExpenseTable ? (
        <MemberExpenseEntrySection
          subject={props.selectedSubject}
          rows={props.memberExpenseRows}
          plannedAmount={props.memberExpensePlannedAmount}
          postedAmount={props.memberExpensePostedAmount}
          draftAmount={props.memberExpenseDraftAmount}
          occurredOn={props.expenseOccurredOn}
          occurredOnInputRef={props.expenseOccurredOnInputRef}
          onOccurredOnChange={props.onExpenseOccurredOnChange}
          showDetails={props.showDetails}
          onToggleDetails={props.onToggleDetails}
          counterparty={props.counterparty}
          onCounterpartyChange={props.onCounterpartyChange}
          description={props.description}
          onDescriptionChange={props.onDescriptionChange}
          isLocked={props.isLocked}
          loading={props.loading}
          subjectKey={props.selectedSubjectKey}
          onAmountChange={props.onMemberAmountChange}
          onFillPlanned={props.onFillPlannedMemberExpense}
          onSubmitRow={props.onSubmitMemberExpense}
        />
      ) : (
        <>
          {props.relatedOptions.length > 0 ? (
            <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-stone-950">
                  {props.selectedRelatedEntity?.type === 'employee' || getRelatedEntityType(props.selectedSubjectKey) === 'employee'
                    ? '再挂到员工'
                    : '再挂到成员'}
                </h3>
                <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
                  选中后自动带入对应计划
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

          <section className="rounded-[28px] border border-amber-200/70 bg-[linear-gradient(135deg,rgba(255,251,235,0.94),rgba(255,255,255,0.98))] p-4 shadow-[0_18px_42px_rgba(245,158,11,0.12)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <LedgerPill label="科目" value={props.selectedSubject?.subjectName ?? '待选择'} />
                <LedgerPill
                  label={props.relatedSelectionRequired ? '归属对象' : '归属'}
                  value={props.selectedRelatedEntity?.name ?? (props.relatedSelectionRequired ? '待选择' : '无需')}
                />
                <LedgerPill label="计划参考" value={props.plannedReference > 0 ? formatCurrency(props.plannedReference) : '无'} />
                <LedgerPill label="本期已记" value={props.selectedSubject ? formatCurrency(props.selectedPostedAmount) : '无'} />
                <LedgerPill label="剩余预算" value={props.selectedSubject ? formatCurrency(props.selectedGapAmount) : '无'} tone="accent" />
              </div>

              <button
                type="button"
                disabled={props.isLocked}
                onClick={props.onToggleDetails}
                className="rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {props.showDetails ? '收起对方与备注' : '补充对方与备注'}
              </button>
            </div>

            <div className="mt-4 grid gap-3 xl:grid-cols-[170px_170px_minmax(0,1fr)_144px] xl:items-end">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-700">业务发生日</span>
                <input
                  ref={props.expenseOccurredOnInputRef}
                  type="date"
                  value={props.expenseOccurredOn}
                  disabled={props.isLocked}
                  onInput={(event) => props.onExpenseOccurredOnChange((event.target as HTMLInputElement).value)}
                  onChange={(event) => props.onExpenseOccurredOnChange(event.target.value)}
                  className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-semibold text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-700">金额</span>
                <CompactNumberInput
                  value={props.amount}
                  onChange={props.onAmountChange}
                  min={0}
                  step={0.01}
                  className="h-11 rounded-2xl bg-white"
                  inputClassName="text-lg font-semibold"
                  align="right"
                />
              </label>

              <div className="flex min-h-11 items-center text-sm font-medium text-stone-500">
                {props.selectedSubject ? '金额会直接挂到当前科目；需要时再补对方单位和备注。' : '先选一个预算科目，再录金额。'}
              </div>

              <button
                type="button"
                onClick={props.onSubmit}
                disabled={!props.canSubmit}
                className="inline-flex h-11 items-center justify-center rounded-2xl bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
              >
                {props.loading ? '保存中...' : '确认入账'}
              </button>
            </div>

            {props.showDetails ? (
              <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)] md:items-end">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-stone-700">对方单位</span>
                  <div className="relative">
                    <Building2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <input
                      disabled={props.isLocked}
                      value={props.counterparty}
                      onChange={(event) => props.onCounterpartyChange(event.target.value)}
                      className="h-11 w-full rounded-2xl border border-stone-900/10 bg-white px-11 pr-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-stone-700">备注</span>
                  <input
                    type="text"
                    disabled={props.isLocked}
                    value={props.description}
                    onChange={(event) => props.onDescriptionChange(event.target.value)}
                    className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
              </div>
            ) : null}
          </section>
        </>
      )}
    </>
  )
}

function IncomeEntrySection(props: {
  rows: MemberRevenueRow[]
  occurredOn: string
  occurredOnInputRef: RefObject<HTMLInputElement | null>
  plannedRevenue: number
  plannedOfflineUnits: number
  plannedOnlineUnits: number
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
          <LedgerPill label="计划总收入" value={formatCurrency(props.plannedRevenue)} />
          <LedgerPill label="线下计划" value={`${formatUnits(props.plannedOfflineUnits)} 张`} />
          <LedgerPill label="线上计划" value={`${formatUnits(props.plannedOnlineUnits)} 张`} />
          <LedgerPill label="已记总收入" value={formatCurrency(props.postedAmount)} />
          <LedgerPill label="待生成提成" value={formatCurrency(props.draftCommission)} tone="accent" />
        </div>
      </div>

      {props.rows.length > 0 ? (
        <>
          <div className="mt-4 hidden overflow-hidden rounded-[20px] border border-stone-900/10 bg-white md:block">
            <table className="w-full table-fixed border-collapse text-[12px]">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="bg-stone-100/90 text-stone-600">
                <tr className="border-b border-stone-900/10">
                  <HistoryHeader>团员</HistoryHeader>
                  <HistoryHeader align="right">计划总收入</HistoryHeader>
                  <HistoryHeader align="right">已记总收入</HistoryHeader>
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
                        <span className="truncate text-[11px] tabular-nums text-stone-500">{buildMemberPlanCaption(row)}</span>
                      </div>
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold tabular-nums text-stone-950">
                      {formatCurrency(row.plannedAmount)}
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap tabular-nums text-stone-700">
                      {formatCurrency(row.postedAmount)}
                    </HistoryCell>
                    <HistoryCell align="center">
                      <CompactNumberInput
                        value={row.draftOfflineUnits}
                        onChange={(value) => props.onMemberUnitsChange(row.member.memberId, 'offlineUnits', value)}
                        min={0}
                        step={1}
                        size="sm"
                        className="mx-auto h-8 max-w-[96px] rounded-xl bg-stone-50"
                        align="center"
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
                        className="mx-auto h-8 max-w-[96px] rounded-xl bg-stone-50"
                        align="center"
                        inputClassName="text-sm font-semibold"
                      />
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold tabular-nums text-stone-950">
                      {formatCurrency(row.draftAmount)}
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold tabular-nums text-amber-700">
                      {formatCurrency(row.draftCommission)}
                    </HistoryCell>
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
                          className="rounded-full border border-stone-900/10 bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
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
                <div className="truncate text-xs tabular-nums text-stone-500">{buildMemberPlanCaption(row)}</div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <LedgerPill label="计划总收入" value={formatCurrency(row.plannedAmount)} />
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
                      align="center"
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
                      align="center"
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
                    计划
                  </button>
                  <button
                    type="button"
                    disabled={props.isLocked || row.draftAmount <= 0 || props.loading}
                    onClick={() => props.onSubmitMember(row.member.memberId)}
                    className="flex-1 rounded-2xl border border-stone-900/10 bg-amber-400 px-3 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
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

function MemberExpenseEntrySection(props: {
  subject: SubjectResponse | null
  subjectKey: string
  rows: MemberExpenseRow[]
  plannedAmount: number
  postedAmount: number
  draftAmount: number
  occurredOn: string
  occurredOnInputRef: RefObject<HTMLInputElement | null>
  onOccurredOnChange: (value: string) => void
  showDetails: boolean
  onToggleDetails: () => void
  counterparty: string
  onCounterpartyChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  isLocked: boolean
  loading: boolean
  onAmountChange: (subjectKey: string, entityId: string, value: number) => void
  onFillPlanned: (subjectKey: string, entityId: string, plannedAmount: number) => void
  onSubmitRow: (entityId: string) => void
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-stone-950">{props.subject ? `${props.subject.subjectName}台账` : '成员支出台账'}</h3>
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
          <LedgerPill label="计划合计" value={formatCurrency(props.plannedAmount)} />
          <LedgerPill label="本期已记" value={formatCurrency(props.postedAmount)} />
          <LedgerPill label="待入账" value={formatCurrency(props.draftAmount)} tone="accent" />
          <button
            type="button"
            disabled={props.isLocked}
            onClick={props.onToggleDetails}
            className="rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.showDetails ? '收起对方与备注' : '补充对方与备注'}
          </button>
        </div>
      </div>

      {props.rows.length > 0 ? (
        <>
          <div className="mt-4 hidden overflow-hidden rounded-[20px] border border-stone-900/10 bg-white md:block">
            <table className="w-full table-fixed border-collapse text-[12px]">
              <colgroup>
                <col className="w-[32%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[20%]" />
              </colgroup>
              <thead className="bg-stone-100/90 text-stone-600">
                <tr className="border-b border-stone-900/10">
                  <HistoryHeader>成员</HistoryHeader>
                  <HistoryHeader align="right">计划参考</HistoryHeader>
                  <HistoryHeader align="right">本期已记</HistoryHeader>
                  <HistoryHeader align="center">本次支出</HistoryHeader>
                  <HistoryHeader align="center">操作</HistoryHeader>
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row) => (
                  <tr key={row.option.id} className="border-b border-stone-900/10 last:border-none">
                    <HistoryCell className="whitespace-nowrap font-semibold text-stone-950">{row.option.name}</HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap font-semibold tabular-nums text-stone-950">
                      {formatCurrency(row.option.plannedAmount)}
                    </HistoryCell>
                    <HistoryCell align="right" className="whitespace-nowrap tabular-nums text-stone-700">
                      {formatCurrency(row.postedAmount)}
                    </HistoryCell>
                    <HistoryCell align="center">
                      <CompactNumberInput
                        value={row.draftAmount}
                        onChange={(value) => props.onAmountChange(props.subjectKey, row.option.id, value)}
                        min={0}
                        step={0.01}
                        size="sm"
                        className="mx-auto h-8 max-w-[116px] rounded-xl bg-stone-50"
                        align="right"
                        inputClassName="text-sm font-semibold"
                      />
                    </HistoryCell>
                    <HistoryCell align="center">
                      <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={props.isLocked}
                          onClick={() => props.onFillPlanned(props.subjectKey, row.option.id, row.option.plannedAmount)}
                          className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          计划
                        </button>
                        <button
                          type="button"
                          disabled={props.isLocked || row.draftAmount <= 0 || props.loading}
                          onClick={() => props.onSubmitRow(row.option.id)}
                          className="rounded-full border border-stone-900/10 bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
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
              <article key={row.option.id} className="rounded-[20px] border border-stone-900/10 bg-white p-4">
                <div className="truncate text-base font-semibold text-stone-950">{row.option.name}</div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <LedgerPill label="计划参考" value={formatCurrency(row.option.plannedAmount)} />
                  <LedgerPill label="本期已记" value={formatCurrency(row.postedAmount)} />
                  <LedgerPill label="本次支出" value={formatCurrency(row.draftAmount)} tone="accent" />
                </div>
                <label className="mt-3 grid gap-1">
                  <span className="text-xs font-semibold tracking-[0.16em] text-stone-500">本次支出</span>
                  <CompactNumberInput
                    value={row.draftAmount}
                    onChange={(value) => props.onAmountChange(props.subjectKey, row.option.id, value)}
                    min={0}
                    step={0.01}
                    className="h-11 rounded-2xl bg-stone-50"
                    align="right"
                    inputClassName="font-semibold"
                  />
                </label>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={props.isLocked}
                    onClick={() => props.onFillPlanned(props.subjectKey, row.option.id, row.option.plannedAmount)}
                    className="flex-1 rounded-2xl border border-stone-900/10 bg-stone-50 px-3 py-2.5 text-sm font-semibold text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    计划
                  </button>
                  <button
                    type="button"
                    disabled={props.isLocked || row.draftAmount <= 0 || props.loading}
                    onClick={() => props.onSubmitRow(row.option.id)}
                    className="flex-1 rounded-2xl border border-stone-900/10 bg-amber-400 px-3 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
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
          当前期间没有可按成员记录的支出计划。
        </div>
      )}

      {props.showDetails ? (
        <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)] md:items-end">
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">对方单位</span>
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                disabled={props.isLocked}
                value={props.counterparty}
                onChange={(event) => props.onCounterpartyChange(event.target.value)}
                className="h-11 w-full rounded-2xl border border-stone-900/10 bg-white px-11 pr-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">备注</span>
            <input
              type="text"
              disabled={props.isLocked}
              value={props.description}
              onChange={(event) => props.onDescriptionChange(event.target.value)}
              className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        </div>
      ) : null}
    </section>
  )
}

function OtherIncomeComposer(props: {
  subjects: SubjectResponse[]
  selectedSubjectKey: string
  selectedSubject: SubjectResponse | null
  postedAmount: number
  occurredOn: string
  occurredOnInputRef: RefObject<HTMLInputElement | null>
  onOccurredOnChange: (value: string) => void
  amount: number
  onAmountChange: (value: number) => void
  counterparty: string
  onCounterpartyChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  showDetails: boolean
  onToggleDetails: () => void
  isLocked: boolean
  loading: boolean
  canSubmit: boolean
  onSelectSubject: (subjectKey: string) => void
  onSubmit: () => void
}) {
  return (
    <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-stone-950">其他收入</h3>
        </div>
        <button
          type="button"
          disabled={props.isLocked}
          onClick={props.onToggleDetails}
          className="rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {props.showDetails ? '收起对方与备注' : '补充对方与备注'}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <LedgerPill label="本期已记" value={props.selectedSubject ? formatCurrency(props.postedAmount) : '无'} />
        <LedgerPill
          label="口径说明"
          value="商业演出 / 一次性收入 / 赞助回款；不挂团员，不自动计提提成"
          tone="accent"
        />
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[200px_170px_170px_minmax(0,1fr)_144px] xl:items-end">
        <label className="grid gap-2">
          <span className="text-sm font-semibold text-stone-700">挂账科目</span>
          <select
            value={props.selectedSubjectKey}
            disabled={props.isLocked}
            onChange={(event) => props.onSelectSubject(event.target.value)}
            className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-semibold text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {props.subjects.map((subject) => (
              <option key={subject.subjectKey} value={subject.subjectKey}>
                {subject.subjectName}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-semibold text-stone-700">业务发生日</span>
          <input
            ref={props.occurredOnInputRef}
            type="date"
            value={props.occurredOn}
            disabled={props.isLocked}
            onInput={(event) => props.onOccurredOnChange((event.target as HTMLInputElement).value)}
            onChange={(event) => props.onOccurredOnChange(event.target.value)}
            className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-semibold text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-semibold text-stone-700">金额</span>
          <CompactNumberInput
            value={props.amount}
            onChange={props.onAmountChange}
            min={0}
            step={0.01}
            className="h-11 rounded-2xl bg-white"
            inputClassName="text-lg font-semibold"
            align="right"
          />
        </label>

        <div className="flex min-h-11 items-center text-sm font-medium text-stone-500">
          {props.selectedSubject ? '这笔收入会直接挂到所选营收科目，适合录商业演出或一次性回款。' : '先选择一个营收科目，再录入金额。'}
        </div>

        <button
          type="button"
          onClick={props.onSubmit}
          disabled={!props.canSubmit}
          className="inline-flex h-11 items-center justify-center rounded-2xl bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
        >
          {props.loading ? '保存中...' : '确认入账'}
        </button>
      </div>

      {props.showDetails ? (
        <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)] md:items-end">
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">对方单位</span>
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                disabled={props.isLocked}
                value={props.counterparty}
                onChange={(event) => props.onCounterpartyChange(event.target.value)}
                className="h-11 w-full rounded-2xl border border-stone-900/10 bg-white px-11 pr-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-stone-700">备注</span>
            <input
              type="text"
              disabled={props.isLocked}
              value={props.description}
              onChange={(event) => props.onDescriptionChange(event.target.value)}
              className="h-11 rounded-2xl border border-stone-900/10 bg-white px-4 text-sm font-medium text-stone-900 outline-none transition focus:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        </div>
      ) : null}
    </section>
  )
}

function HistorySection(props: {
  historyGroups: HistoryGroup[]
  isLocked: boolean
  onVoid: (entryId: string) => void
}) {
  const [directionFilter, setDirectionFilter] = useState<HistoryDirectionFilter>('all')
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>('all')
  const [keyword, setKeyword] = useState('')

  const filteredHistoryGroups = useMemo(
    () =>
      props.historyGroups.filter(({ entry, derivedEntries }) => {
        if (directionFilter !== 'all' && entry.direction !== directionFilter) return false
        if (statusFilter !== 'all' && entry.status !== statusFilter) return false

        const normalizedKeyword = keyword.trim().toLowerCase()
        if (!normalizedKeyword) return true

        return matchesHistoryKeyword(entry, derivedEntries, normalizedKeyword)
      }),
    [directionFilter, keyword, props.historyGroups, statusFilter],
  )

  const hasHistory = props.historyGroups.length > 0
  const hasFilteredHistory = filteredHistoryGroups.length > 0

  return (
    <Panel>
      <SectionTitle icon={ReceiptText} eyebrow="历史" title="账本记录" />

      {hasHistory ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <SegmentTabs compact value={directionFilter} items={historyDirectionTabs} onChange={setDirectionFilter} />
            <SegmentTabs compact value={statusFilter} items={historyStatusTabs} onChange={setStatusFilter} />

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
                    <col className="w-[16%]" />
                    <col className="w-[8%]" />
                    <col className="w-[34%]" />
                    <col className="w-[14%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead className="bg-stone-100/90 text-stone-600">
                    <tr className="border-b border-stone-900/10">
                      <HistoryHeader>时间</HistoryHeader>
                      <HistoryHeader align="center">方向</HistoryHeader>
                      <HistoryHeader>摘要</HistoryHeader>
                      <HistoryHeader>关联对象</HistoryHeader>
                      <HistoryHeader align="right">金额</HistoryHeader>
                      <HistoryHeader align="center">状态</HistoryHeader>
                      <HistoryHeader align="center">操作</HistoryHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistoryGroups.map(({ entry, derivedEntries }) => (
                      <tr key={entry.id} className="border-b border-stone-900/10 last:border-none">
                        <HistoryCell className="whitespace-nowrap tabular-nums text-stone-500">
                          {formatEntryDate(entry.occurredAt)} · 记账 {formatPostedAt(entry.postedAt)}
                        </HistoryCell>
                        <HistoryCell align="center">
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
                        <HistoryCell align="right" className="whitespace-nowrap font-semibold tabular-nums text-stone-950">
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
                {filteredHistoryGroups.map(({ entry, derivedEntries }, index) => (
                  <article
                    key={entry.id}
                    className={cx('px-4 py-3', index !== filteredHistoryGroups.length - 1 && 'border-b border-stone-900/10')}
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
        'whitespace-nowrap px-2.5 py-2 text-[11px] font-semibold tracking-[0.12em]',
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
        'px-2.5 py-2 align-middle',
        props.align === 'right' ? 'text-right' : props.align === 'center' ? 'text-center' : 'text-left',
        props.className,
      )}
    >
      {props.children}
    </td>
  )
}

function buildMemberPlanCaption(row: MemberRevenueRow) {
  return `${row.member.employmentType === 'salary' ? '底薪' : '兼职'} · 线${formatUnits(row.plannedOfflineUnits)} / 上${formatUnits(row.plannedOnlineUnits)} 张`
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

function getEntityAllocationKey(subjectKey: string, entityId: string) {
  return `${subjectKey}:${entityId}`
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
