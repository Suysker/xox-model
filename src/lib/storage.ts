import {
  createCostItem,
  createDefaultStageCostItems,
  createEmployee,
  createMember,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
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
  StageCostItem,
  StageCostValue,
  TeamMember,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types'

export const STORAGE_KEY = 'xox-model-workspace-v1'
export const SCHEMA_VERSION = 9

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
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.round(value * 100) / 100
}

function guessStartMonth(months: MonthlyPlan[]) {
  const firstLabel = months[0]?.label ?? ''
  const matched = firstLabel.match(/^(\d{1,2})月/)

  if (!matched) {
    return 1
  }

  const value = Number(matched[1])
  return Number.isFinite(value) ? Math.min(12, Math.max(1, Math.round(value))) : 1
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
      departureMonthIndex:
        typeof member.departureMonthIndex === 'number' && Number.isFinite(member.departureMonthIndex)
          ? Math.min(24, Math.max(1, Math.round(member.departureMonthIndex)))
          : null,
      commissionRate: normalizePercent(member.commissionRate),
      ...(normalizedUnits ? { unitsPerEvent: normalizedUnits } : {}),
    })
  })
}

function getLegacyDepartureMonth(rawMember: unknown) {
  if (!isObject(rawMember)) {
    return null
  }

  if (typeof rawMember.departureMonth === 'number' && Number.isFinite(rawMember.departureMonth)) {
    return Math.min(12, Math.max(1, Math.round(rawMember.departureMonth)))
  }

  return null
}

function toCycleMonthIndex(label: string) {
  const matched = label.match(/^(\d{1,2})月/)

  if (!matched) {
    return null
  }

  const monthNumber = Number(matched[1])
  return Number.isFinite(monthNumber) ? monthNumber : null
}

