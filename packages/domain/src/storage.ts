import {
  createCostItem,
  createDefaultStageCostItems,
  createEmployee,
  createMember,
  createProductDefaultModel,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
  createTimelineTemplate,
  syncMonthsToPlanning,
  toTimelineTemplate,
} from './defaults.js'
import type {
  Employee,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  PlanningConfig,
  Shareholder,
  StageCostItem,
  StageCostValue,
  TeamMember,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from './types.js'

export const STORAGE_KEY = 'xox-model-workspace-v1'
export const SCHEMA_VERSION = 10

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
    return Math.round((value / 100) * 10000) / 10000
  }

  return Math.round(value * 10000) / 10000
}

function roundFactor(value: number) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function guessStartMonth(months: MonthlyPlan[]) {
  const firstLabel = months[0]?.label ?? ''
  const matched = firstLabel.match(/^(\d{1,2})月/)
  if (!matched) return 1
  const value = Number(matched[1])
  return Number.isFinite(value) ? Math.min(12, Math.max(1, Math.round(value))) : 1
}

function normalizePlanning(rawPlanning: unknown, months: MonthlyPlan[]): PlanningConfig {
  if (isObject(rawPlanning)) {
    return {
      startMonth:
        typeof rawPlanning.startMonth === 'number'
          ? Math.min(12, Math.max(1, Math.round(rawPlanning.startMonth)))
          : guessStartMonth(months),
      horizonMonths:
        typeof rawPlanning.horizonMonths === 'number'
          ? Math.min(24, Math.max(1, Math.round(rawPlanning.horizonMonths)))
          : Math.max(1, months.length),
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
      if (!isObject(shareholder)) return createShareholder(`import-${index}`)
      return createShareholder(`import-${index}`, {
        id: typeof shareholder.id === 'string' ? shareholder.id : `shareholder-import-${index}`,
        name: typeof shareholder.name === 'string' ? shareholder.name : `股东 ${index + 1}`,
        investmentAmount: typeof shareholder.investmentAmount === 'number' ? shareholder.investmentAmount : 0,
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
  if (!Array.isArray(rawMembers)) return [] as TeamMember[]

  return rawMembers.map((member, index) => {
    if (!isObject(member)) return createMember(`import-${index}`)

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
      departureMonthIndex:
        typeof member.departureMonthIndex === 'number' && Number.isFinite(member.departureMonthIndex)
          ? Math.min(24, Math.max(1, Math.round(member.departureMonthIndex)))
          : null,
      commissionRate: normalizePercent(member.commissionRate),
      ...(normalizedUnits ? { unitsPerEvent: normalizedUnits } : {}),
    })
  })
}

function normalizeEmployees(rawEmployees: unknown, rawMembers: unknown) {
  if (Array.isArray(rawEmployees)) {
    return rawEmployees.map((employee, index) => {
      if (!isObject(employee)) return createEmployee(`import-${index}`)
      return createEmployee(`import-${index}`, {
        id: typeof employee.id === 'string' ? employee.id : `employee-import-${index}`,
        name: typeof employee.name === 'string' ? employee.name : `员工 ${index + 1}`,
        role: typeof employee.role === 'string' ? employee.role : '现场执行',
        monthlyBasePay: typeof employee.monthlyBasePay === 'number' ? employee.monthlyBasePay : 0,
        perEventCost: typeof employee.perEventCost === 'number' ? employee.perEventCost : 0,
      })
    })
  }

  if (!Array.isArray(rawMembers)) return [] as Employee[]

  return rawMembers
    .filter((member): member is Record<string, unknown> => isObject(member) && typeof member.eventAllowance === 'number' && member.eventAllowance > 0)
    .map((member, index) =>
      createEmployee(`legacy-${index}`, {
        name: `员工 ${index + 1}`,
        role: '历史场务',
        monthlyBasePay: 0,
        perEventCost: member.eventAllowance as number,
      }),
    )
}

function normalizeCostItems(rawItems: unknown, prefix: string, legacyAmount: number, legacyName: string) {
  if (Array.isArray(rawItems)) {
    return rawItems.map((item, index) => {
      if (!isObject(item)) return createCostItem(`${prefix}-${index}`)
      return createCostItem(`${prefix}-${index}`, {
        id: typeof item.id === 'string' ? item.id : `cost-${prefix}-${index}`,
        name: typeof item.name === 'string' ? item.name : `${legacyName} ${index + 1}`,
        amount: typeof item.amount === 'number' ? item.amount : 0,
      })
    })
  }

  return legacyAmount > 0 ? [createCostItem(`legacy-${prefix}`, { name: legacyName, amount: legacyAmount })] : []
}

function normalizeOperating(rawOperating: unknown): ModelConfig['operating'] {
  if (!isObject(rawOperating)) {
    return {
      offlineUnitPrice: 88,
      onlineUnitPrice: 120,
      polaroidLossRate: 0.1,
      monthlyFixedCosts: [],
      perEventCosts: [],
      perUnitCosts: [],
    }
  }

  return {
    offlineUnitPrice:
      typeof rawOperating.offlineUnitPrice === 'number'
        ? rawOperating.offlineUnitPrice
        : typeof rawOperating.unitPrice === 'number'
          ? rawOperating.unitPrice
          : 88,
    onlineUnitPrice:
      typeof rawOperating.onlineUnitPrice === 'number'
        ? rawOperating.onlineUnitPrice
        : typeof rawOperating.unitPrice === 'number'
          ? rawOperating.unitPrice
          : 120,
    polaroidLossRate: normalizePercent(rawOperating.polaroidLossRate ?? 0.1),
    monthlyFixedCosts: normalizeCostItems(
      rawOperating.monthlyFixedCosts,
      'monthly-fixed',
      typeof rawOperating.monthlyFixedCost === 'number' ? rawOperating.monthlyFixedCost : 0,
      '经营固定',
    ),
    perEventCosts: normalizeCostItems(
      rawOperating.perEventCosts,
      'per-event',
      typeof rawOperating.perEventOperatingCost === 'number' ? rawOperating.perEventOperatingCost : 0,
      '每场成本',
    ),
    perUnitCosts: normalizeCostItems(
      rawOperating.perUnitCosts,
      'per-unit',
      typeof rawOperating.materialCostPerUnit === 'number' ? rawOperating.materialCostPerUnit : 0,
      '每张成本',
    ),
  }
}

function normalizeStageCostName(name: string) {
  const normalized = name.replace(/\/(月|场|张)$/u, '').trim()
  const localizedNames: Record<string, string> = {
    VJ: '舞台视觉',
    'Original Song': '原创',
    Costume: '服装',
    'Performance Fee': '演出收费',
    Makeup: '化妆',
    Streaming: '推流',
    Meal: '聚餐',
    'Team Building': '团建',
    Material: '耗材',
  }
  return (localizedNames[normalized] ?? normalized) || '专项成本'
}

function normalizeStageCostItems(rawItems: unknown) {
  if (Array.isArray(rawItems)) {
    const normalized = rawItems.map((item, index) => {
      if (!isObject(item)) return createStageCostItem(`import-${index}`)
      return createStageCostItem(`import-${index}`, {
        id: typeof item.id === 'string' ? item.id : `stage-cost-import-${index}`,
        name: typeof item.name === 'string' ? normalizeStageCostName(item.name) : `专项成本 ${index + 1}`,
        mode:
          item.mode === 'monthly' || item.mode === 'perEvent' || item.mode === 'perUnit'
            ? item.mode
            : 'perEvent',
      })
    })
    const defaultItems = createDefaultStageCostItems()
    const normalizedById = new Map(normalized.map((item) => [item.id, item]))
    const defaultItemIds = new Set(defaultItems.map((item) => item.id))
    const customItems = normalized.filter((item) => !defaultItemIds.has(item.id))
    return [...defaultItems.map((item) => normalizedById.get(item.id) ?? item), ...customItems]
  }

  return createDefaultStageCostItems()
}

function normalizeStageCostValues(rawValues: unknown, items: StageCostItem[]) {
  if (!Array.isArray(rawValues)) {
    return createStageCostValues(items)
  }

  const cleaned: Partial<StageCostValue>[] = []
  rawValues.forEach((value) => {
    if (!isObject(value) || typeof value.itemId !== 'string' || !value.itemId) return
    cleaned.push({
      itemId: value.itemId,
      amount: typeof value.amount === 'number' ? value.amount : 0,
      ...(typeof value.count === 'number' ? { count: value.count } : {}),
    })
  })

  return createStageCostValues(items, cleaned)
}

function normalizeOnlineSalesFactor(source: Record<string, unknown>) {
  return typeof source.onlineSalesFactor === 'number' && Number.isFinite(source.onlineSalesFactor)
    ? roundFactor(Math.max(0, source.onlineSalesFactor))
    : 0
}

function normalizeMonth(month: unknown, index: number, stageCostItems: StageCostItem[]): MonthlyPlan {
  if (!isObject(month)) {
    return {
      id: `month-import-${index}`,
      label: `${index + 1}月`,
      ...createTimelineTemplate(undefined, stageCostItems),
    }
  }

  return {
    id: typeof month.id === 'string' ? month.id : `month-import-${index}`,
    label: typeof month.label === 'string' ? month.label : `${index + 1}月`,
    events: typeof month.events === 'number' ? month.events : 0,
    salesMultiplier: roundFactor(typeof month.salesMultiplier === 'number' ? month.salesMultiplier : 0),
    onlineSalesFactor: normalizeOnlineSalesFactor(month),
    rehearsalCount: typeof month.rehearsalCount === 'number' ? month.rehearsalCount : 0,
    rehearsalCost: typeof month.rehearsalCost === 'number' ? month.rehearsalCost : 0,
    teacherCount: typeof month.teacherCount === 'number' ? month.teacherCount : 0,
    teacherCost: typeof month.teacherCost === 'number' ? month.teacherCost : 0,
    specialCosts: normalizeStageCostValues(month.specialCosts, stageCostItems),
  }
}

function normalizeMonths(rawMonths: unknown, stageCostItems: StageCostItem[]) {
  if (!Array.isArray(rawMonths)) return [] as MonthlyPlan[]
  return rawMonths.map((month, index) => normalizeMonth(month, index, stageCostItems))
}

function normalizeTimelineTemplate(rawTemplate: unknown, months: MonthlyPlan[], stageCostItems: StageCostItem[]) {
  if (isObject(rawTemplate)) {
    const normalized: Partial<MonthlyPlanTemplate> = {
      specialCosts: normalizeStageCostValues(rawTemplate.specialCosts, stageCostItems),
    }

    if (typeof rawTemplate.events === 'number') normalized.events = rawTemplate.events
    if (typeof rawTemplate.salesMultiplier === 'number') normalized.salesMultiplier = roundFactor(rawTemplate.salesMultiplier)
    normalized.onlineSalesFactor = normalizeOnlineSalesFactor(rawTemplate)
    if (typeof rawTemplate.rehearsalCount === 'number') normalized.rehearsalCount = rawTemplate.rehearsalCount
    if (typeof rawTemplate.rehearsalCost === 'number') normalized.rehearsalCost = rawTemplate.rehearsalCost
    if (typeof rawTemplate.teacherCount === 'number') normalized.teacherCount = rawTemplate.teacherCount
    if (typeof rawTemplate.teacherCost === 'number') normalized.teacherCost = rawTemplate.teacherCost

    return createTimelineTemplate(normalized, stageCostItems)
  }

  return toTimelineTemplate(months.at(-1), stageCostItems)
}

function normalizeModelConfig(value: unknown): ModelConfig | null {
  if (!isObject(value) || !Array.isArray(value.teamMembers) || !Array.isArray(value.months)) {
    return null
  }

  const stageCostItems = normalizeStageCostItems(value.stageCostItems)
  const operating = normalizeOperating(value.operating)
  const shareholders = normalizeShareholders(value.shareholders, value.operating)
  const teamMembers = normalizeTeamMembers(value.teamMembers)
  const months = normalizeMonths(value.months, stageCostItems)
  const planning = normalizePlanning(value.planning, months)
  const employees = normalizeEmployees(value.employees, value.teamMembers)
  const timelineTemplate = normalizeTimelineTemplate(value.timelineTemplate, months, stageCostItems)

  return {
    shareholders,
    operating,
    planning,
    stageCostItems,
    timelineTemplate,
    teamMembers,
    employees,
    months: syncMonthsToPlanning(months, planning, 'import', timelineTemplate, stageCostItems),
  }
}

export function hydrateModelConfig(value: unknown): ModelConfig {
  return normalizeModelConfig(value) ?? createProductDefaultModel()
}

function isValidModelConfig(value: unknown): value is ModelConfig {
  return normalizeModelConfig(value) !== null
}

function isValidSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isObject(value)) return false
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
    if (!isObject(data)) return null

    const schemaVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : null
    const currentConfig = normalizeModelConfig(data.currentConfig)
    if (
      schemaVersion === null ||
      typeof data.workspaceName !== 'string' ||
      !currentConfig ||
      !Array.isArray(data.snapshots) ||
      !data.snapshots.every(isValidSnapshot)
    ) {
      return null
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceName: data.workspaceName,
      currentConfig,
      snapshots: data.snapshots.map((snapshot) => ({
        ...snapshot,
        config: hydrateModelConfig(snapshot.config),
      })),
      lastSavedAt: typeof data.lastSavedAt === 'string' ? data.lastSavedAt : null,
    }
  } catch {
    return null
  }
}

export function loadWorkspaceBundle(): WorkspaceBundle | null {
  const storage = (globalThis as { window?: { localStorage?: { getItem: (key: string) => string | null } } }).window?.localStorage
  if (!storage) return null
  const raw = storage.getItem(STORAGE_KEY)
  return raw ? parseWorkspaceBundle(raw) : null
}

export function saveWorkspaceBundle(bundle: WorkspaceBundle) {
  const storage = (globalThis as { window?: { localStorage?: { setItem: (key: string, value: string) => void } } }).window?.localStorage
  if (!storage) return
  storage.setItem(STORAGE_KEY, JSON.stringify(bundle))
}

export function serializeWorkspaceBundle(bundle: WorkspaceBundle) {
  return JSON.stringify(bundle, null, 2)
}
