import type {
  CostItem,
  Employee,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  PlanningConfig,
  Shareholder,
  StageCostItem,
  StageCostMode,
  StageCostValue,
  TeamMember,
} from '../types'

export const monthLabelOptions = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function createId(prefix: string, seed: string) {
  return `${prefix}-${seed}`
}

export function createShareholder(seed: string, values?: Partial<Shareholder>): Shareholder {
  return {
    id: createId('shareholder', seed),
    name: '股东',
    investmentAmount: 0,
    dividendRate: 0,
    ...values,
  }
}

export function createCostItem(seed: string, values?: Partial<CostItem>): CostItem {
  return {
    id: createId('cost', seed),
    name: '新成本项',
    amount: 0,
    ...values,
  }
}

export function createStageCostItem(seed: string, values?: Partial<StageCostItem>): StageCostItem {
  return {
    id: createId('stage-cost', seed),
    name: '新专项成本',
    mode: 'perEvent',
    ...values,
  }
}

export function createStageCostValue(
  itemId: string,
  mode: StageCostMode,
  values?: Partial<StageCostValue>,
): StageCostValue {
  return {
    itemId,
    amount: 0,
    count: mode === 'perEvent' ? 0 : 1,
    ...values,
  }
}

export function createDefaultStageCostItems() {
  return [
    createStageCostItem('vj', { name: '舞台视觉', mode: 'monthly' }),
    createStageCostItem('original-song', { name: '原创', mode: 'monthly' }),
    createStageCostItem('makeup', { name: '化妆', mode: 'perEvent' }),
    createStageCostItem('streaming', { name: '推流', mode: 'perEvent' }),
    createStageCostItem('meal', { name: '聚餐', mode: 'perEvent' }),
    createStageCostItem('team-building', { name: '团建', mode: 'perEvent' }),
    createStageCostItem('material', { name: '耗材', mode: 'perUnit' }),
  ] satisfies StageCostItem[]
}

export function createStageCostValues(items: StageCostItem[], values?: Partial<StageCostValue>[]) {
  const valueMap = new Map((values ?? []).map((item) => [item.itemId, item]))

  return items.map((item) =>
    createStageCostValue(item.id, item.mode, {
      ...(valueMap.get(item.id) ?? {}),
      itemId: item.id,
      count: item.mode === 'perEvent' ? valueMap.get(item.id)?.count ?? 0 : 1,
    }),
  )
}

export function createMember(seed: string, values?: Partial<TeamMember>): TeamMember {
  return {
    id: createId('member', seed),
    name: '新成员',
    employmentType: 'partTime',
    monthlyBasePay: 0,
    perEventTravelCost: 0,
    departureMonthIndex: null,
    commissionRate: 0.35,
    unitsPerEvent: {
      pessimistic: 8,
      base: 12,
      optimistic: 16,
    },
    ...values,
  }
}

export function createEmployee(seed: string, values?: Partial<Employee>): Employee {
  return {
    id: createId('employee', seed),
    name: '新员工',
    role: '现场执行',
    monthlyBasePay: 0,
    perEventCost: 200,
    ...values,
  }
}

export function createTimelineTemplate(
  values?: Partial<MonthlyPlanTemplate>,
  stageCostItems: StageCostItem[] = createDefaultStageCostItems(),
): MonthlyPlanTemplate {
  const nextTemplate = {
    events: 6,
    salesMultiplier: 1,
    onlineSalesFactor: 0,
    rehearsalCount: 4,
    rehearsalCost: 300,
    teacherCount: 4,
    teacherCost: 200,
    specialCosts: createStageCostValues(stageCostItems),
    ...values,
  }

  return {
    ...nextTemplate,
    specialCosts: createStageCostValues(stageCostItems, nextTemplate.specialCosts),
  }
}

export function toTimelineTemplate(
  month?: Partial<MonthlyPlan>,
  stageCostItems: StageCostItem[] = createDefaultStageCostItems(),
): MonthlyPlanTemplate {
  if (!month) {
    return createTimelineTemplate(undefined, stageCostItems)
  }

  const { id: _id, label: _label, ...templateValues } = month
  return createTimelineTemplate(templateValues, stageCostItems)
}

export function createMonth(
  seed: string,
  values?: Partial<MonthlyPlan>,
  stageCostItems: StageCostItem[] = createDefaultStageCostItems(),
): MonthlyPlan {
  const nextMonth = {
    id: createId('month', seed),
    label: '新月份',
    ...createTimelineTemplate(undefined, stageCostItems),
    ...values,
  }

  return {
    ...nextMonth,
    specialCosts: createStageCostValues(stageCostItems, nextMonth.specialCosts),
  }
}

export function getMonthLabel(startMonth: number, index: number) {
  const normalizedStart = Number.isFinite(startMonth) ? Math.min(12, Math.max(1, Math.round(startMonth))) : 1
  const offset = (normalizedStart - 1 + index) % 12

  return monthLabelOptions[offset] ?? `${normalizedStart}月`
}

function createMonthId(seed: string, index: number) {
  return createId('month', `${seed}-${index}-${Date.now()}`)
}