function migrateLegacyDepartureMonthConfig(
  config: ModelConfig,
  rawConfig: unknown,
  schemaVersion: number,
): ModelConfig {
  if (schemaVersion >= 9 || !isObject(rawConfig) || !Array.isArray(rawConfig.teamMembers)) {
    return config
  }

  const rawTeamMembers = rawConfig.teamMembers
  const cycleIndexByMonth = new Map<number, number>()

  config.months.forEach((month, index) => {
    const monthNumber = toCycleMonthIndex(month.label)

    if (monthNumber !== null && !cycleIndexByMonth.has(monthNumber)) {
      cycleIndexByMonth.set(monthNumber, index + 1)
    }
  })

  return {
    ...config,
    teamMembers: config.teamMembers.map((member, index) => {
      const rawMember = rawTeamMembers[index]
      const legacyDepartureMonth = getLegacyDepartureMonth(rawMember)

      if (legacyDepartureMonth === null) {
        return member
      }

      return {
        ...member,
        departureMonthIndex: cycleIndexByMonth.get(legacyDepartureMonth) ?? null,
      }
    }),
  }
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

function normalizeCostItems(
  rawItems: unknown,
  prefix: string,
  legacyAmount: number,
  legacyName: string,
  shouldSkip?: (item: Record<string, unknown>) => boolean,
) {
  if (Array.isArray(rawItems)) {
    return rawItems.flatMap((item, index) => {
      if (!isObject(item)) {
        return [createCostItem(`${prefix}-${index}`)]
      }

      if (shouldSkip?.(item)) {
        return []
      }

      return [
        createCostItem(`${prefix}-${index}`, {
          id: typeof item.id === 'string' ? item.id : `cost-${prefix}-${index}`,
          name: typeof item.name === 'string' ? item.name : `${legacyName} ${index + 1}`,
          amount: typeof item.amount === 'number' ? item.amount : 0,
        }),
      ]
    })
  }

  if (legacyAmount > 0) {
    return [
      createCostItem(`legacy-${prefix}`, {
        name: legacyName,
        amount: legacyAmount,
      }),
    ]
  }

  return []
}

function isLegacyMaterialPerUnitItem(item: Record<string, unknown>) {
  return item.id === 'cost-material-polaroid'
}

function getLegacyMaterialCostPerUnit(rawOperating: unknown) {
  if (!isObject(rawOperating)) {
    return 0
  }

  if (typeof rawOperating.materialCostPerUnit === 'number') {
    return rawOperating.materialCostPerUnit
  }

  if (!Array.isArray(rawOperating.perUnitCosts)) {
    return 0
  }

  const legacyItem = rawOperating.perUnitCosts.find(
    (item): item is Record<string, unknown> => isObject(item) && isLegacyMaterialPerUnitItem(item),
  )

  return legacyItem && typeof legacyItem.amount === 'number' ? legacyItem.amount : 0
}

function hasLegacyMaterialConfig(value: Record<string, unknown>) {
  if (isObject(value.timelineTemplate)) {
    if (
      typeof value.timelineTemplate.materialCostPerUnit === 'number' ||
      typeof value.timelineTemplate.includeMaterialCost === 'boolean'
    ) {
      return true
    }
  }

  if (Array.isArray(value.months)) {
    const monthHasLegacyMaterial = value.months.some(
      (month) =>
        isObject(month) &&
        (typeof month.materialCostPerUnit === 'number' || typeof month.includeMaterialCost === 'boolean'),
    )

    if (monthHasLegacyMaterial) {
      return true
    }
  }

  return false
}

function normalizeOperating(rawOperating: unknown, migrateLegacyMaterial: boolean): ModelConfig['operating'] {
  if (!isObject(rawOperating)) {
    return {
      offlineUnitPrice: 88,
      onlineUnitPrice: 120,
      monthlyFixedCosts: [],
      perEventCosts: [],
      perUnitCosts: [],
    }
  }

  const legacyMonthlyFixedCost =
    typeof rawOperating.monthlyFixedCost === 'number' ? rawOperating.monthlyFixedCost : 0
  const legacyPerEventCost =
    typeof rawOperating.perEventOperatingCost === 'number' ? rawOperating.perEventOperatingCost : 0
  const legacyPerUnitCost =
    migrateLegacyMaterial ? 0 : typeof rawOperating.materialCostPerUnit === 'number' ? rawOperating.materialCostPerUnit : 0

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
    monthlyFixedCosts: normalizeCostItems(
      rawOperating.monthlyFixedCosts,
      'monthly-fixed',
      legacyMonthlyFixedCost,
      '经营固定',
    ),
    perEventCosts: normalizeCostItems(
      rawOperating.perEventCosts,
      'per-event',
      legacyPerEventCost,
      '每场成本',
    ),
    perUnitCosts: normalizeCostItems(
      rawOperating.perUnitCosts,
      'per-unit',
      legacyPerUnitCost,
      '每张成本',
      migrateLegacyMaterial ? isLegacyMaterialPerUnitItem : undefined,
    ),
  }
}

function normalizeStageCostName(name: string) {
  const normalized = name.replace(/\/(月|场|张)$/u, '').trim()
  return normalized || '专项成本'
}

const legacyStageCostDefinitions = {
  perEvent: {
    id: 'stage-cost-legacy-other-event',
    name: '其他现场',
    mode: 'perEvent',
  },
  monthly: {
    id: 'stage-cost-legacy-other-monthly',
    name: '其他固定',
    mode: 'monthly',
  },
} as const

function hasLegacyExtraPerEventCost(rawConfig: Record<string, unknown>) {
  if (isObject(rawConfig.timelineTemplate) && typeof rawConfig.timelineTemplate.extraPerEventCost === 'number' && rawConfig.timelineTemplate.extraPerEventCost > 0) {
    return true
  }

  return Array.isArray(rawConfig.months)
    ? rawConfig.months.some(
        (month) => isObject(month) && typeof month.extraPerEventCost === 'number' && month.extraPerEventCost > 0,
      )
    : false
}

function hasLegacyExtraFixedCost(rawConfig: Record<string, unknown>) {
  if (isObject(rawConfig.timelineTemplate)) {
    const timelineTravelCost = typeof rawConfig.timelineTemplate.travelCost === 'number' ? rawConfig.timelineTemplate.travelCost : 0
    const timelineExtraFixedCost =
      typeof rawConfig.timelineTemplate.extraFixedCost === 'number' ? rawConfig.timelineTemplate.extraFixedCost : 0

    if (timelineTravelCost + timelineExtraFixedCost > 0) {
      return true
    }
  }

  return Array.isArray(rawConfig.months)
    ? rawConfig.months.some((month) => {
        if (!isObject(month)) {
          return false
        }

        const monthTravelCost = typeof month.travelCost === 'number' ? month.travelCost : 0
        const monthExtraFixedCost = typeof month.extraFixedCost === 'number' ? month.extraFixedCost : 0
        return monthTravelCost + monthExtraFixedCost > 0
      })
    : false
}

