from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .audit import record_audit
from .models import (
    ActualEntry,
    ActualEntryAllocation,
    ForecastLineItemFact,
    ForecastMonthFact,
    LedgerPeriod,
    Workspace,
    WorkspaceVersion,
)
from .schemas import AllocationInput


def _versions_by_id(session: Session, workspace: Workspace) -> dict[str, WorkspaceVersion]:
    return {
        version.id: version
        for version in session.scalars(
            select(WorkspaceVersion)
            .where(WorkspaceVersion.workspace_id == workspace.id)
            .order_by(WorkspaceVersion.version_no.desc())
        ).all()
    }


def _get_period(session: Session, workspace: Workspace, period_id: str, *, require_baseline: bool = False) -> LedgerPeriod:
    period = session.get(LedgerPeriod, period_id)
    if period is None:
        raise LookupError("Ledger period not found")
    if period.workspace_id != workspace.id:
        raise PermissionError("Forbidden")
    if require_baseline and period.baseline_version_id is None:
        raise ValueError("Ledger period has no baseline version")
    return period


def _get_entry(session: Session, workspace: Workspace, entry_id: str) -> ActualEntry:
    entry = session.get(ActualEntry, entry_id)
    if entry is None:
        raise LookupError("Entry not found")
    if entry.workspace_id != workspace.id:
        raise PermissionError("Forbidden")
    return entry


def _subjects_for_period_by_key(session: Session, period: LedgerPeriod) -> dict[str, dict]:
    if period.baseline_version_id is None:
        return {}
    rows = session.scalars(
        select(ForecastLineItemFact).where(
            ForecastLineItemFact.version_id == period.baseline_version_id,
            ForecastLineItemFact.scenario_key == "base",
            ForecastLineItemFact.month_index == period.month_index,
        )
    ).all()
    subjects: dict[str, dict] = {}
    for row in rows:
        subjects[row.subject_key] = {
            "subjectKey": row.subject_key,
            "subjectName": row.subject_name,
            "subjectType": row.subject_type,
            "subjectGroup": row.subject_group,
        }
    return subjects


def _period_summary(session: Session, period: LedgerPeriod) -> dict[str, float]:
    planned_revenue = 0.0
    planned_cost = 0.0
    actual_revenue = 0.0
    actual_cost = 0.0
    if period.baseline_version_id:
        month_fact = session.scalar(
            select(ForecastMonthFact).where(
                ForecastMonthFact.version_id == period.baseline_version_id,
                ForecastMonthFact.scenario_key == "base",
                ForecastMonthFact.month_index == period.month_index,
            )
        )
        if month_fact is not None:
            planned_revenue = month_fact.planned_revenue
            planned_cost = month_fact.planned_cost
        else:
            facts = session.scalars(
                select(ForecastLineItemFact).where(
                    ForecastLineItemFact.version_id == period.baseline_version_id,
                    ForecastLineItemFact.scenario_key == "base",
                    ForecastLineItemFact.month_index == period.month_index,
                )
            ).all()
            for fact in facts:
                if fact.subject_type == "revenue":
                    planned_revenue += fact.planned_amount
                else:
                    planned_cost += fact.planned_amount
    allocation_rows = session.scalars(
        select(ActualEntryAllocation)
        .join(ActualEntry, ActualEntryAllocation.actual_entry_id == ActualEntry.id)
        .where(ActualEntry.ledger_period_id == period.id, ActualEntry.status == "posted")
    ).all()
    for row in allocation_rows:
        if row.subject_type == "revenue":
            actual_revenue += row.amount
        else:
            actual_cost += row.amount
    return {
        "plannedRevenue": planned_revenue,
        "plannedCost": planned_cost,
        "actualRevenue": actual_revenue,
        "actualCost": actual_cost,
    }


def _cumulative_summary(session: Session, workspace: Workspace, through_month_index: int) -> dict[str, float]:
    periods = session.scalars(
        select(LedgerPeriod)
        .where(LedgerPeriod.workspace_id == workspace.id, LedgerPeriod.month_index <= through_month_index)
        .order_by(LedgerPeriod.month_index.asc())
    ).all()
    totals = {
        "plannedRevenue": 0.0,
        "plannedCost": 0.0,
        "actualRevenue": 0.0,
        "actualCost": 0.0,
    }
    for period in periods:
        summary = _period_summary(session, period)
        for key, value in summary.items():
            totals[key] += value
    return totals


def list_periods(session: Session, workspace: Workspace) -> list[dict]:
    versions = _versions_by_id(session, workspace)
    periods = list(
        session.scalars(
            select(LedgerPeriod)
            .where(LedgerPeriod.workspace_id == workspace.id)
            .order_by(LedgerPeriod.month_index.asc())
        ).all()
    )
    return [
        {
            "id": period.id,
            "monthIndex": period.month_index,
            "monthLabel": period.month_label,
            "status": period.status,
            "baselineVersionId": period.baseline_version_id,
            "baselineVersionName": versions[period.baseline_version_id].name if period.baseline_version_id in versions else None,
            **_period_summary(session, period),
        }
        for period in periods
    ]


