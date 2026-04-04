from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .audit import record_audit
from .domain_types import ModelConfig, ModelResult, TeamMember, clamp_non_negative
from .facts import build_forecast_line_items
from .models import ActualEntry, ActualEntryAllocation, LedgerPeriod, Workspace, WorkspaceDraft
from .projection import project_model
from .schemas import AllocationInput

BOOKKEEPING_SUBJECTS = (
    {
        "subjectKey": "cost.other.refund",
        "subjectName": "退费退款",
        "subjectType": "cost",
        "subjectGroup": "other",
        "entityType": None,
        "entityId": None,
        "plannedAmount": 0.0,
    },
)


def _get_workspace_draft(session: Session, workspace: Workspace) -> WorkspaceDraft:
    draft = session.get(WorkspaceDraft, workspace.id)
    if draft is None:
        raise LookupError("Draft not found")
    return draft


def _current_draft_context(session: Session, workspace: Workspace) -> tuple[ModelConfig, ModelResult]:
    draft = _get_workspace_draft(session, workspace)
    config = ModelConfig.model_validate(draft.config_json)
    result = ModelResult.model_validate(draft.result_json) if draft.result_json is not None else project_model(config)
    return config, result


def _base_months(result: ModelResult):
    scenario = next((item for item in result.scenarios if item.key == "base"), None) or (result.scenarios[0] if result.scenarios else None)
    return scenario.months if scenario is not None else []


def sync_periods_with_current_draft(
    session: Session, workspace: Workspace, *, result: ModelResult | None = None
) -> list[LedgerPeriod]:
    if result is None:
        _, result = _current_draft_context(session, workspace)

    existing_periods = {
        period.month_index: period
        for period in session.scalars(select(LedgerPeriod).where(LedgerPeriod.workspace_id == workspace.id)).all()
    }

    for period in existing_periods.values():
        if period.baseline_version_id is not None:
            period.baseline_version_id = None

    for month in _base_months(result):
        period = existing_periods.get(month.monthIndex)
        if period is None:
            period = LedgerPeriod(
                workspace_id=workspace.id,
                baseline_version_id=None,
                month_index=month.monthIndex,
                month_label=month.label,
                status="open",
            )
            session.add(period)
            existing_periods[month.monthIndex] = period
            continue

        period.month_label = month.label

    return sorted(existing_periods.values(), key=lambda item: item.month_index)


def _get_period(session: Session, workspace: Workspace, period_id: str) -> LedgerPeriod:
    period = session.get(LedgerPeriod, period_id)
    if period is None:
        raise LookupError("Ledger period not found")
    if period.workspace_id != workspace.id:
        raise PermissionError("Forbidden")
    return period


def _get_entry(session: Session, workspace: Workspace, entry_id: str) -> ActualEntry:
    entry = session.get(ActualEntry, entry_id)
    if entry is None:
        raise LookupError("Entry not found")
    if entry.workspace_id != workspace.id:
        raise PermissionError("Forbidden")
    return entry


def _subjects_for_period_by_key(session: Session, workspace: Workspace, period: LedgerPeriod) -> dict[str, dict]:
    config, _ = _current_draft_context(session, workspace)
    subjects: dict[str, dict] = {}
    for row in build_forecast_line_items(config):
        if row.scenarioKey != "base" or row.monthIndex != period.month_index:
            continue
        subject = subjects.setdefault(
            row.subjectKey,
            {
                "subjectKey": row.subjectKey,
                "subjectName": row.subjectName,
                "subjectType": row.subjectType,
                "subjectGroup": row.subjectGroup,
                "entityType": row.entityType,
                "entityId": row.entityId,
                "plannedAmount": 0.0,
            },
        )
        subject["plannedAmount"] += row.plannedAmount
    for subject in BOOKKEEPING_SUBJECTS:
        subjects.setdefault(subject["subjectKey"], dict(subject))
    return subjects


def _related_entity_catalog(config: ModelConfig) -> dict[str, dict[str, str]]:
    return {
        "teamMember": {member.id: member.name for member in config.teamMembers},
        "employee": {employee.id: employee.name for employee in config.employees},
    }


def _month_result_for_period(result: ModelResult, period: LedgerPeriod):
    return next((month for month in _base_months(result) if month.monthIndex == period.month_index), None)


