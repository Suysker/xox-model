from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .domain_types import ModelConfig
from .facts import build_forecast_line_items
from .models import (
    ForecastLineItemFact,
    LedgerPeriod,
    User,
    Workspace,
    WorkspaceDraft,
    WorkspaceEvent,
    WorkspaceMember,
    WorkspaceVersion,
    WorkspaceVersionShare,
)
from .projection import project_model


def get_workspace_for_user(session: Session, user: User) -> Workspace:
    workspace = session.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
    )
    if workspace is None:
        raise LookupError("Workspace not found")
    return workspace


def get_workspace_draft(session: Session, workspace: Workspace) -> WorkspaceDraft:
    draft = session.get(WorkspaceDraft, workspace.id)
    if draft is None:
        raise LookupError("Draft not found")
    return draft


def serialize_draft(workspace: Workspace, draft: WorkspaceDraft) -> dict:
    config = ModelConfig.model_validate(draft.config_json)
    result = project_model(config)
    return {
        "workspaceId": workspace.id,
        "workspaceName": workspace.name,
        "revision": draft.revision,
        "config": config.model_dump(),
        "result": result.model_dump(),
        "lastAutosavedAt": draft.last_autosaved_at,
    }


def save_draft(
    session: Session,
    *,
    workspace: Workspace,
    actor: User,
    revision: int,
    workspace_name: str,
    config: ModelConfig,
    timestamp,
) -> WorkspaceDraft:
    draft = get_workspace_draft(session, workspace)
    if draft.revision != revision:
        raise ValueError("Draft revision conflict")
    result = project_model(config)
    workspace.name = workspace_name
    draft.revision += 1
    draft.config_json = config.model_dump()
    draft.result_json = result.model_dump()
    draft.last_autosaved_at = timestamp
    draft.updated_by = actor.id
    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=actor.id,
            event_type="draft_autosaved",
            meta_json={"revision": draft.revision},
        )
    )
    session.commit()
    session.refresh(draft)
    return draft


def _next_version_number(session: Session, workspace: Workspace) -> int:
    current = session.scalar(select(func.max(WorkspaceVersion.version_no)).where(WorkspaceVersion.workspace_id == workspace.id))
    return (current or 0) + 1


def list_versions(session: Session, workspace: Workspace) -> list[WorkspaceVersion]:
    return list(
        session.scalars(
            select(WorkspaceVersion)
            .where(WorkspaceVersion.workspace_id == workspace.id)
            .order_by(WorkspaceVersion.version_no.desc())
        ).all()
    )


def publish_version(
    session: Session,
    *,
    workspace: Workspace,
    actor: User,
    kind: str,
    name: str | None,
    note: str | None,
) -> WorkspaceVersion:
    draft = get_workspace_draft(session, workspace)
    config = ModelConfig.model_validate(draft.config_json)
    result = project_model(config)
    version_no = _next_version_number(session, workspace)
    version = WorkspaceVersion(
        workspace_id=workspace.id,
        version_no=version_no,
        name=name or f"{kind.title()} {version_no}",
        kind=kind,
        note=note,
        baseline_scenario="base",
        source_draft_revision=draft.revision,
        source_version_id=workspace.active_version_id,
        payload_json=config.model_dump(),
        result_json=result.model_dump(),
        created_by=actor.id,
    )
    session.add(version)
    session.flush()
    session.add_all(
        [
            ForecastLineItemFact(
                workspace_id=workspace.id,
                version_id=version.id,
                scenario_key=fact.scenarioKey,
                month_index=fact.monthIndex,
                month_label=fact.monthLabel,
                subject_key=fact.subjectKey,
                subject_name=fact.subjectName,
                subject_type=fact.subjectType,
                subject_group=fact.subjectGroup,
                entity_type=fact.entityType,
                entity_id=fact.entityId,
                planned_amount=fact.plannedAmount,
            )
            for fact in build_forecast_line_items(config)
        ]
    )
    if kind == "release":
        workspace.active_version_id = version.id
        base_months = next(item for item in result.scenarios if item.key == "base").months
        existing_periods = {
            period.month_index: period
            for period in session.scalars(select(LedgerPeriod).where(LedgerPeriod.workspace_id == workspace.id)).all()
        }
        for month in base_months:
            period = existing_periods.get(month.monthIndex)
            if period is None:
                session.add(
                    LedgerPeriod(
                        workspace_id=workspace.id,
                        baseline_version_id=version.id,
                        month_index=month.monthIndex,
                        month_label=month.label,
                        status="open",
                    )
                )
            elif period.baseline_version_id is None:
                period.baseline_version_id = version.id
                period.month_label = month.label
    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=actor.id,
            event_type=f"version_{kind}ed",
            meta_json={"versionId": version.id, "versionNo": version_no},
        )
    )
    session.commit()
    session.refresh(version)
    return version


def rollback_to_version(session: Session, *, workspace: Workspace, actor: User, version_id: str, timestamp) -> WorkspaceDraft:
    version = session.get(WorkspaceVersion, version_id)
    if version is None or version.workspace_id != workspace.id:
        raise LookupError("Version not found")
    draft = get_workspace_draft(session, workspace)
    draft.revision += 1
    draft.config_json = version.payload_json
    draft.result_json = version.result_json
    draft.last_autosaved_at = timestamp
    draft.updated_by = actor.id
    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=actor.id,
            event_type="draft_rolled_back",
            meta_json={"versionId": version.id, "revision": draft.revision},
        )
    )
    session.commit()
    session.refresh(draft)
    return draft


def delete_version(session: Session, *, workspace: Workspace, version_id: str) -> None:
    version = session.get(WorkspaceVersion, version_id)
    if version is None or version.workspace_id != workspace.id:
        raise LookupError("Version not found")
    if workspace.active_version_id == version.id:
        raise ValueError("Active release cannot be deleted")
    active_share = session.scalar(
        select(WorkspaceVersionShare).where(
            WorkspaceVersionShare.version_id == version.id,
            WorkspaceVersionShare.revoked_at.is_(None),
        )
    )
    if active_share is not None:
        raise ValueError("Version has an active share link")
    linked_period = session.scalar(select(LedgerPeriod).where(LedgerPeriod.baseline_version_id == version.id))
    if linked_period is not None:
        raise ValueError("Version is used by a ledger period")
    session.execute(delete(ForecastLineItemFact).where(ForecastLineItemFact.version_id == version.id))
    session.delete(version)
    session.commit()