def list_subjects_for_period(session: Session, workspace: Workspace, period_id: str) -> list[dict]:
    period = _get_period(session, workspace, period_id)
    if period.baseline_version_id is None:
        return []
    return sorted(
        _subjects_for_period_by_key(session, period).values(),
        key=lambda item: (item["subjectType"], item["subjectGroup"], item["subjectName"]),
    )


def list_entries(session: Session, workspace: Workspace, period_id: str) -> list[dict]:
    period = _get_period(session, workspace, period_id)
    entries = session.scalars(
        select(ActualEntry).where(ActualEntry.ledger_period_id == period_id).order_by(ActualEntry.occurred_at.desc())
    ).all()
    serialized: list[dict] = []
    for entry in entries:
        allocations = list(
            session.scalars(select(ActualEntryAllocation).where(ActualEntryAllocation.actual_entry_id == entry.id)).all()
        )
        serialized.append(
            {
                "id": entry.id,
                "ledgerPeriodId": entry.ledger_period_id,
                "direction": entry.direction,
                "amount": entry.amount,
                "occurredAt": entry.occurred_at,
                "counterparty": entry.counterparty,
                "description": entry.description,
                "status": entry.status,
                "allocations": [
                    {
                        "subjectKey": allocation.subject_key,
                        "subjectName": allocation.subject_name,
                        "subjectType": allocation.subject_type,
                        "amount": allocation.amount,
                    }
                    for allocation in allocations
                ],
            }
        )
    return serialized


def create_actual_entry(
    session: Session,
    *,
    workspace: Workspace,
    actor_id: str,
    ledger_period_id: str,
    direction: str,
    amount: float,
    occurred_at: datetime,
    counterparty: str | None,
    description: str | None,
    allocations: list[AllocationInput],
    timestamp: datetime,
) -> dict:
    period = _get_period(session, workspace, ledger_period_id, require_baseline=True)
    if period.status == "locked":
        raise ValueError("Ledger period is locked")
    if amount <= 0:
        raise ValueError("Amount must be positive")
    if not allocations:
        raise ValueError("At least one allocation is required")
    if any(item.amount <= 0 for item in allocations):
        raise ValueError("Allocation amounts must be positive")
    if round(sum(item.amount for item in allocations), 2) != round(amount, 2):
        raise ValueError("Allocations must equal the entry amount")
    expected_subject_type = "revenue" if direction == "income" else "cost"
    available_subjects = _subjects_for_period_by_key(session, period)
    normalized_allocations: list[dict] = []
    totals_by_subject = defaultdict(float)
    for item in allocations:
        canonical_subject = available_subjects.get(item.subjectKey)
        if canonical_subject is None:
            raise ValueError(f"Unknown forecast subject: {item.subjectKey}")
        if canonical_subject["subjectType"] != expected_subject_type:
            raise ValueError("Entry direction does not match allocation subject type")
        totals_by_subject[item.subjectKey] += item.amount
    for subject_key, subject_amount in totals_by_subject.items():
        canonical_subject = available_subjects[subject_key]
        normalized_allocations.append(
            {
                "subjectKey": canonical_subject["subjectKey"],
                "subjectName": canonical_subject["subjectName"],
                "subjectType": canonical_subject["subjectType"],
                "amount": round(subject_amount, 2),
            }
        )
    entry = ActualEntry(
        workspace_id=workspace.id,
        ledger_period_id=period.id,
        direction=direction,
        amount=amount,
        occurred_at=occurred_at,
        counterparty=counterparty,
        description=description,
        status="posted",
        created_by=actor_id,
        posted_at=timestamp,
    )
    session.add(entry)
    session.flush()
    session.add_all(
        [
            ActualEntryAllocation(
                actual_entry_id=entry.id,
                subject_key=item["subjectKey"],
                subject_name=item["subjectName"],
                subject_type=item["subjectType"],
                amount=item["amount"],
            )
            for item in normalized_allocations
        ]
    )
    record_audit(
        session,
        action="ledger.entry_posted",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={"ledgerPeriodId": period.id, "direction": direction, "amount": amount},
    )
    session.commit()
    return list_entries(session, workspace, period.id)[0]


def void_entry(session: Session, workspace: Workspace, entry_id: str, *, actor_id: str) -> None:
    entry = _get_entry(session, workspace, entry_id)
    period = session.get(LedgerPeriod, entry.ledger_period_id)
    if period and period.status == "locked":
        raise ValueError("Ledger period is locked")
    entry.status = "voided"
    record_audit(
        session,
        action="ledger.entry_voided",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={"ledgerPeriodId": entry.ledger_period_id},
    )
    session.commit()


