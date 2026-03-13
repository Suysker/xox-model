from __future__ import annotations

from .domain_types import (
    EmployeeMonthResult,
    ModelConfig,
    ModelResult,
    MonthlyPlan,
    MonthlyScenarioResult,
    SCENARIO_ORDER,
    ScenarioKey,
    ScenarioResult,
    StageCostItem,
    StageCostValue,
    TeamMember,
    clamp_non_negative,
)


SCENARIO_LABELS: dict[ScenarioKey, tuple[str, str]] = {
    "pessimistic": ("悲观", "按更保守的销量与排期预估，查看现金流下界。"),
    "base": ("基准", "按当前最可能发生的经营方案，作为主要判断口径。"),
    "optimistic": ("乐观", "按更好的销量与排期表现，查看经营上界。"),
}


def sum_cost_items(items: list[object]) -> float:
    return sum(clamp_non_negative(getattr(item, "amount")) for item in items)


def get_stage_cost_value(values: list[StageCostValue], item_id: str) -> StageCostValue | None:
    return next((value for value in values if value.itemId == item_id), None)


def get_stage_cost_totals(items: list[StageCostItem], values: list[StageCostValue]) -> dict[str, float]:
    summary = {"monthly": 0.0, "perEventLike": 0.0, "perUnitLike": 0.0}
    for item in items:
        value = get_stage_cost_value(values, item.id)
        amount = clamp_non_negative(value.amount if value else 0)
        count = clamp_non_negative(float(value.count if value else 0))
        if item.mode == "monthly":
            summary["monthly"] += amount
        elif item.mode == "perEvent":
            summary["perEventLike"] += amount * count
        else:
            summary["perUnitLike"] += amount
    return summary


def is_member_active_in_month(member: TeamMember, month_index: int) -> bool:
    if member.departureMonthIndex is None:
        return True
    return month_index + 1 <= member.departureMonthIndex


def get_units_for_scenario(member: TeamMember, key: ScenarioKey, multiplier: float) -> float:
    return clamp_non_negative(getattr(member.unitsPerEvent, key)) * clamp_non_negative(multiplier)


def get_member_month_results(config: ModelConfig, month: MonthlyPlan, key: ScenarioKey, month_index: int):
    results = []
    for member in config.teamMembers:
        if not is_member_active_in_month(member, month_index):
            results.append(
                {
                    "memberId": member.id,
                    "name": member.name,
                    "employmentType": member.employmentType,
                    "unitsPerEvent": 0,
                    "monthlyUnits": 0,
                    "grossSales": 0,
                    "commissionCost": 0,
                    "basePayCost": 0,
                    "travelCost": 0,
                    "companyNetContribution": 0,
                }
            )
            continue
        units_per_event = get_units_for_scenario(member, key, month.salesMultiplier)
        monthly_units = units_per_event * month.events
        gross_sales = monthly_units * clamp_non_negative(config.operating.offlineUnitPrice)
        commission_cost = gross_sales * clamp_non_negative(member.commissionRate)
        base_pay_cost = clamp_non_negative(member.monthlyBasePay)
        travel_cost = month.events * clamp_non_negative(member.perEventTravelCost)
        results.append(
            {
                "memberId": member.id,
                "name": member.name,
                "employmentType": member.employmentType,
                "unitsPerEvent": units_per_event,
                "monthlyUnits": monthly_units,
                "grossSales": gross_sales,
                "commissionCost": commission_cost,
                "basePayCost": base_pay_cost,
                "travelCost": travel_cost,
                "companyNetContribution": gross_sales - commission_cost - base_pay_cost - travel_cost,
            }
        )
    return results


def get_employee_month_results(config: ModelConfig, month: MonthlyPlan) -> list[EmployeeMonthResult]:
    return [
        EmployeeMonthResult(
            employeeId=employee.id,
            name=employee.name,
            role=employee.role,
            basePayCost=clamp_non_negative(employee.monthlyBasePay),
            perEventCost=month.events * clamp_non_negative(employee.perEventCost),
            totalCost=clamp_non_negative(employee.monthlyBasePay) + month.events * clamp_non_negative(employee.perEventCost),
        )
        for employee in config.employees
    ]


def get_total_investment(config: ModelConfig) -> float:
    return sum(clamp_non_negative(item.investmentAmount) for item in config.shareholders)