function ensureLegacyStageCostItems(items: StageCostItem[], rawConfig: Record<string, unknown>) {
  const nextItems = [...items]

  if (hasLegacyExtraPerEventCost(rawConfig) && !nextItems.some((item) => item.id === legacyStageCostDefinitions.perEvent.id)) {
    nextItems.push(createStageCostItem('legacy-other-event', legacyStageCostDefinitions.perEvent))
  }

  if (hasLegacyExtraFixedCost(rawConfig) && !nextItems.some((item) => item.id === legacyStageCostDefinitions.monthly.id)) {
    nextItems.push(createStageCostItem('legacy-other-monthly', legacyStageCostDefinitions.monthly))
  }

  return nextItems
}

function normalizeStageCostItems(rawItems: unknown) {
  if (Array.isArray(rawItems)) {
    const normalized = rawItems.map((item, index) => {
      if (!isObject(item)) {
        return createStageCostItem(`import-${index}`)
      }

      return createStageCostItem(`import-${index}`, {
        id: typeof item.id === 'string' ? item.id : `stage-cost-import-${index}`,
        name: typeof item.name === 'string' ? normalizeStageCostName(item.name) : `专项成本 ${index + 1}`,
        mode:
          item.mode === 'monthly' || item.mode === 'perEvent' || item.mode === 'perUnit'
            ? item.mode
            : 'perEvent',
      })
    })

    if (!normalized.some((item) => item.id === 'stage-cost-material')) {
      normalized.push(createStageCostItem('material', { name: '耗材', mode: 'perUnit' }))
    }

    return normalized
  }

  return createDefaultStageCostItems()
}

function getLegacyStageCostAmount(
  source: Record<string, unknown>,
  itemId: string,
  legacyMaterialCostPerUnit: number,
) {
  switch (itemId) {
    case 'stage-cost-vj':
      return typeof source.vjCost === 'number' ? source.vjCost : 0
    case 'stage-cost-original-song':
      return typeof source.originalSongCost === 'number' ? source.originalSongCost : 0
    case 'stage-cost-makeup':
      if (typeof source.makeupPerEventCost === 'number') {
        return source.makeupPerEventCost
      }
      return typeof source.makeupCost === 'number' ? source.makeupCost : 0
    case 'stage-cost-streaming':
      if (typeof source.streamingPerEventCost === 'number') {
        return source.streamingPerEventCost
      }
      return typeof source.streamingCost === 'number' ? source.streamingCost : 0
    case 'stage-cost-meal':
      if (typeof source.mealPerEventCost === 'number') {
        return source.mealPerEventCost
      }
      return typeof source.mealCost === 'number' ? source.mealCost : 0
    case 'stage-cost-material':
      if (typeof source.materialCostPerUnit === 'number') {
        return source.materialCostPerUnit
      }
      if (typeof source.includeMaterialCost === 'boolean') {
        return source.includeMaterialCost ? legacyMaterialCostPerUnit : 0
      }
      return 0
    case 'stage-cost-legacy-other-event':
      return typeof source.extraPerEventCost === 'number' ? source.extraPerEventCost : 0
    case 'stage-cost-legacy-other-monthly':
      return typeof source.extraFixedCost === 'number' ? source.extraFixedCost : 0
    default:
      return 0
  }
}

