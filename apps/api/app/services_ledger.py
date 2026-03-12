from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ActualEntry, ActualEntryAllocation, ForecastLineItemFact, LedgerPeriod, Workspace, WorkspaceVersion
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


def _period_summary(session: Session, period: LedgerPeriod) -> dict[str, float]:
    planned_revenue = 0.0
    planned_cost = 0.0
    actual_revenue = 0.0
    actual_cost = 0.0
    if period.baseline_version_id:
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
    entries = session.scalars(
        select(ActualEntry).where(ActualEntry.ledger_period_id == period.id, ActualEntry.status == "posted")
    ).all()
    for entry in entries:
        if entry.direction == "income":
            actual_revenue += entry.amount
        else:
            actual_cost += entry.amount
    return {
        "plannedRevenue": planned_revenue,
        "plannedCost": planned_cost,
        "actualRevenue": actual_revenue,
        "actualCost": actual_cost,
    }


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
    period = session.get(LedgerPeriod, period_id)
    if period is None or period.workspace_id != workspace.id or period.baseline_version_id is None:
        return []
    rows = session.scalars(
        select(ForecastLineItemFact).where(
            ForecastLineItemFact.version_id == period.baseline_version_id,
            ForecastLineItemFact.scenario_key == "base",
            ForecastLineItemFact.month_index == period.month_index,
        )
    ).all()
    seen: dict[str, dict] = {}
    for row in rows:
        seen[row.subject_key] = {
            "subjectKey": row.subject_key,
            "subjectName": row.subject_name,
            "subjectType": row.subject_type,
            "subjectGroup": row.subject_group,
        }
    return sorted(seen.values(), key=lambda item: (item["subjectType"], item["subjectGroup"], item["subjectName"]))


def list_entries(session: Session, workspace: Workspace, period_id: str) -> list[dict]:
    period = session.get(LedgerPeriod, period_id)
    if period is None or period.workspace_id != workspace.id:
        raise LookupError("Ledger period not found")
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
    period = session.get(LedgerPeriod, ledger_period_id)
    if period is None or period.workspace_id != workspace.id:
        raise LookupError("Ledger period not found")
    if period.status == "locked":
        raise ValueError("Ledger period is locked")
    if amount <= 0:
        raise ValueError("Amount must be positive")
    if round(sum(item.amount for item in allocations), 2) != round(amount, 2):
        raise ValueError("Allocations must equal the entry amount")
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
                subject_key=item.subjectKey,
                subject_name=item.subjectName,
                subject_type=item.subjectType,
                amount=item.amount,
            )
            for item in allocations
        ]
    )
    session.commit()
    return list_entries(session, workspace, period.id)[0]


def void_entry(session: Session, workspace: Workspace, entry_id: str) -> None:
    entry = session.get(ActualEntry, entry_id)
    if entry is None or entry.workspace_id != workspace.id:
        raise LookupError("Entry not found")
    period = session.get(LedgerPeriod, entry.ledger_period_id)
    if period and period.status == "locked":
        raise ValueError("Ledger period is locked")
    entry.status = "voided"
    session.commit()


def variance_for_period(session: Session, workspace: Workspace, period_id: str) -> dict:
    period = session.get(LedgerPeriod, period_id)
    if period is None or period.workspace_id != workspace.id:
        raise LookupError("Ledger period not found")
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
    baseline = versions.get(period.baseline_version_id or "")
    return {
        "periodId": period.id,
        "monthLabel": period.month_label,
        "baselineVersionId": period.baseline_version_id,
        "baselineVersionName": baseline.name if baseline else None,
        "lines": lines,
        **summary,
    }