export function syncMonthsToPlanning(
  months: MonthlyPlan[],
  planning: PlanningConfig,
  seed = 'timeline',
  template: MonthlyPlanTemplate = createTimelineTemplate(),
  stageCostItems: StageCostItem[] = createDefaultStageCostItems(),
): MonthlyPlan[] {
  const horizonMonths = Number.isFinite(planning.horizonMonths)
    ? Math.min(24, Math.max(1, Math.round(planning.horizonMonths)))
    : 6
  const startMonth = Number.isFinite(planning.startMonth)
    ? Math.min(12, Math.max(1, Math.round(planning.startMonth)))
    : 1

  return Array.from({ length: horizonMonths }, (_, index) => {
    const current = months[index]

    if (current) {
      return {
        ...current,
        label: getMonthLabel(startMonth, index),
        specialCosts: createStageCostValues(stageCostItems, current.specialCosts),
      }
    }

    return createMonth(
      createMonthId(seed, index),
      {
        ...template,
        id: createMonthId(seed, index),
        label: getMonthLabel(startMonth, index),
      },
      stageCostItems,
    )
  })
}

export function createProductDefaultModel(): ModelConfig {
  const stageCostItems = createDefaultStageCostItems()
  const planning: PlanningConfig = {
    startMonth: 3,
    horizonMonths: 12,
  }
  const startupUnitsPerEvent = 0.66
  const stableUnitsPerEvent = 1.32

  const timelineTemplate = createTimelineTemplate(
    {
      events: 6,
      salesMultiplier: stableUnitsPerEvent,
      onlineSalesFactor: 0,
      rehearsalCount: 4,
      rehearsalCost: 300,
      teacherCount: 4,
      teacherCost: 200,
      specialCosts: [
        {
          itemId: 'stage-cost-material',
          amount: 6,
          count: 1,
        },
      ],
    },
    stageCostItems,
  )

  return {
    shareholders: [
      createShareholder('a', {
        name: '股东 A',
        investmentAmount: 65000,
        dividendRate: 0.684,
      }),
      createShareholder('b', {
        name: '股东 B',
        investmentAmount: 30000,
        dividendRate: 0.316,
      }),
    ],
    operating: {
      offlineUnitPrice: 88,
      onlineUnitPrice: 88,
      polaroidLossRate: 0.1,
      monthlyFixedCosts: [],
      perEventCosts: [],
      perUnitCosts: [],
    },
    planning,
    stageCostItems,
    timelineTemplate,
    teamMembers: [
      createMember('wenchen', {
        name: '文臣',
        employmentType: 'salary',
        monthlyBasePay: 1500,
        commissionRate: 0.15,
        unitsPerEvent: {
          pessimistic: 20,
          base: 32,
          optimistic: 42,
        },
      }),
      createMember('member-a', {
        name: '成员 A',
        unitsPerEvent: {
          pessimistic: 16,
          base: 26,
          optimistic: 32,
        },
      }),
      createMember('member-b', {
        name: '成员 B',
        unitsPerEvent: {
          pessimistic: 15,
          base: 23,
          optimistic: 28,
        },
      }),
      createMember('member-c', {
        name: '成员 C',
        unitsPerEvent: {
          pessimistic: 14,
          base: 21,
          optimistic: 26,
        },
      }),
      createMember('member-d', {
        name: '成员 D',
        unitsPerEvent: {
          pessimistic: 13,
          base: 19,
          optimistic: 24,
        },
      }),
      createMember('member-e', {
        name: '成员 E',
        unitsPerEvent: {
          pessimistic: 12,
          base: 17,
          optimistic: 22,
        },
      }),
      createMember('member-f', {
        name: '成员 F',
        unitsPerEvent: {
          pessimistic: 10,
          base: 14,
          optimistic: 18,
        },
      }),
    ],
    employees: [
      createEmployee('staff-a', {
        name: '员工 A',
        role: '场务',
        perEventCost: 200,
      }),
      createEmployee('staff-b', {
        name: '员工 B',
        role: '场务',
        perEventCost: 200,
      }),
    ],
    months: syncMonthsToPlanning(
      [
        createMonth(
          'mar',
          {
            label: '3月',
            events: 6,
            salesMultiplier: startupUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 8,
            rehearsalCost: 300,
            teacherCount: 8,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 0,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
        createMonth(
          'apr',
          {
            label: '4月',
            events: 6,
            salesMultiplier: stableUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 4,
            rehearsalCost: 300,
            teacherCount: 4,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 0,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
        createMonth(
          'may',
          {
            label: '5月',
            events: 6,
            salesMultiplier: stableUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 4,
            rehearsalCost: 300,
            teacherCount: 4,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 6,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
        createMonth(
          'jun',
          {
            label: '6月',
            events: 6,
            salesMultiplier: stableUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 4,
            rehearsalCost: 300,
            teacherCount: 4,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 6,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
        createMonth(
          'jul',
          {
            label: '7月',
            events: 6,
            salesMultiplier: stableUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 4,
            rehearsalCost: 300,
            teacherCount: 4,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 6,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
        createMonth(
          'aug',
          {
            label: '8月',
            events: 6,
            salesMultiplier: stableUnitsPerEvent,
            onlineSalesFactor: 0,
            rehearsalCount: 4,
            rehearsalCost: 300,
            teacherCount: 4,
            teacherCost: 200,
            specialCosts: createStageCostValues(stageCostItems, [
              {
                itemId: 'stage-cost-material',
                amount: 6,
                count: 1,
              },
            ]),
          },
          stageCostItems,
        ),
      ],
      planning,
      'default',
      timelineTemplate,
      stageCostItems,
    ),
  }
}