function normalizeStageCostValues(
  rawValues: unknown,
  items: StageCostItem[],
  legacySource: Record<string, unknown> | null,
  fallbackCount: number,
  legacyMaterialCostPerUnit: number,
) {
  if (Array.isArray(rawValues)) {
    const cleaned: Partial<StageCostValue>[] = []

    rawValues.forEach((value) => {
      if (!isObject(value) || typeof value.itemId !== 'string' || !value.itemId) {
        return
      }

      cleaned.push({
        itemId: value.itemId,
        amount: typeof value.amount === 'number' ? value.amount : 0,
        ...(typeof value.count === 'number' ? { count: value.count } : {}),
      })
    })

    const normalized = createStageCostValues(items, cleaned)

    if (!legacySource) {
      return normalized
    }

    return normalized.map((value) => {
      const item = items.find((stageCostItem) => stageCostItem.id === value.itemId)
      const legacyAmount = getLegacyStageCostAmount(legacySource, value.itemId, legacyMaterialCostPerUnit)

      if (!item || legacyAmount <= 0 || value.amount > 0) {
        return value
      }

      return {
        ...value,
        amount: legacyAmount,
        count: item.mode === 'perEvent' ? fallbackCount : 1,
      }
    })
  }

  if (!legacySource) {
    return createStageCostValues(items)
  }

  return createStageCostValues(
    items,
    items.map((item) => {
      const amount = getLegacyStageCostAmount(legacySource, item.id, legacyMaterialCostPerUnit)

      return {
        itemId: item.id,
        amount,
        count: amount > 0 ? (item.mode === 'perEvent' ? fallbackCount : 1) : 0,
      }
    }),
  )
}

function clampNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function getBaseMonthlyUnits(teamMembers: TeamMember[], events: number, salesMultiplier: number) {
  const totalBaseUnitsPerEvent = teamMembers.reduce(
    (sum, member) => sum + clampNonNegative(member.unitsPerEvent.base),
    0,
  )

  return totalBaseUnitsPerEvent * clampNonNegative(events) * clampNonNegative(salesMultiplier)
}

function normalizeOnlineSalesFactor(
  source: Record<string, unknown>,
  teamMembers: TeamMember[],
  events: number,
  salesMultiplier: number,
  onlineUnitPrice: number,
) {
  if (typeof source.onlineSalesFactor === 'number' && Number.isFinite(source.onlineSalesFactor)) {
    return roundFactor(Math.max(0, source.onlineSalesFactor))
  }

  const baseMonthlyUnits = getBaseMonthlyUnits(teamMembers, events, salesMultiplier)

  if (baseMonthlyUnits <= 0) {
    return 0
  }

  if (typeof source.onlineUnits === 'number' && Number.isFinite(source.onlineUnits)) {
    return roundFactor(Math.max(0, source.onlineUnits) / baseMonthlyUnits)
  }

  if (typeof source.extraChannelRevenue === 'number' && Number.isFinite(source.extraChannelRevenue) && onlineUnitPrice > 0) {
    return roundFactor(Math.max(0, source.extraChannelRevenue) / (baseMonthlyUnits * onlineUnitPrice))
  }

  return 0
}

function normalizeMonth(
  month: unknown,
  index: number,
  stageCostItems: StageCostItem[],
  legacyMaterialCostPerUnit: number,
  teamMembers: TeamMember[],
  onlineUnitPrice: number,
): MonthlyPlan {
  if (!isObject(month)) {
    return {
      id: `month-import-${index}`,
      label: `${index + 1}月`,
      ...createTimelineTemplate(undefined, stageCostItems),
    }
  }

  const events = typeof month.events === 'number' ? month.events : 0
  const legacyTravelCost = typeof month.travelCost === 'number' ? month.travelCost : 0

  return {
    id: typeof month.id === 'string' ? month.id : `month-import-${index}`,
    label: typeof month.label === 'string' ? month.label : `${index + 1}月`,
    events,
    salesMultiplier: roundFactor(typeof month.salesMultiplier === 'number' ? month.salesMultiplier : 0),
    onlineSalesFactor: normalizeOnlineSalesFactor(
      month,
      teamMembers,
      events,
      typeof month.salesMultiplier === 'number' ? month.salesMultiplier : 0,
      onlineUnitPrice,
    ),
    rehearsalCount: typeof month.rehearsalCount === 'number' ? month.rehearsalCount : 0,
    rehearsalCost: typeof month.rehearsalCost === 'number' ? month.rehearsalCost : 0,
    teacherCount: typeof month.teacherCount === 'number' ? month.teacherCount : 0,
    teacherCost: typeof month.teacherCost === 'number' ? month.teacherCost : 0,
    specialCosts: normalizeStageCostValues(
      month.specialCosts,
      stageCostItems,
      {
        ...month,
        extraFixedCost: (typeof month.extraFixedCost === 'number' ? month.extraFixedCost : 0) + legacyTravelCost,
      },
      events,
      legacyMaterialCostPerUnit,
    ),
  }
}

