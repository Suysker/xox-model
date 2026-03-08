import type { ModelConfig, MonthlyPlan, TeamMember } from '../types'

function createId(prefix: string, seed: string) {
  return `${prefix}-${seed}`
}

export function createMember(seed: string, values?: Partial<TeamMember>): TeamMember {
  return {
    id: createId('member', seed),
    name: '新成员',
    employmentType: 'partTime',
    monthlyBasePay: 0,
    commissionRate: 0.35,
    eventAllowance: 0,
    unitsPerEvent: {
      pessimistic: 8,
      base: 12,
      optimistic: 16,
    },
    ...values,
  }
}

export function createMonth(seed: string, values?: Partial<MonthlyPlan>): MonthlyPlan {
  return {
    id: createId('month', seed),
    label: '新月份',
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

export function createProductDefaultModel(): ModelConfig {
  return {
    operating: {
      initialInvestment: 85000,
      unitPrice: 88,
      monthlyFixedCost: 0,
      perEventOperatingCost: 0,
      materialCostPerUnit: 6,
    },
    teamMembers: [
      createMember('wenchen', {
        name: '文臣',
        employmentType: 'salary',
        monthlyBasePay: 1500,
        commissionRate: 0.15,
        eventAllowance: 0,
        unitsPerEvent: {
          pessimistic: 20,
          base: 32,
          optimistic: 42,
        },
      }),
      createMember('member-a', {
        name: '成员 A',
        eventAllowance: 300,
        unitsPerEvent: {
          pessimistic: 16,
          base: 26,
          optimistic: 32,
        },
      }),
      createMember('member-b', {
        name: '成员 B',
        eventAllowance: 300,
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
    months: [
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
  }
}