def _serialize_entry(session: Session, entry: ActualEntry) -> dict:
    allocations = list(
        session.scalars(select(ActualEntryAllocation).where(ActualEntryAllocation.actual_entry_id == entry.id)).all()
    )
    return {
        "id": entry.id,
        "ledgerPeriodId": entry.ledger_period_id,
        "direction": entry.direction,
        "amount": entry.amount,
        "occurredAt": entry.occurred_at,
        "postedAt": entry.posted_at,
        "counterparty": entry.counterparty,
        "description": entry.description,
        "relatedEntityType": entry.related_entity_type,
        "relatedEntityId": entry.related_entity_id,
        "relatedEntityName": entry.related_entity_name,
        "sourceEntryId": entry.source_entry_id,
        "entryOrigin": entry.entry_origin,
        "derivedKind": entry.derived_kind,
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


def _member_for_config(config: ModelConfig, member_id: str) -> TeamMember | None:
    return next((member for member in config.teamMembers if member.id == member_id), None)


def _period_summary(session: Session, workspace: Workspace, period: LedgerPeriod, *, result: ModelResult | None = None) -> dict[str, float]:
    if result is None:
        _, result = _current_draft_context(session, workspace)

    month_result = _month_result_for_period(result, period)
    planned_revenue = month_result.grossSales if month_result is not None else 0.0
    planned_cost = month_result.totalCost if month_result is not None else 0.0
    actual_revenue = 0.0
    actual_cost = 0.0
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


def _cumulative_summary(
    session: Session, workspace: Workspace, through_month_index: int, *, result: ModelResult | None = None
) -> dict[str, float]:
    if result is None:
        _, result = _current_draft_context(session, workspace)

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
        summary = _period_summary(session, workspace, period, result=result)
        for key, value in summary.items():
            totals[key] += value
    return totals


def list_periods(session: Session, workspace: Workspace) -> list[dict]:
    _, result = _current_draft_context(session, workspace)
    periods = sync_periods_with_current_draft(session, workspace, result=result)
    session.commit()
    return [
        {
            "id": period.id,
            "monthIndex": period.month_index,
            "monthLabel": period.month_label,
            "status": period.status,
            "baselineVersionId": None,
            "baselineVersionName": None,
            **_period_summary(session, workspace, period, result=result),
        }
        for period in periods
    ]


def list_subjects_for_period(session: Session, workspace: Workspace, period_id: str) -> list[dict]:
    period = _get_period(session, workspace, period_id)
    return sorted(
        _subjects_for_period_by_key(session, workspace, period).values(),
        key=lambda item: (item["subjectType"], item["subjectGroup"], item["subjectName"]),
    )


def list_entries(session: Session, workspace: Workspace, period_id: str) -> list[dict]:
    period = _get_period(session, workspace, period_id)
    entries = session.scalars(
        select(ActualEntry)
        .where(ActualEntry.ledger_period_id == period_id)
        .order_by(ActualEntry.posted_at.desc(), ActualEntry.occurred_at.desc(), ActualEntry.created_at.desc())
    ).all()
    return [_serialize_entry(session, entry) for entry in entries]


def _normalize_entry_payload(
    session: Session,
    *,
    workspace: Workspace,
    period: LedgerPeriod,
    direction: str,
    amount: float,
    related_entity_type: str | None,
    related_entity_id: str | None,
    related_entity_name: str | None,
    allocations: list[AllocationInput],
) -> tuple[ModelConfig, dict[str, dict], list[dict], dict[str, float], str | None]:
    if amount <= 0:
        raise ValueError("Amount must be positive")
    if not allocations:
        raise ValueError("At least one allocation is required")
    if any(item.amount <= 0 for item in allocations):
        raise ValueError("Allocation amounts must be positive")
    if round(sum(item.amount for item in allocations), 2) != round(amount, 2):
        raise ValueError("Allocations must equal the entry amount")

    expected_subject_type = "revenue" if direction == "income" else "cost"
    config, _ = _current_draft_context(session, workspace)
    available_subjects = _subjects_for_period_by_key(session, workspace, period)
    entity_catalog = _related_entity_catalog(config)

    normalized_allocations: list[dict] = []
    totals_by_subject = defaultdict(float)
    for item in allocations:
        canonical_subject = available_subjects.get(item.subjectKey)
        if canonical_subject is None:
            raise ValueError(f"Unknown forecast subject: {item.subjectKey}")
        if canonical_subject["subjectType"] != expected_subject_type:
            raise ValueError("Entry direction does not match allocation subject type")
        if direction == "expense" and item.subjectKey == "cost.member.commission":
            raise ValueError("Member commission is derived automatically from posted member revenue")
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

    if any([related_entity_type, related_entity_id, related_entity_name]) and not all([related_entity_type, related_entity_id]):
        raise ValueError("Related entity selection is incomplete")

    canonical_related_name: str | None = None
    if related_entity_type and related_entity_id:
        entity_group = entity_catalog.get(related_entity_type)
        if entity_group is None:
            raise ValueError("Unsupported related entity type")
        canonical_related_name = entity_group.get(related_entity_id)
        if canonical_related_name is None:
            raise ValueError("Related entity not found in the current draft")

    return config, available_subjects, normalized_allocations, totals_by_subject, canonical_related_name


def _replace_entry_allocations(session: Session, entry_id: str, allocations: list[dict]) -> None:
    session.execute(delete(ActualEntryAllocation).where(ActualEntryAllocation.actual_entry_id == entry_id))
    session.add_all(
        [
            ActualEntryAllocation(
                actual_entry_id=entry_id,
                subject_key=item["subjectKey"],
                subject_name=item["subjectName"],
                subject_type=item["subjectType"],
                amount=item["amount"],
            )
            for item in allocations
        ]
    )


def _sync_derived_member_commission_entry(
    session: Session,
    *,
    workspace: Workspace,
    period: LedgerPeriod,
    actor_id: str,
    source_entry: ActualEntry,
    source_amount: float,
    related_entity_id: str | None,
    related_entity_name: str | None,
    available_subjects: dict[str, dict],
    timestamp: datetime,
) -> ActualEntry | None:
    existing_entries = session.scalars(
        select(ActualEntry).where(
            ActualEntry.source_entry_id == source_entry.id,
            ActualEntry.derived_kind == "member_commission",
        )
    ).all()
    entry = existing_entries[0] if existing_entries else None
    for extra_entry in existing_entries[1:]:
        extra_entry.status = "voided"

    if source_amount <= 0 or not related_entity_id or not related_entity_name:
        if entry is not None:
            entry.status = "voided"
        return None

    config, _ = _current_draft_context(session, workspace)
    member = _member_for_config(config, related_entity_id)
    if member is None:
        raise ValueError("Related entity not found in the current draft")

    commission_subject = available_subjects.get("cost.member.commission")
    if commission_subject is None:
        raise ValueError("Current draft does not expose member commission subject")

    commission_amount = round(source_amount * clamp_non_negative(member.commissionRate), 2)
    if commission_amount <= 0:
        if entry is not None:
            entry.status = "voided"
        return None

    is_new_entry = entry is None
    if entry is None:
        entry = ActualEntry(
            workspace_id=workspace.id,
            ledger_period_id=period.id,
            direction="expense",
            amount=commission_amount,
            occurred_at=source_entry.occurred_at,
            description=f"{related_entity_name} 提成自动计提",
            related_entity_type="teamMember",
            related_entity_id=related_entity_id,
            related_entity_name=related_entity_name,
            source_entry_id=source_entry.id,
            entry_origin="derived",
            derived_kind="member_commission",
            status="posted",
            created_by=actor_id,
            posted_at=timestamp,
        )
        session.add(entry)
        session.flush()
    else:
        entry.ledger_period_id = period.id
        entry.amount = commission_amount
        entry.occurred_at = source_entry.occurred_at
        entry.description = f"{related_entity_name} 提成自动计提"
        entry.related_entity_type = "teamMember"
        entry.related_entity_id = related_entity_id
        entry.related_entity_name = related_entity_name
        entry.status = "posted"
        entry.posted_at = entry.posted_at or timestamp

    _replace_entry_allocations(
        session,
        entry.id,
        [
            {
                "subjectKey": commission_subject["subjectKey"],
                "subjectName": commission_subject["subjectName"],
                "subjectType": commission_subject["subjectType"],
                "amount": commission_amount,
            }
        ],
    )

    if is_new_entry:
        record_audit(
            session,
            action="ledger.entry_auto_derived",
            workspace_id=workspace.id,
            actor_id=actor_id,
            entity_type="actual_entry",
            entity_id=entry.id,
            meta={
                "ledgerPeriodId": period.id,
                "sourceEntryId": source_entry.id,
                "derivedKind": "member_commission",
                "amount": commission_amount,
            },
        )
    return entry


def _member_income_total(totals_by_subject: dict[str, float]) -> float:
    return round(
        totals_by_subject.get("revenue.offline_sales", 0.0) + totals_by_subject.get("revenue.online_sales", 0.0),
        2,
    )


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
    related_entity_type: str | None,
    related_entity_id: str | None,
    related_entity_name: str | None,
    allocations: list[AllocationInput],
    timestamp: datetime,
) -> dict:
    period = _get_period(session, workspace, ledger_period_id)
    if period.status == "locked":
        raise ValueError("Ledger period is locked")
    _, available_subjects, normalized_allocations, totals_by_subject, canonical_related_name = _normalize_entry_payload(
        session,
        workspace=workspace,
        period=period,
        direction=direction,
        amount=amount,
        related_entity_type=related_entity_type,
        related_entity_id=related_entity_id,
        related_entity_name=related_entity_name,
        allocations=allocations,
    )

    entry = ActualEntry(
        workspace_id=workspace.id,
        ledger_period_id=period.id,
        direction=direction,
        amount=amount,
        occurred_at=occurred_at,
        counterparty=counterparty,
        description=description,
        related_entity_type=related_entity_type,
        related_entity_id=related_entity_id,
        related_entity_name=canonical_related_name or related_entity_name,
        source_entry_id=None,
        entry_origin="manual",
        derived_kind=None,
        status="posted",
        created_by=actor_id,
        posted_at=timestamp,
    )
    session.add(entry)
    session.flush()
    _replace_entry_allocations(session, entry.id, normalized_allocations)
    record_audit(
        session,
        action="ledger.entry_posted",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={
            "ledgerPeriodId": period.id,
            "direction": direction,
            "amount": amount,
            "relatedEntityType": related_entity_type,
            "relatedEntityId": related_entity_id,
        },
    )

    if direction == "income" and related_entity_type == "teamMember" and related_entity_id:
        _sync_derived_member_commission_entry(
            session,
            workspace=workspace,
            period=period,
            actor_id=actor_id,
            source_entry=entry,
            source_amount=_member_income_total(totals_by_subject),
            related_entity_id=related_entity_id,
            related_entity_name=canonical_related_name or related_entity_name,
            available_subjects=available_subjects,
            timestamp=timestamp,
        )

    session.commit()
    return _serialize_entry(session, entry)


