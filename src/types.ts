export const scenarioOrder = ['pessimistic', 'base', 'optimistic'] as const

export type ScenarioKey = (typeof scenarioOrder)[number]

export type EmploymentType = 'salary' | 'partTime'

export type ScenarioBand = Record<ScenarioKey, number>

export type CostCategory = 'monthlyFixed' | 'perEvent' | 'perUnit'

export type CostItem = {
  id: string
  name: string
  amount: number
}

export type StageCostMode = 'monthly' | 'perEvent' | 'perUnit'

export type StageCostItem = {
  id: string
  name: string
  mode: StageCostMode
}

export type StageCostValue = {
  itemId: string
  amount: number
  count: number
}

export type Shareholder = {
  id: string
  name: string
  investmentAmount: number
  dividendRate: number
}

export type TeamMember = {
  id: string
  name: string
  employmentType: EmploymentType
  monthlyBasePay: number
  perEventTravelCost: number
  commissionRate: number
  unitsPerEvent: ScenarioBand
}

export type Employee = {
  id: string
  name: string
  role: string
  monthlyBasePay: number
  perEventCost: number
}

export type OperatingConfig = {
  unitPrice: number
  monthlyFixedCosts: CostItem[]
  perEventCosts: CostItem[]
  perUnitCosts: CostItem[]
}

export type PlanningConfig = {
  startMonth: number
  horizonMonths: number
}

export type MonthlyPlan = {
  id: string
  label: string
  events: number
  salesMultiplier: number
  extraChannelRevenue: number
  rehearsalCount: number
  rehearsalCost: number
  teacherCount: number
  teacherCost: number
  extraPerEventCost: number
  extraFixedCost: number
  specialCosts: StageCostValue[]
}

export type MonthlyPlanTemplate = Omit<MonthlyPlan, 'id' | 'label'>

export type ModelConfig = {
  shareholders: Shareholder[]
  operating: OperatingConfig
  planning: PlanningConfig
  stageCostItems: StageCostItem[]
  timelineTemplate: MonthlyPlanTemplate
  teamMembers: TeamMember[]
  employees: Employee[]
  months: MonthlyPlan[]
}

export type MemberMonthResult = {
  memberId: string
  name: string
  employmentType: EmploymentType
  unitsPerEvent: number
  monthlyUnits: number
  grossSales: number
  commissionCost: number
  basePayCost: number
  travelCost: number
  companyNetContribution: number
}

export type EmployeeMonthResult = {
  employeeId: string
  name: string
  role: string
  basePayCost: number
  perEventCost: number
  totalCost: number
}

export type MonthlyScenarioResult = {
  monthId: string
  label: string
  monthIndex: number
  events: number
  salesMultiplier: number
  extraChannelRevenue: number
  memberGrossSales: number
  totalUnitsPerEvent: number
  totalUnitsPerMonth: number
  grossSales: number
  commissionCost: number
  basePayCost: number
  memberTravelCost: number
  employeeBasePayCost: number
  employeeEventCost: number
  monthlyOperatingCost: number
  perEventOperatingCost: number
  extraPerEventCost: number
  extraFixedCost: number
  rehearsalCost: number
  teacherCost: number
  specialProjectCost: number
  monthlyFixedCostTotal: number
  perEventCostTotal: number
  operatingCostTotal: number
  unitLinkedCostTotal: number
  totalCost: number
  monthlyProfit: number
  cumulativeProfit: number
  cumulativeCash: number
  hasPaidBack: boolean
  members: MemberMonthResult[]
  employees: EmployeeMonthResult[]
}

export type ScenarioResult = {
  key: ScenarioKey
  label: string
  description: string
  totalInvestment: number
  totalEvents: number
  averageUnitsPerEvent: number
  totalUnitsPerMonth: number
  grossSales: number
  operatingCostTotal: number
  totalCost: number
  totalProfit: number
  netCashAfterInvestment: number
  roi: number
  takeRate: number
  paybackMonthIndex: number | null
  paybackMonthLabel: string | null
  months: MonthlyScenarioResult[]
}

export type ModelResult = {
  scenarios: ScenarioResult[]
}

export type WorkspaceSnapshotKind = 'snapshot' | 'release'

export type WorkspaceSnapshot = {
  id: string
  name: string
  createdAt: string
  kind: WorkspaceSnapshotKind
  config: ModelConfig
}

export type WorkspaceBundle = {
  schemaVersion: number
  workspaceName: string
  currentConfig: ModelConfig
  snapshots: WorkspaceSnapshot[]
  lastSavedAt: string | null
}
