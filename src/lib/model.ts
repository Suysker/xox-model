import type {
  EmployeeMonthResult,
  MemberMonthResult,
  ModelConfig,
  ModelResult,
  MonthlyPlan,
  MonthlyScenarioResult,
  ScenarioKey,
  ScenarioResult,
  TeamMember,
} from '../types'
import { getStageCostTotals, sumCostItems } from './costs'

const scenarioLabels: Record<ScenarioKey, { label: string; description: string }> = {
  pessimistic: {
    label: '悲观',
    description: '按成员较保守的单场张数，查看现金流下界。',
  },
  base: {
    label: '基准',
    description: '按当前最可能发生的排期和销售表现，作为主要判断口径。',
  },
  optimistic: {
    label: '乐观',
    description: '按状态更好的销量表现，查看经营上界。',
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

function isMemberActiveInMonth(member: TeamMember, monthIndex: number) {
  if (member.departureMonthIndex === null) {
    return true
  }

  return monthIndex + 1 <= member.departureMonthIndex
}

function getUnitsForScenario(member: TeamMember, key: ScenarioKey, multiplier: number) {
  return clampToNonNegative(member.unitsPerEvent[key]) * clampToNonNegative(multiplier)
}

function getMemberMonthResults(config: ModelConfig, month: MonthlyPlan, key: ScenarioKey, monthIndex: number) {
  const events = clampToNonNegative(month.events)

  return config.teamMembers.map<MemberMonthResult>((member) => {
    if (!isMemberActiveInMonth(member, monthIndex)) {
      return {
        memberId: member.id,
        name: member.name,
        employmentType: member.employmentType,
        unitsPerEvent: 0,
        monthlyUnits: 0,
        grossSales: 0,
        commissionCost: 0,
        basePayCost: 0,
        travelCost: 0,
        companyNetContribution: 0,
      }
    }

    const unitsPerEvent = getUnitsForScenario(member, key, month.salesMultiplier)
    const monthlyUnits = unitsPerEvent * events
    const grossSales = monthlyUnits * clampToNonNegative(config.operating.offlineUnitPrice)
    const commissionCost = grossSales * clampToNonNegative(member.commissionRate)
    const basePayCost = clampToNonNegative(member.monthlyBasePay)
    const travelCost = events * clampToNonNegative(member.perEventTravelCost)

    return {
      memberId: member.id,
      name: member.name,
      employmentType: member.employmentType,
      unitsPerEvent,
      monthlyUnits,
      grossSales,
      commissionCost,
      basePayCost,
      travelCost,
      companyNetContribution: grossSales - commissionCost - basePayCost - travelCost,
    }
  })
}

function getEmployeeMonthResults(config: ModelConfig, month: MonthlyPlan) {
  const events = clampToNonNegative(month.events)

  return config.employees.map<EmployeeMonthResult>((employee) => {
    const basePayCost = clampToNonNegative(employee.monthlyBasePay)
    const perEventCost = events * clampToNonNegative(employee.perEventCost)

    return {
      employeeId: employee.id,
      name: employee.name,
      role: employee.role,
      basePayCost,
      perEventCost,
      totalCost: basePayCost + perEventCost,
    }
  })
}

function getTotalInvestment(config: ModelConfig) {
  return config.shareholders.reduce((sum, shareholder) => sum + clampToNonNegative(shareholder.investmentAmount), 0)
}

export function getScenarioResult(config: ModelConfig, key: ScenarioKey): ScenarioResult {
  const totalInvestment = getTotalInvestment(config)
  const months: MonthlyScenarioResult[] = []
  let cumulativeProfit = 0
  let paybackMonthIndex: number | null = null
  let paybackMonthLabel: string | null = null

  config.months.forEach((month, monthIndex) => {
    const members = getMemberMonthResults(config, month, key, monthIndex)
    const employees = getEmployeeMonthResults(config, month)
    const events = clampToNonNegative(month.events)
    const onlineSalesFactor = clampToNonNegative(month.onlineSalesFactor)
    const totalUnitsPerEvent = members.reduce((sum, member) => sum + member.unitsPerEvent, 0)
    const totalUnitsPerMonth = members.reduce((sum, member) => sum + member.monthlyUnits, 0)
    const memberGrossSales = members.reduce((sum, member) => sum + member.grossSales, 0)
    const onlineRevenue =
      totalUnitsPerMonth * onlineSalesFactor * clampToNonNegative(config.operating.onlineUnitPrice)
    const grossSales = memberGrossSales + onlineRevenue
    const commissionCost = members.reduce((sum, member) => sum + member.commissionCost, 0)
    const basePayCost = members.reduce((sum, member) => sum + member.basePayCost, 0)
    const memberTravelCost = members.reduce((sum, member) => sum + member.travelCost, 0)
    const employeeBasePayCost = employees.reduce((sum, employee) => sum + employee.basePayCost, 0)
    const employeeEventCost = employees.reduce((sum, employee) => sum + employee.perEventCost, 0)
    const monthlyOperatingCost = sumCostItems(config.operating.monthlyFixedCosts)
    const perEventOperatingCost = events * sumCostItems(config.operating.perEventCosts)
    const perUnitOperatingCost = sumCostItems(config.operating.perUnitCosts)
    const stageCostTotals = getStageCostTotals(config.stageCostItems, month.specialCosts)
    const rehearsalCost =
      clampToNonNegative(month.rehearsalCount) * clampToNonNegative(month.rehearsalCost)
    const teacherCost =
      clampToNonNegative(month.teacherCount) * clampToNonNegative(month.teacherCost)
    const specialProjectCost = stageCostTotals.monthly
    const unitLinkedCostTotal = totalUnitsPerMonth * (perUnitOperatingCost + stageCostTotals.perUnitLike)
    const monthlyFixedCostTotal =
      basePayCost +
      employeeBasePayCost +
      monthlyOperatingCost +
      rehearsalCost +
      teacherCost +
      specialProjectCost
    const perEventCostTotal =
      memberTravelCost + employeeEventCost + perEventOperatingCost + stageCostTotals.perEventLike
    const operatingCostTotal = monthlyFixedCostTotal + perEventCostTotal + unitLinkedCostTotal
    const totalCost = commissionCost + operatingCostTotal
    const monthlyProfit = grossSales - totalCost

    cumulativeProfit += monthlyProfit
    const cumulativeCash = cumulativeProfit - totalInvestment
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
      onlineSalesFactor,
      onlineRevenue,
      memberGrossSales,
      totalUnitsPerEvent,
      totalUnitsPerMonth,
      grossSales,
      commissionCost,
      basePayCost,
      memberTravelCost,
      employeeBasePayCost,
      employeeEventCost,
      monthlyOperatingCost,
      perEventOperatingCost,
      rehearsalCost,
      teacherCost,
      specialProjectCost,
      monthlyFixedCostTotal,
      perEventCostTotal,
      operatingCostTotal,
      unitLinkedCostTotal,
      totalCost,
      monthlyProfit,
      cumulativeProfit,
      cumulativeCash,
      hasPaidBack,
      members,
      employees,
    })
  })

  const totalEvents = months.reduce((sum, month) => sum + month.events, 0)
  const totalUnitsPerMonth = months.reduce((sum, month) => sum + month.totalUnitsPerMonth, 0)
  const grossSales = months.reduce((sum, month) => sum + month.grossSales, 0)
  const operatingCostTotal = months.reduce((sum, month) => sum + month.operatingCostTotal, 0)
  const totalCost = months.reduce((sum, month) => sum + month.totalCost, 0)
  const totalProfit = months.reduce((sum, month) => sum + month.monthlyProfit, 0)
  const totalCommissionCost = months.reduce((sum, month) => sum + month.commissionCost, 0)
  const netCashAfterInvestment = totalProfit - totalInvestment
  const takeRate = grossSales > 0 ? (grossSales - totalCommissionCost) / grossSales : 0
  const averageUnitsPerEvent = totalEvents > 0 ? totalUnitsPerMonth / totalEvents : 0
  const roi = totalInvestment > 0 ? netCashAfterInvestment / totalInvestment : 0

  return {
    key,
    label: scenarioLabels[key].label,
    description: scenarioLabels[key].description,
    totalInvestment,
    totalEvents,
    averageUnitsPerEvent,
    totalUnitsPerMonth,
    grossSales,
    operatingCostTotal,
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
