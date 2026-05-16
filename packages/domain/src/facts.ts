import type { ForecastLineItem, ModelConfig } from './types.js'
import { clampToNonNegative } from './costs.js'
import { projectModel } from './model.js'

export function buildForecastLineItems(config: ModelConfig): ForecastLineItem[] {
  const facts: ForecastLineItem[] = []
  const projection = projectModel(config)
  const stageItemById = new Map(config.stageCostItems.map((item) => [item.id, item]))

  for (const scenario of projection.scenarios) {
    for (const month of scenario.months) {
      const monthPlan = config.months[month.monthIndex - 1]
      if (!monthPlan) {
        continue
      }

      facts.push(
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'revenue.offline_sales',
          subjectName: '线下营收',
          subjectType: 'revenue',
          subjectGroup: 'revenue',
          plannedAmount: month.memberGrossSales,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'revenue.online_sales',
          subjectName: '线上营收',
          subjectType: 'revenue',
          subjectGroup: 'revenue',
          plannedAmount: month.onlineRevenue,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.member.commission',
          subjectName: '成员提成',
          subjectType: 'cost',
          subjectGroup: 'member',
          plannedAmount: month.commissionCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.member.base_pay',
          subjectName: '成员底薪',
          subjectType: 'cost',
          subjectGroup: 'member',
          plannedAmount: month.basePayCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.member.travel',
          subjectName: '成员路费',
          subjectType: 'cost',
          subjectGroup: 'member',
          plannedAmount: month.memberTravelCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.employee.base_pay',
          subjectName: '员工月薪',
          subjectType: 'cost',
          subjectGroup: 'employee',
          plannedAmount: month.employeeBasePayCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.employee.per_event',
          subjectName: '员工场次',
          subjectType: 'cost',
          subjectGroup: 'employee',
          plannedAmount: month.employeeEventCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.training.rehearsal',
          subjectName: '排练',
          subjectType: 'cost',
          subjectGroup: 'training',
          plannedAmount: month.rehearsalCost,
        },
        {
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: 'cost.training.teacher',
          subjectName: '老师',
          subjectType: 'cost',
          subjectGroup: 'training',
          plannedAmount: month.teacherCost,
        },
      )

      for (const item of config.operating.monthlyFixedCosts) {
        facts.push({
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: `cost.operating.monthly.${item.id}`,
          subjectName: item.name,
          subjectType: 'cost',
          subjectGroup: 'operating_monthly',
          entityType: 'cost_item',
          entityId: item.id,
          plannedAmount: clampToNonNegative(item.amount),
        })
      }

      for (const item of config.operating.perEventCosts) {
        facts.push({
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: `cost.operating.per_event.${item.id}`,
          subjectName: item.name,
          subjectType: 'cost',
          subjectGroup: 'operating_per_event',
          entityType: 'cost_item',
          entityId: item.id,
          plannedAmount: clampToNonNegative(item.amount) * month.events,
        })
      }

      for (const item of config.operating.perUnitCosts) {
        facts.push({
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: `cost.operating.per_unit.${item.id}`,
          subjectName: item.name,
          subjectType: 'cost',
          subjectGroup: 'operating_per_unit',
          entityType: 'cost_item',
          entityId: item.id,
          plannedAmount: clampToNonNegative(item.amount) * month.totalUnitsPerMonth,
        })
      }

      for (const value of monthPlan.specialCosts) {
        const stageItem = stageItemById.get(value.itemId)
        if (!stageItem) {
          continue
        }

        const plannedAmount =
          stageItem.mode === 'monthly'
            ? clampToNonNegative(value.amount)
            : stageItem.mode === 'perEvent'
              ? clampToNonNegative(value.amount) * clampToNonNegative(value.count)
              : clampToNonNegative(value.amount) * month.totalUnitsPerMonth
        const subjectGroup =
          stageItem.mode === 'monthly'
            ? 'stage_monthly'
            : stageItem.mode === 'perEvent'
              ? 'stage_per_event'
              : 'stage_per_unit'

        facts.push({
          scenarioKey: scenario.key,
          monthIndex: month.monthIndex,
          monthLabel: month.label,
          subjectKey: `cost.stage.${stageItem.mode}.${stageItem.id}`,
          subjectName: stageItem.name,
          subjectType: 'cost',
          subjectGroup,
          entityType: 'stage_cost_item',
          entityId: stageItem.id,
          plannedAmount,
        })
      }
    }
  }

  return facts
}
