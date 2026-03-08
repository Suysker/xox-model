import type {
  Employee,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  PlanningConfig,
  TeamMember,
} from '../types'

export const monthLabelOptions = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function createId(prefix: string, seed: string) {
  return `${prefix}-${seed}`
}

export function createTimelineTemplate(values?: Partial<MonthlyPlanTemplate>): MonthlyPlanTemplate {
  return {
    events: 6,
    salesMultiplier: 1,
    rehearsalCount: 4,
    rehearsalCost: 300,
    teacherCount: 4,
    teacherCost: 200,
    extraPerEventCost: 0,
    extraFixedCost: 0,
    vjCost: 0,
    originalSongCost: 0,
    makeupCost: 0,
    travelCost: 0,
    streamingCost: 0,
    mealCost: 0,
    includeMaterialCost: true,
    notes: '',
    ...values,
  }
}

export function toTimelineTemplate(month?: Partial<MonthlyPlan>): MonthlyPlanTemplate {
  if (!month) {
    return createTimelineTemplate()
  }

  const { id: _id, label: _label, ...templateValues } = month
  return createTimelineTemplate(templateValues)
}

export function createMember(seed: string, values?: Partial<TeamMember>): TeamMember {
  return {
    id: createId('member', seed),
    name: '新成员',
    employmentType: 'partTime',
    monthlyBasePay: 0,
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
    perEventCost: 300,
    ...values,
  }
}

export function createMonth(seed: string, values?: Partial<MonthlyPlan>): MonthlyPlan {
  return {
    id: createId('month', seed),
    label: '新月份',
    ...createTimelineTemplate(),
    ...values,
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
      }
    }

    return createMonth(createMonthId(seed, index), {
      ...template,
      id: createMonthId(seed, index),
      label: getMonthLabel(startMonth, index),
    })
  })
}

export function createProductDefaultModel(): ModelConfig {
  const planning = {
    startMonth: 3,
    horizonMonths: 6,
  }

  const timelineTemplate = createTimelineTemplate({
    events: 6,
    salesMultiplier: 1,
    rehearsalCount: 4,
    rehearsalCost: 300,
    teacherCount: 4,
    teacherCost: 200,
    includeMaterialCost: true,
  })

  return {
    operating: {
      initialInvestment: 85000,
      unitPrice: 88,
      monthlyFixedCost: 0,
      perEventOperatingCost: 0,
      materialCostPerUnit: 6,
    },
    planning,
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
        perEventCost: 300,
      }),
      createEmployee('staff-b', {
        name: '员工 B',
        role: '场务',
        perEventCost: 300,
      }),
    ],
    months: syncMonthsToPlanning(
      [
        createMonth('mar', {
          label: '3月',
          events: 6,
          salesMultiplier: 0.66,
          rehearsalCount: 8,
          rehearsalCost: 300,
          teacherCount: 8,
          teacherCost: 200,
          includeMaterialCost: false,
          notes: '启动月，按单场约 100 张估算。',
        }),
        createMonth('apr', {
          label: '4月',
          events: 6,
          salesMultiplier: 1,
          rehearsalCount: 4,
          rehearsalCost: 300,
          teacherCount: 4,
          teacherCost: 200,
          includeMaterialCost: false,
          notes: '按对话中的稳定运营月建模。',
        }),
        createMonth('may', {
          label: '5月',
          events: 6,
          salesMultiplier: 1.3,
          rehearsalCount: 4,
          rehearsalCost: 300,
          teacherCount: 4,
          teacherCost: 200,
          includeMaterialCost: true,
          notes: '按单场约 200 张的增长月建模。',
        }),
        createMonth('jun', {
          label: '6月',
          events: 6,
          salesMultiplier: 1.3,
          rehearsalCount: 4,
          rehearsalCost: 300,
          teacherCount: 4,
          teacherCost: 200,
          includeMaterialCost: true,
        }),
        createMonth('jul', {
          label: '7月',
          events: 6,
          salesMultiplier: 1.35,
          rehearsalCount: 4,
          rehearsalCost: 300,
          teacherCount: 4,
          teacherCost: 200,
          includeMaterialCost: true,
        }),
        createMonth('aug', {
          label: '8月',
          events: 6,
          salesMultiplier: 1.35,
          rehearsalCount: 4,
          rehearsalCost: 300,
          teacherCount: 4,
          teacherCost: 200,
          includeMaterialCost: true,
        }),
      ],
      planning,
      'default',
      timelineTemplate,
    ),
  }
}