def update_actual_entry(
    session: Session,
    *,
    workspace: Workspace,
    actor_id: str,
    entry_id: str,
    amount: float,
    occurred_at: datetime | None,
    counterparty: str | None,
    description: str | None,
    related_entity_type: str | None,
    related_entity_id: str | None,
    related_entity_name: str | None,
    allocations: list[AllocationInput],
    timestamp: datetime,
) -> dict:
    entry = _get_entry(session, workspace, entry_id)
    period = session.get(LedgerPeriod, entry.ledger_period_id)
    if period and period.status == "locked":
        raise ValueError("Ledger period is locked")
    if entry.entry_origin == "derived":
        raise ValueError("System-generated entry must be edited from its source entry")
    if entry.status == "voided":
        raise ValueError("Voided entry cannot be edited")

    _, available_subjects, normalized_allocations, totals_by_subject, canonical_related_name = _normalize_entry_payload(
        session,
        workspace=workspace,
        period=period,
        direction=entry.direction,
        amount=amount,
        related_entity_type=related_entity_type,
        related_entity_id=related_entity_id,
        related_entity_name=related_entity_name,
        allocations=allocations,
    )

    entry.amount = amount
    entry.occurred_at = occurred_at or entry.occurred_at
    entry.counterparty = counterparty
    entry.description = description
    entry.related_entity_type = related_entity_type
    entry.related_entity_id = related_entity_id
    entry.related_entity_name = canonical_related_name or related_entity_name
    _replace_entry_allocations(session, entry.id, normalized_allocations)

    if entry.direction == "income" and related_entity_type == "teamMember" and related_entity_id:
        _sync_derived_member_commission_entry(
            session,
            workspace=workspace,
            period=period,
            actor_id=actor_id,
            source_entry=entry,
            source_amount=_member_income_total(totals_by_subject),
            related_entity_id=related_entity_id,
            related_entity_name=canonical_related_name or related_entity_name,
            available_subjects=available_subjects,
            timestamp=timestamp,
        )
    else:
        _sync_derived_member_commission_entry(
            session,
            workspace=workspace,
            period=period,
            actor_id=actor_id,
            source_entry=entry,
            source_amount=0,
            related_entity_id=None,
            related_entity_name=None,
            available_subjects=available_subjects,
            timestamp=timestamp,
        )

    record_audit(
        session,
        action="ledger.entry_updated",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={
            "ledgerPeriodId": entry.ledger_period_id,
            "direction": entry.direction,
            "amount": amount,
            "relatedEntityType": related_entity_type,
            "relatedEntityId": related_entity_id,
        },
    )

    session.commit()
    return _serialize_entry(session, entry)


