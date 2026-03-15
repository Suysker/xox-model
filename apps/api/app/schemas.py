from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from .domain_types import ModelConfig, ModelResult


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    displayName: str = Field(min_length=1, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserResponse(BaseModel):
    id: str
    email: EmailStr
    displayName: str
    status: str


class DraftResponse(BaseModel):
    workspaceId: str
    workspaceName: str
    revision: int
    config: ModelConfig
    result: ModelResult
    lastAutosavedAt: datetime | None


class PublishRequest(BaseModel):
    name: str | None = None
    note: str | None = None
    kind: Literal["snapshot", "release"] = "release"


class VersionShareResponse(BaseModel):
    id: str
    versionId: str
    shareToken: str
    sharePath: str
    createdAt: datetime
    updatedAt: datetime


class VersionResponse(BaseModel):
    id: str
    name: str
    kind: str
    versionNo: int
    sourceVersionId: str | None
    createdAt: datetime
    config: ModelConfig
    activeShare: VersionShareResponse | None = None


class PeriodResponse(BaseModel):
    id: str
    monthIndex: int
    monthLabel: str
    status: str
    baselineVersionId: str | None
    baselineVersionName: str | None
    plannedRevenue: float
    plannedCost: float
    actualRevenue: float
    actualCost: float


class SubjectResponse(BaseModel):
    subjectKey: str
    subjectName: str
    subjectType: str
    subjectGroup: str
    entityType: str | None = None
    entityId: str | None = None
    plannedAmount: float = 0


class AllocationInput(BaseModel):
    subjectKey: str
    subjectName: str
    subjectType: Literal["revenue", "cost"]
    amount: float


class CreateEntryRequest(BaseModel):
    ledgerPeriodId: str
    direction: Literal["income", "expense"]
    amount: float
    occurredAt: datetime | None = None
    counterparty: str | None = None
    description: str | None = None
    relatedEntityType: Literal["teamMember", "employee"] | None = None
    relatedEntityId: str | None = None
    relatedEntityName: str | None = None
    allocations: list[AllocationInput]


class EntryResponse(BaseModel):
    id: str
    ledgerPeriodId: str
    direction: str
    amount: float
    occurredAt: datetime
    postedAt: datetime | None = None
    counterparty: str | None
    description: str | None
    relatedEntityType: str | None = None
    relatedEntityId: str | None = None
    relatedEntityName: str | None = None
    sourceEntryId: str | None = None
    entryOrigin: str = "manual"
    derivedKind: str | None = None
    status: str
    allocations: list[AllocationInput]


class VarianceLineResponse(BaseModel):
    subjectKey: str
    subjectName: str
    subjectType: str
    plannedAmount: float
    actualAmount: float
    varianceAmount: float
    varianceRate: float | None


class VarianceSummaryResponse(BaseModel):
    periodId: str
    monthLabel: str
    baselineVersionId: str | None
    baselineVersionName: str | None
    lines: list[VarianceLineResponse]
    plannedRevenue: float
    plannedCost: float
    actualRevenue: float
    actualCost: float
    revenueVarianceAmount: float
    revenueVarianceRate: float | None
    costVarianceAmount: float
    costVarianceRate: float | None
    cumulativePlannedRevenue: float
    cumulativePlannedCost: float
    cumulativeActualRevenue: float
    cumulativeActualCost: float
    cumulativeRevenueVarianceAmount: float
    cumulativeRevenueVarianceRate: float | None
    cumulativeCostVarianceAmount: float
    cumulativeCostVarianceRate: float | None


class PublicShareResponse(BaseModel):
    shareId: str
    shareToken: str
    workspaceId: str
    workspaceName: str
    versionId: str
    versionName: str
    versionNo: int
    versionKind: str
    createdAt: datetime
    sharedAt: datetime
    config: ModelConfig
    result: ModelResult
