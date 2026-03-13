from __future__ import annotations

from .domain_types import (
    CostItem,
    Employee,
    ModelConfig,
    MONTH_LABELS,
    MonthlyPlan,
    MonthlyPlanTemplate,
    OperatingConfig,
    PlanningConfig,
    ScenarioBand,
    Shareholder,
    StageCostItem,
    StageCostMode,
    StageCostValue,
    TeamMember,
)


def create_stage_cost_item(seed: str, *, name: str, mode: StageCostMode) -> StageCostItem:
    return StageCostItem(id=f"stage-cost-{seed}", name=name, mode=mode)


def create_default_stage_cost_items() -> list[StageCostItem]:
    return [
        create_stage_cost_item("vj", name="舞台视觉", mode="monthly"),
        create_stage_cost_item("original-song", name="原创", mode="monthly"),
        create_stage_cost_item("makeup", name="化妆", mode="perEvent"),
        create_stage_cost_item("streaming", name="推流", mode="perEvent"),
        create_stage_cost_item("meal", name="聚餐", mode="perEvent"),
        create_stage_cost_item("team-building", name="团建", mode="perEvent"),
        create_stage_cost_item("material", name="耗材", mode="perUnit"),
    ]


def create_stage_cost_values(items: list[StageCostItem], values: list[StageCostValue] | None = None) -> list[StageCostValue]:
    value_map = {value.itemId: value for value in values or []}
    normalized: list[StageCostValue] = []
    for item in items:
        current = value_map.get(item.id)
        normalized.append(
            StageCostValue(
                itemId=item.id,
                amount=current.amount if current else 0,
                count=current.count if current else (0 if item.mode == "perEvent" else 1),
            )
        )
    return normalized


def get_month_label(start_month: int, index: int) -> str:
    normalized_start = min(12, max(1, round(start_month)))
    offset = (normalized_start - 1 + index) % 12
    return MONTH_LABELS[offset]


def create_default_model() -> ModelConfig:
    stage_cost_items = create_default_stage_cost_items()
    planning = PlanningConfig(startMonth=3, horizonMonths=12)
    startup_units = 0.66
    stable_units = 1.32
    timeline_template = MonthlyPlanTemplate(
        events=6,
        salesMultiplier=stable_units,
        onlineSalesFactor=0,
        rehearsalCount=4,
        rehearsalCost=300,
        teacherCount=4,
        teacherCost=200,
        specialCosts=create_stage_cost_values(
            stage_cost_items,
            [StageCostValue(itemId="stage-cost-material", amount=6, count=1)],
        ),
    )

    months: list[MonthlyPlan] = []
    for month_index in range(planning.horizonMonths):
        is_startup = month_index == 0
        stage_material_amount = 0 if month_index < 2 else 6
        months.append(
            MonthlyPlan(
                id=f"month-default-{month_index + 1}",
                label=get_month_label(planning.startMonth, month_index),
                events=6,
                salesMultiplier=startup_units if is_startup else stable_units,
                onlineSalesFactor=0,
                rehearsalCount=8 if is_startup else 4,
                rehearsalCost=300,
                teacherCount=8 if is_startup else 4,
                teacherCost=200,
                specialCosts=create_stage_cost_values(
                    stage_cost_items,
                    [StageCostValue(itemId="stage-cost-material", amount=stage_material_amount, count=1)],
                ),
            )
        )

    return ModelConfig(
        shareholders=[
            Shareholder(id="shareholder-a", name="股东 A", investmentAmount=65000, dividendRate=0.684),
            Shareholder(id="shareholder-b", name="股东 B", investmentAmount=30000, dividendRate=0.316),
        ],
        operating=OperatingConfig(
            offlineUnitPrice=88,
            onlineUnitPrice=88,
            monthlyFixedCosts=[],
            perEventCosts=[],
            perUnitCosts=[],
        ),
        planning=planning,
        stageCostItems=stage_cost_items,
        timelineTemplate=timeline_template,
        teamMembers=[
            TeamMember(
                id="member-lead",
                name="主成员",
                employmentType="salary",
                monthlyBasePay=1500,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.15,
                unitsPerEvent=ScenarioBand(pessimistic=20, base=32, optimistic=42),
            ),
            TeamMember(
                id="member-a",
                name="成员 A",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=16, base=26, optimistic=32),
            ),
            TeamMember(
                id="member-b",
                name="成员 B",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=15, base=23, optimistic=28),
            ),
            TeamMember(
                id="member-c",
                name="成员 C",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=14, base=21, optimistic=26),
            ),
            TeamMember(
                id="member-d",
                name="成员 D",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=13, base=19, optimistic=24),
            ),
            TeamMember(
                id="member-e",
                name="成员 E",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=12, base=17, optimistic=22),
            ),
            TeamMember(
                id="member-f",
                name="成员 F",
                employmentType="partTime",
                monthlyBasePay=0,
                perEventTravelCost=0,
                departureMonthIndex=None,
                commissionRate=0.35,
                unitsPerEvent=ScenarioBand(pessimistic=10, base=14, optimistic=18),
            ),
        ],
        employees=[
            Employee(id="employee-a", name="员工 A", role="场务", monthlyBasePay=0, perEventCost=200),
            Employee(id="employee-b", name="员工 B", role="场务", monthlyBasePay=0, perEventCost=200),
        ],
        months=months,
    )
