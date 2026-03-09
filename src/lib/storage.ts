import {
  createEmployee,
  createMember,
  createShareholder,
  createTimelineTemplate,
  syncMonthsToPlanning,
  toTimelineTemplate,
} from './defaults'
import type {
  Employee,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  PlanningConfig,
  Shareholder,
  TeamMember,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types'

export const STORAGE_KEY = 'xox-model-workspace-v1'
export const SCHEMA_VERSION = 3

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function cloneConfig(config: ModelConfig): ModelConfig {
  return JSON.parse(JSON.stringify(config)) as ModelConfig
}

export function createSnapshot(
  config: ModelConfig,
  name: string,
  kind: WorkspaceSnapshotKind,
): WorkspaceSnapshot {
  return {
    id: createId(kind),
    name,
    createdAt: new Date().toISOString(),
    kind,
    config: cloneConfig(config),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizePercent(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }

  if (value > 1) {
    return value / 100
  }

  return value
}

function guessStartMonth(months: MonthlyPlan[]) {
  const firstLabel = months[0]?.label ?? ''
  const matched = firstLabel.match(/^(\d{1,2})月/)

  if (!matched) {
    return 1
  }

  const value = Number(matched[1])

  if (!Number.isFinite(value)) {
    return 1
  }

  return Math.min(12, Math.max(1, Math.round(value)))
}

function normalizePlanning(rawPlanning: unknown, months: MonthlyPlan[]): PlanningConfig {
  if (isObject(rawPlanning)) {
    const startMonth =
      typeof rawPlanning.startMonth === 'number'
        ? Math.min(12, Math.max(1, Math.round(rawPlanning.startMonth)))
        : guessStartMonth(months)
    const horizonMonths =
      typeof rawPlanning.horizonMonths === 'number'
        ? Math.min(24, Math.max(1, Math.round(rawPlanning.horizonMonths)))
        : Math.max(1, months.length)

    return {
      startMonth,
      horizonMonths,
    }
  }

  return {
    startMonth: guessStartMonth(months),
    horizonMonths: Math.max(1, months.length),
  }
}

function normalizeShareholders(rawShareholders: unknown, rawOperating: unknown) {
  if (Array.isArray(rawShareholders)) {
    return rawShareholders.map((shareholder, index) => {
      if (!isObject(shareholder)) {
        return createShareholder(`import-${index}`)
      }

      return createShareholder(`import-${index}`, {
        id: typeof shareholder.id === 'string' ? shareholder.id : `shareholder-import-${index}`,
        name: typeof shareholder.name === 'string' ? shareholder.name : `股东 ${index + 1}`,
        investmentAmount:
          typeof shareholder.investmentAmount === 'number' ? shareholder.investmentAmount : 0,
        dividendRate: normalizePercent(shareholder.dividendRate),
      })
    })
  }

  const legacyInvestment =
    isObject(rawOperating) && typeof rawOperating.initialInvestment === 'number'
      ? rawOperating.initialInvestment
      : 0

  return [
    createShareholder('legacy-a', {
      name: '股东 A',
      investmentAmount: legacyInvestment,
      dividendRate: 1,
    }),
  ] satisfies Shareholder[]
}

function normalizeTeamMembers(rawMembers: unknown) {
  if (!Array.isArray(rawMembers)) {
    return [] as TeamMember[]
  }

  return rawMembers.map((member, index) => {
    if (!isObject(member)) {
      return createMember(`import-${index}`)
    }

    const normalizedUnits = isObject(member.unitsPerEvent)
      ? {
          pessimistic:
            typeof member.unitsPerEvent.pessimistic === 'number' ? member.unitsPerEvent.pessimistic : 0,
          base: typeof member.unitsPerEvent.base === 'number' ? member.unitsPerEvent.base : 0,
          optimistic:
            typeof member.unitsPerEvent.optimistic === 'number' ? member.unitsPerEvent.optimistic : 0,
        }
      : null

    return createMember(`import-${index}`, {
      id: typeof member.id === 'string' ? member.id : `member-import-${index}`,
      name: typeof member.name === 'string' ? member.name : `成员 ${index + 1}`,
      employmentType: member.employmentType === 'salary' ? 'salary' : 'partTime',
      monthlyBasePay: typeof member.monthlyBasePay === 'number' ? member.monthlyBasePay : 0,
      perEventTravelCost:
        typeof member.perEventTravelCost === 'number'
          ? member.perEventTravelCost
          : typeof member.monthlyTravelCost === 'number'
            ? member.monthlyTravelCost
            : 0,
      commissionRate: normalizePercent(member.commissionRate),
      ...(normalizedUnits ? { unitsPerEvent: normalizedUnits } : {}),
    })
  })
}

function normalizeEmployees(rawEmployees: unknown, rawMembers: unknown) {
  if (Array.isArray(rawEmployees)) {
    return rawEmployees.map((employee, index) => {
      if (!isObject(employee)) {
        return createEmployee(`import-${index}`)
      }

      return createEmployee(`import-${index}`, {
        id: typeof employee.id === 'string' ? employee.id : `employee-import-${index}`,
        name: typeof employee.name === 'string' ? employee.name : `员工 ${index + 1}`,
        role: typeof employee.role === 'string' ? employee.role : '现场执行',
        monthlyBasePay: typeof employee.monthlyBasePay === 'number' ? employee.monthlyBasePay : 0,
        perEventCost: typeof employee.perEventCost === 'number' ? employee.perEventCost : 0,
      })
    })
  }

  if (!Array.isArray(rawMembers)) {
    return [] as Employee[]
  }

  const migratedAllowances = rawMembers.filter(
    (member): member is Record<string, unknown> =>
      isObject(member) && typeof member.eventAllowance === 'number' && member.eventAllowance > 0,
  )

  return migratedAllowances.map((member, index) =>
    createEmployee(`legacy-${index}`, {
      name: `员工 ${index + 1}`,
      role: '历史场务',
      monthlyBasePay: 0,
      perEventCost: member.eventAllowance as number,
    }),
  )
}

function normalizeOperating(rawOperating: unknown): ModelConfig['operating'] {
  if (!isObject(rawOperating)) {
    return {
      unitPrice: 88,
      monthlyFixedCost: 0,
      perEventOperatingCost: 0,
      materialCostPerUnit: 0,
    }
  }

  return {
    unitPrice: typeof rawOperating.unitPrice === 'number' ? rawOperating.unitPrice : 88,
    monthlyFixedCost:
      typeof rawOperating.monthlyFixedCost === 'number' ? rawOperating.monthlyFixedCost : 0,
    perEventOperatingCost:
      typeof rawOperating.perEventOperatingCost === 'number' ? rawOperating.perEventOperatingCost : 0,
    materialCostPerUnit:
      typeof rawOperating.materialCostPerUnit === 'number' ? rawOperating.materialCostPerUnit : 0,
  }
}

function normalizeMonth(month: unknown, index: number): MonthlyPlan {
  if (!isObject(month)) {
    return {
      id: `month-import-${index}`,
      label: `${index + 1}月`,
      ...createTimelineTemplate(),
    }
  }

  const legacyTravelCost = typeof month.travelCost === 'number' ? month.travelCost : 0

  return {
    id: typeof month.id === 'string' ? month.id : `month-import-${index}`,
    label: typeof month.label === 'string' ? month.label : `${index + 1}月`,
    events: typeof month.events === 'number' ? month.events : 0,
    salesMultiplier: typeof month.salesMultiplier === 'number' ? month.salesMultiplier : 0,
    extraChannelRevenue: typeof month.extraChannelRevenue === 'number' ? month.extraChannelRevenue : 0,
    rehearsalCount: typeof month.rehearsalCount === 'number' ? month.rehearsalCount : 0,
    rehearsalCost: typeof month.rehearsalCost === 'number' ? month.rehearsalCost : 0,
    teacherCount: typeof month.teacherCount === 'number' ? month.teacherCount : 0,
    teacherCost: typeof month.teacherCost === 'number' ? month.teacherCost : 0,
    extraPerEventCost: typeof month.extraPerEventCost === 'number' ? month.extraPerEventCost : 0,
    extraFixedCost:
      (typeof month.extraFixedCost === 'number' ? month.extraFixedCost : 0) + legacyTravelCost,
    vjCost: typeof month.vjCost === 'number' ? month.vjCost : 0,
    originalSongCost: typeof month.originalSongCost === 'number' ? month.originalSongCost : 0,
    makeupPerEventCost:
      typeof month.makeupPerEventCost === 'number'
        ? month.makeupPerEventCost
        : typeof month.makeupCost === 'number'
          ? month.makeupCost
          : 0,
    streamingPerEventCost:
      typeof month.streamingPerEventCost === 'number'
        ? month.streamingPerEventCost
        : typeof month.streamingCost === 'number'
          ? month.streamingCost
          : 0,
    mealPerEventCost:
      typeof month.mealPerEventCost === 'number'
        ? month.mealPerEventCost
        : typeof month.mealCost === 'number'
          ? month.mealCost
          : 0,
    includeMaterialCost:
      typeof month.includeMaterialCost === 'boolean' ? month.includeMaterialCost : true,
  }
}

function normalizeMonths(rawMonths: unknown) {
  if (!Array.isArray(rawMonths)) {
    return [] as MonthlyPlan[]
  }

  return rawMonths.map(normalizeMonth)
}

function normalizeTimelineTemplate(rawTemplate: unknown, months: MonthlyPlan[]) {
  if (isObject(rawTemplate)) {
    const legacyTravelCost = typeof rawTemplate.travelCost === 'number' ? rawTemplate.travelCost : 0
    const normalized: Partial<MonthlyPlanTemplate> = {}

    if (typeof rawTemplate.events === 'number') normalized.events = rawTemplate.events
    if (typeof rawTemplate.salesMultiplier === 'number') normalized.salesMultiplier = rawTemplate.salesMultiplier
    if (typeof rawTemplate.extraChannelRevenue === 'number') normalized.extraChannelRevenue = rawTemplate.extraChannelRevenue
    if (typeof rawTemplate.rehearsalCount === 'number') normalized.rehearsalCount = rawTemplate.rehearsalCount
    if (typeof rawTemplate.rehearsalCost === 'number') normalized.rehearsalCost = rawTemplate.rehearsalCost
    if (typeof rawTemplate.teacherCount === 'number') normalized.teacherCount = rawTemplate.teacherCount
    if (typeof rawTemplate.teacherCost === 'number') normalized.teacherCost = rawTemplate.teacherCost
    if (typeof rawTemplate.extraPerEventCost === 'number') normalized.extraPerEventCost = rawTemplate.extraPerEventCost
    if (typeof rawTemplate.extraFixedCost === 'number' || legacyTravelCost > 0) {
      normalized.extraFixedCost = (typeof rawTemplate.extraFixedCost === 'number' ? rawTemplate.extraFixedCost : 0) + legacyTravelCost
    }
    if (typeof rawTemplate.vjCost === 'number') normalized.vjCost = rawTemplate.vjCost
    if (typeof rawTemplate.originalSongCost === 'number') normalized.originalSongCost = rawTemplate.originalSongCost
    if (typeof rawTemplate.makeupPerEventCost === 'number') normalized.makeupPerEventCost = rawTemplate.makeupPerEventCost
    else if (typeof rawTemplate.makeupCost === 'number') normalized.makeupPerEventCost = rawTemplate.makeupCost
    if (typeof rawTemplate.streamingPerEventCost === 'number') normalized.streamingPerEventCost = rawTemplate.streamingPerEventCost
    else if (typeof rawTemplate.streamingCost === 'number') normalized.streamingPerEventCost = rawTemplate.streamingCost
    if (typeof rawTemplate.mealPerEventCost === 'number') normalized.mealPerEventCost = rawTemplate.mealPerEventCost
    else if (typeof rawTemplate.mealCost === 'number') normalized.mealPerEventCost = rawTemplate.mealCost
    if (typeof rawTemplate.includeMaterialCost === 'boolean') normalized.includeMaterialCost = rawTemplate.includeMaterialCost

    return createTimelineTemplate(normalized)
  }

  return toTimelineTemplate(months.at(-1))
}

function normalizeModelConfig(value: unknown): ModelConfig | null {
  if (!isObject(value) || !Array.isArray(value.teamMembers) || !Array.isArray(value.months)) {
    return null
  }

  const months = normalizeMonths(value.months)
  const planning = normalizePlanning(value.planning, months)
  const operating = normalizeOperating(value.operating)
  const shareholders = normalizeShareholders(value.shareholders, value.operating)
  const teamMembers = normalizeTeamMembers(value.teamMembers)
  const employees = normalizeEmployees(value.employees, value.teamMembers)
  const timelineTemplate = normalizeTimelineTemplate(value.timelineTemplate, months)

  return {
    shareholders,
    operating,
    planning,
    timelineTemplate,
    teamMembers,
    employees,
    months: syncMonthsToPlanning(months, planning, 'import', timelineTemplate),
  }
}

function isValidModelConfig(value: unknown): value is ModelConfig {
  return normalizeModelConfig(value) !== null
}

function isValidSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.kind === 'snapshot' || value.kind === 'release') &&
    isValidModelConfig(value.config)
  )
}

