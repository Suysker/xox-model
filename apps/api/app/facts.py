from __future__ import annotations

from .domain_types import ForecastLineItem, ModelConfig, clamp_non_negative
from .projection import project_model


def build_forecast_line_items(config: ModelConfig) -> list[ForecastLineItem]:
    facts: list[ForecastLineItem] = []
    projection = project_model(config)
    stage_item_by_id = {item.id: item for item in config.stageCostItems}
    for scenario in projection.scenarios:
        for month in scenario.months:
            month_plan = config.months[month.monthIndex - 1]
            facts.extend(
                [
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="revenue.offline_sales",
                        subjectName="Offline Sales",
                        subjectType="revenue",
                        subjectGroup="revenue",
                        plannedAmount=month.memberGrossSales,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="revenue.online_sales",
                        subjectName="Online Sales",
                        subjectType="revenue",
                        subjectGroup="revenue",
                        plannedAmount=month.onlineRevenue,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.member.commission",
                        subjectName="Member Commission",
                        subjectType="cost",
                        subjectGroup="member",
                        plannedAmount=month.commissionCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.member.base_pay",
                        subjectName="Member Base Pay",
                        subjectType="cost",
                        subjectGroup="member",
                        plannedAmount=month.basePayCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.member.travel",
                        subjectName="Member Travel",
                        subjectType="cost",
                        subjectGroup="member",
                        plannedAmount=month.memberTravelCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.employee.base_pay",
                        subjectName="Employee Base Pay",
                        subjectType="cost",
                        subjectGroup="employee",
                        plannedAmount=month.employeeBasePayCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.employee.per_event",
                        subjectName="Employee Per Event",
                        subjectType="cost",
                        subjectGroup="employee",
                        plannedAmount=month.employeeEventCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.training.rehearsal",
                        subjectName="Rehearsal",
                        subjectType="cost",
                        subjectGroup="training",
                        plannedAmount=month.rehearsalCost,
                    ),
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey="cost.training.teacher",
                        subjectName="Teacher",
                        subjectType="cost",
                        subjectGroup="training",
                        plannedAmount=month.teacherCost,
                    ),
                ]
            )
            for item in config.operating.monthlyFixedCosts:
                facts.append(
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey=f"cost.operating.monthly.{item.id}",
                        subjectName=item.name,
                        subjectType="cost",
                        subjectGroup="operating_monthly",
                        entityType="cost_item",
                        entityId=item.id,
                        plannedAmount=clamp_non_negative(item.amount),
                    )
                )
            for item in config.operating.perEventCosts:
                facts.append(
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey=f"cost.operating.per_event.{item.id}",
                        subjectName=item.name,
                        subjectType="cost",
                        subjectGroup="operating_per_event",
                        entityType="cost_item",
                        entityId=item.id,
                        plannedAmount=clamp_non_negative(item.amount) * month.events,
                    )
                )
            for item in config.operating.perUnitCosts:
                facts.append(
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey=f"cost.operating.per_unit.{item.id}",
                        subjectName=item.name,
                        subjectType="cost",
                        subjectGroup="operating_per_unit",
                        entityType="cost_item",
                        entityId=item.id,
                        plannedAmount=clamp_non_negative(item.amount) * month.totalUnitsPerMonth,
                    )
                )
            for value in month_plan.specialCosts:
                stage_item = stage_item_by_id.get(value.itemId)
                if stage_item is None:
                    continue
                if stage_item.mode == "monthly":
                    planned_amount = clamp_non_negative(value.amount)
                    subject_group = "stage_monthly"
                elif stage_item.mode == "perEvent":
                    planned_amount = clamp_non_negative(value.amount) * clamp_non_negative(float(value.count))
                    subject_group = "stage_per_event"
                else:
                    planned_amount = clamp_non_negative(value.amount) * month.totalUnitsPerMonth
                    subject_group = "stage_per_unit"
                facts.append(
                    ForecastLineItem(
                        scenarioKey=scenario.key,
                        monthIndex=month.monthIndex,
                        monthLabel=month.label,
                        subjectKey=f"cost.stage.{stage_item.mode}.{stage_item.id}",
                        subjectName=stage_item.name,
                        subjectType="cost",
                        subjectGroup=subject_group,
                        entityType="stage_cost_item",
                        entityId=stage_item.id,
                        plannedAmount=planned_amount,
                    )
                )
    return facts
