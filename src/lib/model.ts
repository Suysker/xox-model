import type {
  MemberMonthResult,
  ModelConfig,
  ModelResult,
  MonthlyPlan,
  MonthlyScenarioResult,
  ScenarioKey,
  ScenarioResult,
  TeamMember,
} from '../types'

const scenarioLabels: Record<ScenarioKey, { label: string; description: string }> = {
  pessimistic: {
    label: '悲观',
    description: '按每位成员的悲观单场张数，查看保守现金流下界。',
  },
  base: {
    label: '基准',
    description: '按当前最可能发生的张数与排期，作为主判断口径。',
  },
  optimistic: {
    label: '乐观',
    description: '按成员状态更好时的单场张数，查看经营上界。',
  },
}

function safeNumber(value: number) {
  if (Number.isFinite(value)) {
    return value
  }

  return 0
}

function clampToNonNegative(value: number) {
  return Math.max(0, safeNumber(value))
}

function getUnitsForScenario(member: TeamMember, key: ScenarioKey, multiplier: number) {
  return clampToNonNegative(member.unitsPerEvent[key]) * clampToNonNegative(multiplier)
}

function getSpecialProjectCost(month: MonthlyPlan) {
  return (
    clampToNonNegative(month.extraFixedCost) +
    clampToNonNegative(month.vjCost) +
    clampToNonNegative(month.originalSongCost) +
    clampToNonNegative(month.makeupCost) +
    clampToNonNegative(month.travelCost) +
    clampToNonNegative(month.streamingCost) +
    clampToNonNegative(month.mealCost)
  )
}

function getMemberMonthResults(config: ModelConfig, month: MonthlyPlan, key: ScenarioKey) {
  const events = clampToNonNegative(month.events)

  return config.teamMembers.map<MemberMonthResult>((member) => {
    const unitsPerEvent = getUnitsForScenario(member, key, month.salesMultiplier)
    const monthlyUnits = unitsPerEvent * events
    const grossSales = monthlyUnits * clampToNonNegative(config.operating.unitPrice)
    const commissionCost = grossSales * clampToNonNegative(member.commissionRate)
    const basePayCost = clampToNonNegative(member.monthlyBasePay)
    const allowanceCost = events * clampToNonNegative(member.eventAllowance)

    return {
      memberId: member.id,
      name: member.name,
      employmentType: member.employmentType,
      unitsPerEvent,
      monthlyUnits,
      grossSales,
      commissionCost,
      basePayCost,
      allowanceCost,
      companyRevenueAfterCommission: grossSales - commissionCost,
    }
  })
}

export function getScenarioResult(config: ModelConfig, key: ScenarioKey): ScenarioResult {
  const months: MonthlyScenarioResult[] = []
  let cumulativeProfit = 0
  let paybackMonthIndex: number | null = null
  let paybackMonthLabel: string | null = null

  config.months.forEach((month, monthIndex) => {
    const members = getMemberMonthResults(config, month, key)
    const events = clampToNonNegative(month.events)
    const totalUnitsPerEvent = members.reduce((sum, member) => sum + member.unitsPerEvent, 0)
    const totalUnitsPerMonth = members.reduce((sum, member) => sum + member.monthlyUnits, 0)
    const grossSales = members.reduce((sum, member) => sum + member.grossSales, 0)
    const commissionCost = members.reduce((sum, member) => sum + member.commissionCost, 0)
    const basePayCost = members.reduce((sum, member) => sum + member.basePayCost, 0)
    const allowanceCost = members.reduce((sum, member) => sum + member.allowanceCost, 0)
    const fixedOperatingCost = clampToNonNegative(config.operating.monthlyFixedCost)
    const eventOperatingCost = events * clampToNonNegative(config.operating.perEventOperatingCost)
    const extraPerEventCost = events * clampToNonNegative(month.extraPerEventCost)
    const rehearsalCost =
      clampToNonNegative(month.rehearsalCount) * clampToNonNegative(month.rehearsalCost)
    const teacherCost =
      clampToNonNegative(month.teacherCount) * clampToNonNegative(month.teacherCost)
    const specialProjectCost = getSpecialProjectCost(month)
    const materialCost = month.includeMaterialCost
      ? totalUnitsPerMonth * clampToNonNegative(config.operating.materialCostPerUnit)
      : 0
    const fixedCostTotal =
      basePayCost + fixedOperatingCost + rehearsalCost + teacherCost + specialProjectCost
    const showLinkedCostTotal = allowanceCost + eventOperatingCost + extraPerEventCost
    const unitLinkedCostTotal = materialCost
    const totalCost = fixedCostTotal + showLinkedCostTotal + unitLinkedCostTotal
    const monthlyProfit = grossSales - commissionCost - totalCost

    cumulativeProfit += monthlyProfit
    const cumulativeCash = cumulativeProfit - clampToNonNegative(config.operating.initialInvestment)
    const hasPaidBack = cumulativeCash >= 0

    if (hasPaidBack && paybackMonthIndex === null) {
      paybackMonthIndex = monthIndex + 1
      paybackMonthLabel = month.label
    }

    months.push({
      monthId: month.id,
      label: month.label,
      monthIndex: monthIndex + 1,
      events,
      salesMultiplier: clampToNonNegative(month.salesMultiplier),
      totalUnitsPerEvent,
      totalUnitsPerMonth,
      grossSales,
      commissionCost,
      basePayCost,
      allowanceCost,
      fixedOperatingCost,
      eventOperatingCost,
      extraPerEventCost,
      rehearsalCost,
      teacherCost,
      specialProjectCost,
      fixedCostTotal,
      showLinkedCostTotal,
      unitLinkedCostTotal,
      totalCost,
      monthlyProfit,
      cumulativeProfit,
      cumulativeCash,
      hasPaidBack,
      members,
    })
  })

  const totalEvents = months.reduce((sum, month) => sum + month.events, 0)
  const totalUnitsPerMonth = months.reduce((sum, month) => sum + month.totalUnitsPerMonth, 0)
  const grossSales = months.reduce((sum, month) => sum + month.grossSales, 0)
  const totalCost = months.reduce((sum, month) => sum + month.totalCost, 0)
  const totalProfit = months.reduce((sum, month) => sum + month.monthlyProfit, 0)
  const netCashAfterInvestment = totalProfit - clampToNonNegative(config.operating.initialInvestment)
  const takeRate = grossSales > 0 ? (grossSales - months.reduce((sum, month) => sum + month.commissionCost, 0)) / grossSales : 0
  const averageUnitsPerEvent = totalEvents > 0 ? totalUnitsPerMonth / totalEvents : 0
  const roi =
    clampToNonNegative(config.operating.initialInvestment) > 0
      ? netCashAfterInvestment / clampToNonNegative(config.operating.initialInvestment)
      : 0

  return {
    key,
    label: scenarioLabels[key].label,
    description: scenarioLabels[key].description,
    totalEvents,
    averageUnitsPerEvent,
    totalUnitsPerMonth,
    grossSales,
    totalCost,
    totalProfit,
    netCashAfterInvestment,
    roi,
    takeRate,
    paybackMonthIndex,
    paybackMonthLabel,
    months,
  }
}

export function projectModel(config: ModelConfig): ModelResult {
  return {
    scenarios: [
      getScenarioResult(config, 'pessimistic'),
      getScenarioResult(config, 'base'),
      getScenarioResult(config, 'optimistic'),
    ],
  }
}
