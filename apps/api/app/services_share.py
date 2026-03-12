from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import User, Workspace, WorkspaceEvent, WorkspaceVersion, WorkspaceVersionShare


def issue_share_token() -> str:
    return secrets.token_urlsafe(32)


def serialize_share(share: WorkspaceVersionShare) -> dict:
    return {
        "id": share.id,
        "versionId": share.version_id,
        "shareToken": share.share_token,
        "sharePath": f"/shared/{share.share_token}",
        "createdAt": share.created_at,
        "updatedAt": share.updated_at,
    }


def list_active_shares(session: Session, workspace: Workspace) -> dict[str, WorkspaceVersionShare]:
    shares = session.scalars(
        select(WorkspaceVersionShare).where(
            WorkspaceVersionShare.workspace_id == workspace.id,
            WorkspaceVersionShare.revoked_at.is_(None),
        )
    ).all()
    return {share.version_id: share for share in shares}


def create_version_share(
    session: Session,
    *,
    workspace: Workspace,
    actor: User,
    version_id: str,
    timestamp,
) -> WorkspaceVersionShare:
    version = session.get(WorkspaceVersion, version_id)
    if version is None or version.workspace_id != workspace.id:
        raise LookupError("Version not found")
    if version.kind != "release":
        raise ValueError("Only release versions can be shared")

    share = session.scalar(select(WorkspaceVersionShare).where(WorkspaceVersionShare.version_id == version.id))
    if share is None:
        share = WorkspaceVersionShare(
            workspace_id=workspace.id,
            version_id=version.id,
            share_token=issue_share_token(),
            created_by=actor.id,
        )
        session.add(share)
        event_type = "version_shared"
    elif share.revoked_at is None:
        session.refresh(share)
        return share
    else:
        share.share_token = issue_share_token()
        share.revoked_at = None
        share.created_by = actor.id
        share.updated_at = timestamp
        event_type = "version_share_reissued"

    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=actor.id,
            event_type=event_type,
            meta_json={"versionId": version.id, "shareId": share.id},
        )
    )
    session.commit()
    session.refresh(share)
    return share


def revoke_version_share(
    session: Session,
    *,
    workspace: Workspace,
    actor: User,
    version_id: str,
    timestamp,
) -> WorkspaceVersionShare:
    version = session.get(WorkspaceVersion, version_id)
    if version is None or version.workspace_id != workspace.id:
        raise LookupError("Version not found")

    share = session.scalar(select(WorkspaceVersionShare).where(WorkspaceVersionShare.version_id == version.id))
    if share is None or share.revoked_at is not None:
        raise LookupError("Share link not found")

    share.revoked_at = timestamp
    share.updated_at = timestamp
    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=actor.id,
            event_type="version_share_revoked",
            meta_json={"versionId": version.id, "shareId": share.id},
        )
    )
    session.commit()
    session.refresh(share)
    return share


def get_public_share_payload(session: Session, share_token: str) -> dict:
    share = session.scalar(
        select(WorkspaceVersionShare).where(
            WorkspaceVersionShare.share_token == share_token,
            WorkspaceVersionShare.revoked_at.is_(None),
        )
    )
    if share is None:
        raise LookupError("Share link not found")

    version = session.get(WorkspaceVersion, share.version_id)
    workspace = session.get(Workspace, share.workspace_id)
    if version is None or workspace is None:
        raise LookupError("Share link not found")

    return {
        "shareId": share.id,
        "shareToken": share.share_token,
        "workspaceId": workspace.id,
        "workspaceName": workspace.name,
        "versionId": version.id,
        "versionName": version.name,
        "versionNo": version.version_no,
        "versionKind": version.kind,
        "createdAt": version.created_at,
        "sharedAt": share.created_at,
        "config": version.payload_json,
        "result": version.result_json,
    }