export function parseWorkspaceBundle(raw: string): WorkspaceBundle | null {
  try {
    const data: unknown = JSON.parse(raw)

    if (!isObject(data)) {
      return null
    }

    const currentConfig = normalizeModelConfig(data.currentConfig)

    if (
      typeof data.schemaVersion !== 'number' ||
      typeof data.workspaceName !== 'string' ||
      !currentConfig ||
      !Array.isArray(data.snapshots) ||
      !data.snapshots.every(isValidSnapshot)
    ) {
      return null
    }

    return {
      schemaVersion: data.schemaVersion,
      workspaceName: data.workspaceName,
      currentConfig,
      snapshots: data.snapshots.map((snapshot) => ({
        ...snapshot,
        config: normalizeModelConfig(snapshot.config) ?? cloneConfig(snapshot.config),
      })),
      lastSavedAt: typeof data.lastSavedAt === 'string' ? data.lastSavedAt : null,
    }
  } catch {
    return null
  }
}

export function loadWorkspaceBundle(): WorkspaceBundle | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)

  if (!raw) {
    return null
  }

  return parseWorkspaceBundle(raw)
}

export function saveWorkspaceBundle(bundle: WorkspaceBundle) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle))
}

export function serializeWorkspaceBundle(bundle: WorkspaceBundle) {
  return JSON.stringify(bundle, null, 2)
}