def void_entry(session: Session, workspace: Workspace, entry_id: str, *, actor_id: str) -> None:
    entry = _get_entry(session, workspace, entry_id)
    period = session.get(LedgerPeriod, entry.ledger_period_id)
    if period and period.status == "locked":
        raise ValueError("Ledger period is locked")
    if entry.entry_origin == "derived":
        raise ValueError("System-generated entry must be voided from its source entry")
    entry.status = "voided"
    derived_entries = session.scalars(
        select(ActualEntry).where(ActualEntry.source_entry_id == entry.id, ActualEntry.status == "posted")
    ).all()
    for derived_entry in derived_entries:
        derived_entry.status = "voided"
    record_audit(
        session,
        action="ledger.entry_voided",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={
            "ledgerPeriodId": entry.ledger_period_id,
            "derivedEntryIds": [derived_entry.id for derived_entry in derived_entries],
        },
    )
    session.commit()


def restore_entry(session: Session, workspace: Workspace, entry_id: str, *, actor_id: str) -> None:
    entry = _get_entry(session, workspace, entry_id)
    period = session.get(LedgerPeriod, entry.ledger_period_id)
    if period and period.status == "locked":
        raise ValueError("Ledger period is locked")
    if entry.entry_origin == "derived":
        raise ValueError("System-generated entry must be restored from its source entry")
    if entry.status != "voided":
        raise ValueError("Entry is not voided")

    entry.status = "posted"
    derived_entries = session.scalars(
        select(ActualEntry)
        .where(ActualEntry.source_entry_id == entry.id)
        .order_by(ActualEntry.created_at.desc())
    ).all()
    restored_derived_entry_ids: list[str] = []
    if derived_entries:
        primary_entry = derived_entries[0]
        primary_entry.status = "posted"
        primary_entry.ledger_period_id = entry.ledger_period_id
        primary_entry.occurred_at = entry.occurred_at
        primary_entry.posted_at = primary_entry.posted_at or entry.posted_at
        restored_derived_entry_ids.append(primary_entry.id)
        for extra_entry in derived_entries[1:]:
            extra_entry.status = "voided"

    record_audit(
        session,
        action="ledger.entry_restored",
        workspace_id=workspace.id,
        actor_id=actor_id,
        entity_type="actual_entry",
        entity_id=entry.id,
        meta={
            "ledgerPeriodId": entry.ledger_period_id,
            "derivedEntryIds": restored_derived_entry_ids,
        },
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
        meta={"monthIndex": period.month_index, "baselineSource": "draft"},
    )
    session.commit()
    _, result = _current_draft_context(session, workspace)
    summary = _period_summary(session, workspace, period, result=result)
    return {
        "id": period.id,
        "monthIndex": period.month_index,
        "monthLabel": period.month_label,
        "status": period.status,
        "baselineVersionId": None,
        "baselineVersionName": None,
        **summary,
    }


def variance_for_period(session: Session, workspace: Workspace, period_id: str) -> dict:
    period = _get_period(session, workspace, period_id)
    config, result = _current_draft_context(session, workspace)
    planned = defaultdict(float)
    labels: dict[str, tuple[str, str]] = {}
    for row in build_forecast_line_items(config):
        if row.scenarioKey != "base" or row.monthIndex != period.month_index:
            continue
        planned[row.subjectKey] += row.plannedAmount
        labels[row.subjectKey] = (row.subjectName, row.subjectType)
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

    summary = _period_summary(session, workspace, period, result=result)
    cumulative = _cumulative_summary(session, workspace, period.month_index, result=result)
    return {
        "periodId": period.id,
        "monthLabel": period.month_label,
        "baselineVersionId": None,
        "baselineVersionName": None,
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