function normalizeMonths(
  rawMonths: unknown,
  stageCostItems: StageCostItem[],
  legacyMaterialCostPerUnit: number,
  teamMembers: TeamMember[],
  onlineUnitPrice: number,
) {
  if (!Array.isArray(rawMonths)) {
    return [] as MonthlyPlan[]
  }

  return rawMonths.map((month, index) =>
    normalizeMonth(month, index, stageCostItems, legacyMaterialCostPerUnit, teamMembers, onlineUnitPrice),
  )
}

function normalizeTimelineTemplate(
  rawTemplate: unknown,
  months: MonthlyPlan[],
  stageCostItems: StageCostItem[],
  legacyMaterialCostPerUnit: number,
  teamMembers: TeamMember[],
  onlineUnitPrice: number,
) {
  if (isObject(rawTemplate)) {
    const templateEvents =
      typeof rawTemplate.events === 'number'
        ? rawTemplate.events
        : months.at(-1)?.events ?? 0
    const legacyTravelCost = typeof rawTemplate.travelCost === 'number' ? rawTemplate.travelCost : 0
    const normalized: Partial<MonthlyPlanTemplate> = {
      specialCosts: normalizeStageCostValues(
        rawTemplate.specialCosts,
        stageCostItems,
        {
          ...rawTemplate,
          extraFixedCost:
            (typeof rawTemplate.extraFixedCost === 'number' ? rawTemplate.extraFixedCost : 0) + legacyTravelCost,
        },
        templateEvents,
        legacyMaterialCostPerUnit,
      ),
    }

    if (typeof rawTemplate.events === 'number') normalized.events = rawTemplate.events
    if (typeof rawTemplate.salesMultiplier === 'number') {
      normalized.salesMultiplier = roundFactor(rawTemplate.salesMultiplier)
    }
    normalized.onlineSalesFactor = normalizeOnlineSalesFactor(
      rawTemplate,
      teamMembers,
      typeof rawTemplate.events === 'number' ? rawTemplate.events : months.at(-1)?.events ?? 0,
      typeof rawTemplate.salesMultiplier === 'number' ? rawTemplate.salesMultiplier : months.at(-1)?.salesMultiplier ?? 0,
      onlineUnitPrice,
    )
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

  const legacyMaterialCostPerUnit = getLegacyMaterialCostPerUnit(value.operating)
  const migrateLegacyMaterial = hasLegacyMaterialConfig(value)
  const stageCostItems = ensureLegacyStageCostItems(normalizeStageCostItems(value.stageCostItems), value)
  const operating = normalizeOperating(value.operating, migrateLegacyMaterial)
  const shareholders = normalizeShareholders(value.shareholders, value.operating)
  const teamMembers = normalizeTeamMembers(value.teamMembers)
  const months = normalizeMonths(
    value.months,
    stageCostItems,
    legacyMaterialCostPerUnit,
    teamMembers,
    operating.onlineUnitPrice,
  )
  const planning = normalizePlanning(value.planning, months)
  const employees = normalizeEmployees(value.employees, value.teamMembers)
  const timelineTemplate = normalizeTimelineTemplate(
    value.timelineTemplate,
    months,
    stageCostItems,
    legacyMaterialCostPerUnit,
    teamMembers,
    operating.onlineUnitPrice,
  )

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
      currentConfig: migrateLegacyDepartureMonthConfig(currentConfig, data.currentConfig, schemaVersion),
      snapshots: data.snapshots.map((snapshot) => ({
        ...snapshot,
        config: migrateLegacyDepartureMonthConfig(
          normalizeModelConfig(snapshot.config) ?? cloneConfig(snapshot.config),
          snapshot.config,
          schemaVersion,
        ),
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
