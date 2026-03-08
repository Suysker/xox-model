export const scenarioOrder = ['pessimistic', 'base', 'optimistic'] as const

export type ScenarioKey = (typeof scenarioOrder)[number]

export type EmploymentType = 'salary' | 'partTime'

export type ScenarioBand = Record<ScenarioKey, number>

export type TeamMember = {
  id: string
  name: string
  employmentType: EmploymentType
  monthlyBasePay: number
  commissionRate: number
  eventAllowance: number
  unitsPerEvent: ScenarioBand
}

export type OperatingConfig = {
  initialInvestment: number
  unitPrice: number
  monthlyFixedCost: number
  perEventOperatingCost: number
  materialCostPerUnit: number
}

export type MonthlyPlan = {
  id: string
  label: string
  events: number
  salesMultiplier: number
  rehearsalCount: number
  rehearsalCost: number
  teacherCount: number
  teacherCost: number
  extraPerEventCost: number
  extraFixedCost: number
  vjCost: number
  originalSongCost: number
  makeupCost: number
  travelCost: number
  streamingCost: number
  mealCost: number
  includeMaterialCost: boolean
  notes: string
}

export type ModelConfig = {
  operating: OperatingConfig
  teamMembers: TeamMember[]
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
  allowanceCost: number
  companyRevenueAfterCommission: number
}

export type MonthlyScenarioResult = {
  monthId: string
  label: string
  monthIndex: number
  events: number
  salesMultiplier: number
  totalUnitsPerEvent: number
  totalUnitsPerMonth: number
  grossSales: number
  commissionCost: number
  basePayCost: number
  allowanceCost: number
  fixedOperatingCost: number
  eventOperatingCost: number
  extraPerEventCost: number
  rehearsalCost: number
  teacherCost: number
  specialProjectCost: number
  fixedCostTotal: number
  showLinkedCostTotal: number
  unitLinkedCostTotal: number
  totalCost: number
  monthlyProfit: number
  cumulativeProfit: number
  cumulativeCash: number
  hasPaidBack: boolean
  members: MemberMonthResult[]
}

export type ScenarioResult = {
  key: ScenarioKey
  label: string
  description: string
  totalEvents: number
  averageUnitsPerEvent: number
  totalUnitsPerMonth: number
  grossSales: number
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
