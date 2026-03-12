from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


ScenarioKey = Literal["pessimistic", "base", "optimistic"]
EmploymentType = Literal["salary", "partTime"]
StageCostMode = Literal["monthly", "perEvent", "perUnit"]
VersionKind = Literal["snapshot", "release"]
SubjectType = Literal["revenue", "cost"]

SCENARIO_ORDER: tuple[ScenarioKey, ...] = ("pessimistic", "base", "optimistic")
MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]


def clamp_non_negative(value: float) -> float:
    if value != value or value < 0:
        return 0
    return value


class ScenarioBand(BaseModel):
    pessimistic: float
    base: float
    optimistic: float


class CostItem(BaseModel):
    id: str
    name: str
    amount: float


class StageCostItem(BaseModel):
    id: str
    name: str
    mode: StageCostMode


class StageCostValue(BaseModel):
    itemId: str
    amount: float
    count: int


class Shareholder(BaseModel):
    id: str
    name: str
    investmentAmount: float
    dividendRate: float


class TeamMember(BaseModel):
    id: str
    name: str
    employmentType: EmploymentType
    monthlyBasePay: float
    perEventTravelCost: float
    departureMonthIndex: int | None
    commissionRate: float
    unitsPerEvent: ScenarioBand


class Employee(BaseModel):
    id: str
    name: str
    role: str
    monthlyBasePay: float
    perEventCost: float


class OperatingConfig(BaseModel):
    offlineUnitPrice: float
    onlineUnitPrice: float
    monthlyFixedCosts: list[CostItem]
    perEventCosts: list[CostItem]
    perUnitCosts: list[CostItem]


class PlanningConfig(BaseModel):
    startMonth: int
    horizonMonths: int


class MonthlyPlan(BaseModel):
    id: str
    label: str
    events: int
    salesMultiplier: float
    onlineSalesFactor: float
    rehearsalCount: int
    rehearsalCost: float
    teacherCount: int
    teacherCost: float
    specialCosts: list[StageCostValue]


class MonthlyPlanTemplate(BaseModel):
    events: int
    salesMultiplier: float
    onlineSalesFactor: float
    rehearsalCount: int
    rehearsalCost: float
    teacherCount: int
    teacherCost: float
    specialCosts: list[StageCostValue]


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    shareholders: list[Shareholder]
    operating: OperatingConfig
    planning: PlanningConfig
    stageCostItems: list[StageCostItem]
    timelineTemplate: MonthlyPlanTemplate
    teamMembers: list[TeamMember]
    employees: list[Employee]
    months: list[MonthlyPlan]


class MemberMonthResult(BaseModel):
    memberId: str
    name: str
    employmentType: EmploymentType
    unitsPerEvent: float
    monthlyUnits: float
    grossSales: float
    commissionCost: float
    basePayCost: float
    travelCost: float
    companyNetContribution: float


class EmployeeMonthResult(BaseModel):
    employeeId: str
    name: str
    role: str
    basePayCost: float
    perEventCost: float
    totalCost: float


class MonthlyScenarioResult(BaseModel):
    monthId: str
    label: str
    monthIndex: int
    events: int
    salesMultiplier: float
    onlineSalesFactor: float
    onlineRevenue: float
    memberGrossSales: float
    totalUnitsPerEvent: float
    totalUnitsPerMonth: float
    grossSales: float
    commissionCost: float
    basePayCost: float
    memberTravelCost: float
    employeeBasePayCost: float
    employeeEventCost: float
    monthlyOperatingCost: float
    perEventOperatingCost: float
    rehearsalCost: float
    teacherCost: float
    specialProjectCost: float
    monthlyFixedCostTotal: float
    perEventCostTotal: float
    operatingCostTotal: float
    unitLinkedCostTotal: float
    totalCost: float
    monthlyProfit: float
    cumulativeProfit: float
    cumulativeCash: float
    hasPaidBack: bool
    members: list[MemberMonthResult]
    employees: list[EmployeeMonthResult]


class ScenarioResult(BaseModel):
    key: ScenarioKey
    label: str
    description: str
    totalInvestment: float
    totalEvents: int
    averageUnitsPerEvent: float
    totalUnitsPerMonth: float
    grossSales: float
    operatingCostTotal: float
    totalCost: float
    totalProfit: float
    netCashAfterInvestment: float
    roi: float
    takeRate: float
    paybackMonthIndex: int | None
    paybackMonthLabel: str | None
    months: list[MonthlyScenarioResult]


class ModelResult(BaseModel):
    scenarios: list[ScenarioResult]


class ForecastLineItem(BaseModel):
    scenarioKey: ScenarioKey
    monthIndex: int
    monthLabel: str
    subjectKey: str
    subjectName: str
    subjectType: SubjectType
    subjectGroup: str
    entityType: str | None = None
    entityId: str | None = None
    plannedAmount: float