def get_scenario_result(config: ModelConfig, key: ScenarioKey) -> ScenarioResult:
    total_investment = get_total_investment(config)
    months: list[MonthlyScenarioResult] = []
    cumulative_profit = 0.0
    payback_month_index: int | None = None
    payback_month_label: str | None = None

    for month_index, month in enumerate(config.months):
        members = get_member_month_results(config, month, key, month_index)
        employees = get_employee_month_results(config, month)
        total_units_per_event = sum(member["unitsPerEvent"] for member in members)
        total_units_per_month = sum(member["monthlyUnits"] for member in members)
        member_gross_sales = sum(member["grossSales"] for member in members)
        online_revenue = total_units_per_month * clamp_non_negative(month.onlineSalesFactor) * clamp_non_negative(config.operating.onlineUnitPrice)
        gross_sales = member_gross_sales + online_revenue
        commission_cost = sum(member["commissionCost"] for member in members)
        base_pay_cost = sum(member["basePayCost"] for member in members)
        member_travel_cost = sum(member["travelCost"] for member in members)
        employee_base = sum(employee.basePayCost for employee in employees)
        employee_event = sum(employee.perEventCost for employee in employees)
        monthly_operating = sum_cost_items(config.operating.monthlyFixedCosts)
        per_event_operating = month.events * sum_cost_items(config.operating.perEventCosts)
        per_unit_operating = sum_cost_items(config.operating.perUnitCosts)
        stage_totals = get_stage_cost_totals(config.stageCostItems, month.specialCosts)
        rehearsal_cost = clamp_non_negative(month.rehearsalCount) * clamp_non_negative(month.rehearsalCost)
        teacher_cost = clamp_non_negative(month.teacherCount) * clamp_non_negative(month.teacherCost)
        special_project_cost = stage_totals["monthly"]
        unit_linked_cost_total = total_units_per_month * (per_unit_operating + stage_totals["perUnitLike"])
        monthly_fixed_total = base_pay_cost + employee_base + monthly_operating + rehearsal_cost + teacher_cost + special_project_cost
        per_event_total = member_travel_cost + employee_event + per_event_operating + stage_totals["perEventLike"]
        operating_cost_total = monthly_fixed_total + per_event_total + unit_linked_cost_total
        total_cost = commission_cost + operating_cost_total
        monthly_profit = gross_sales - total_cost
        cumulative_profit += monthly_profit
        cumulative_cash = cumulative_profit - total_investment
        has_paid_back = cumulative_cash >= 0
        if has_paid_back and payback_month_index is None:
            payback_month_index = month_index + 1
            payback_month_label = month.label
        months.append(
            MonthlyScenarioResult(
                monthId=month.id,
                label=month.label,
                monthIndex=month_index + 1,
                events=month.events,
                salesMultiplier=clamp_non_negative(month.salesMultiplier),
                onlineSalesFactor=clamp_non_negative(month.onlineSalesFactor),
                onlineRevenue=online_revenue,
                memberGrossSales=member_gross_sales,
                totalUnitsPerEvent=total_units_per_event,
                totalUnitsPerMonth=total_units_per_month,
                grossSales=gross_sales,
                commissionCost=commission_cost,
                basePayCost=base_pay_cost,
                memberTravelCost=member_travel_cost,
                employeeBasePayCost=employee_base,
                employeeEventCost=employee_event,
                monthlyOperatingCost=monthly_operating,
                perEventOperatingCost=per_event_operating,
                rehearsalCost=rehearsal_cost,
                teacherCost=teacher_cost,
                specialProjectCost=special_project_cost,
                monthlyFixedCostTotal=monthly_fixed_total,
                perEventCostTotal=per_event_total,
                operatingCostTotal=operating_cost_total,
                unitLinkedCostTotal=unit_linked_cost_total,
                totalCost=total_cost,
                monthlyProfit=monthly_profit,
                cumulativeProfit=cumulative_profit,
                cumulativeCash=cumulative_cash,
                hasPaidBack=has_paid_back,
                members=members,
                employees=employees,
            )
        )

    total_events = sum(month.events for month in months)
    total_units_per_month = sum(month.totalUnitsPerMonth for month in months)
    gross_sales = sum(month.grossSales for month in months)
    operating_cost_total = sum(month.operatingCostTotal for month in months)
    total_cost = sum(month.totalCost for month in months)
    total_profit = sum(month.monthlyProfit for month in months)
    total_commission_cost = sum(month.commissionCost for month in months)
    net_cash_after_investment = total_profit - total_investment
    take_rate = (gross_sales - total_commission_cost) / gross_sales if gross_sales > 0 else 0
    average_units_per_event = total_units_per_month / total_events if total_events > 0 else 0
    roi = net_cash_after_investment / total_investment if total_investment > 0 else 0
    label, description = SCENARIO_LABELS[key]
    return ScenarioResult(
        key=key,
        label=label,
        description=description,
        totalInvestment=total_investment,
        totalEvents=total_events,
        averageUnitsPerEvent=average_units_per_event,
        totalUnitsPerMonth=total_units_per_month,
        grossSales=gross_sales,
        operatingCostTotal=operating_cost_total,
        totalCost=total_cost,
        totalProfit=total_profit,
        netCashAfterInvestment=net_cash_after_investment,
        roi=roi,
        takeRate=take_rate,
        paybackMonthIndex=payback_month_index,
        paybackMonthLabel=payback_month_label,
        months=months,
    )


def project_model(config: ModelConfig) -> ModelResult:
    return ModelResult(scenarios=[get_scenario_result(config, key) for key in SCENARIO_ORDER])