def set_period_status(session: Session, workspace: Workspace, period_id: str, *, actor_id: str, status_value: str) -> dict:
    period = _get_period(session, workspace, period_id)
    if status_value not in {"open", "locked"}:
        raise ValueError("Unsupported ledger period status")
    period.status = status_value
    record_audit(
        session,
        action=f"ledger.period_{status_value}",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="ledger_period",
        entity_id=period.id,
        meta={"monthIndex": period.month_index, "baselineVersionId": period.baseline_version_id},
    )
    session.commit()
    summary = _period_summary(session, period)
    version = session.get(WorkspaceVersion, period.baseline_version_id) if period.baseline_version_id else None
    return {
        "id": period.id,
        "monthIndex": period.month_index,
        "monthLabel": period.month_label,
        "status": period.status,
        "baselineVersionId": period.baseline_version_id,
        "baselineVersionName": version.name if version is not None else None,
        **summary,
    }


def variance_for_period(session: Session, workspace: Workspace, period_id: str) -> dict:
    period = _get_period(session, workspace, period_id)
    versions = _versions_by_id(session, workspace)
    planned = defaultdict(float)
    labels: dict[str, tuple[str, str]] = {}
    if period.baseline_version_id:
        rows = session.scalars(
            select(ForecastLineItemFact).where(
                ForecastLineItemFact.version_id == period.baseline_version_id,
                ForecastLineItemFact.scenario_key == "base",
                ForecastLineItemFact.month_index == period.month_index,
            )
        ).all()
        for row in rows:
            planned[row.subject_key] += row.planned_amount
            labels[row.subject_key] = (row.subject_name, row.subject_type)
    actual = defaultdict(float)
    allocation_rows = session.scalars(
        select(ActualEntryAllocation)
        .join(ActualEntry, ActualEntryAllocation.actual_entry_id == ActualEntry.id)
        .where(ActualEntry.ledger_period_id == period.id, ActualEntry.status == "posted")
    ).all()
    for row in allocation_rows:
        actual[row.subject_key] += row.amount
        labels.setdefault(row.subject_key, (row.subject_name, row.subject_type))

    lines: list[dict] = []
    for subject_key in sorted(set(planned) | set(actual)):
        planned_amount = planned.get(subject_key, 0.0)
        actual_amount = actual.get(subject_key, 0.0)
        variance_amount = actual_amount - planned_amount
        variance_rate = variance_amount / planned_amount if planned_amount else None
        subject_name, subject_type = labels[subject_key]
        lines.append(
            {
                "subjectKey": subject_key,
                "subjectName": subject_name,
                "subjectType": subject_type,
                "plannedAmount": planned_amount,
                "actualAmount": actual_amount,
                "varianceAmount": variance_amount,
                "varianceRate": variance_rate,
            }
        )

    summary = _period_summary(session, period)
    cumulative = _cumulative_summary(session, workspace, period.month_index)
    baseline = versions.get(period.baseline_version_id or "")
    return {
        "periodId": period.id,
        "monthLabel": period.month_label,
        "baselineVersionId": period.baseline_version_id,
        "baselineVersionName": baseline.name if baseline else None,
        "lines": lines,
        **summary,
        "revenueVarianceAmount": summary["actualRevenue"] - summary["plannedRevenue"],
        "revenueVarianceRate": (summary["actualRevenue"] - summary["plannedRevenue"]) / summary["plannedRevenue"]
        if summary["plannedRevenue"]
        else None,
        "costVarianceAmount": summary["actualCost"] - summary["plannedCost"],
        "costVarianceRate": (summary["actualCost"] - summary["plannedCost"]) / summary["plannedCost"]
        if summary["plannedCost"]
        else None,
        "cumulativePlannedRevenue": cumulative["plannedRevenue"],
        "cumulativePlannedCost": cumulative["plannedCost"],
        "cumulativeActualRevenue": cumulative["actualRevenue"],
        "cumulativeActualCost": cumulative["actualCost"],
        "cumulativeRevenueVarianceAmount": cumulative["actualRevenue"] - cumulative["plannedRevenue"],
        "cumulativeRevenueVarianceRate": (cumulative["actualRevenue"] - cumulative["plannedRevenue"])
        / cumulative["plannedRevenue"]
        if cumulative["plannedRevenue"]
        else None,
        "cumulativeCostVarianceAmount": cumulative["actualCost"] - cumulative["plannedCost"],
        "cumulativeCostVarianceRate": (cumulative["actualCost"] - cumulative["plannedCost"]) / cumulative["plannedCost"]
        if cumulative["plannedCost"]
        else None,
    }
