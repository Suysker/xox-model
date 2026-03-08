import { createEmployee, createMember, createTimelineTemplate, syncMonthsToPlanning, toTimelineTemplate } from './defaults'
import type {
  Employee,
  ModelConfig,
  MonthlyPlan,
  PlanningConfig,
  TeamMember,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types'

export const STORAGE_KEY = 'xox-model-workspace-v1'
export const SCHEMA_VERSION = 1

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

function guessStartMonth(months: MonthlyPlan[]) {
  const firstLabel = months[0]?.label ?? ''
  const matched = firstLabel.match(/^(\d{1,2})月$/)

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
      typeof rawPlanning.startMonth === 'number' ? Math.min(12, Math.max(1, Math.round(rawPlanning.startMonth))) : guessStartMonth(months)
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
      commissionRate: typeof member.commissionRate === 'number' ? member.commissionRate : 0,
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

  const migratedEmployees = migratedAllowances.map((member, index) =>
    createEmployee(`legacy-${index}`, {
      name: `员工 ${index + 1}`,
      role: '历史场务',
      monthlyBasePay: 0,
      perEventCost: member.eventAllowance as number,
    }),
  )

  return migratedEmployees
}

function normalizeModelConfig(value: unknown): ModelConfig | null {
  if (!isObject(value) || !Array.isArray(value.teamMembers) || !Array.isArray(value.months) || !isObject(value.operating)) {
    return null
  }

  const months = value.months as MonthlyPlan[]
  const planning = normalizePlanning(value.planning, months)
  const teamMembers = normalizeTeamMembers(value.teamMembers)
  const employees = normalizeEmployees(value.employees, value.teamMembers)
  const timelineTemplate =
    isObject(value.timelineTemplate) ? createTimelineTemplate(value.timelineTemplate as Partial<ModelConfig['timelineTemplate']>) : toTimelineTemplate(months.at(-1))

  return {
    operating: value.operating as ModelConfig['operating'],
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

    if (typeof data.schemaVersion !== 'number' || typeof data.workspaceName !== 'string' || !currentConfig || !Array.isArray(data.snapshots) || !data.snapshots.every(isValidSnapshot)) {
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
