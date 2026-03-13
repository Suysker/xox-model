from __future__ import annotations

from sqlalchemy.orm import Session

from .core import utc_now
from .models import AuditLog


def record_audit(
    session: Session,
    *,
    action: str,
    status: str = "success",
    workspace_id: str | None = None,
    actor_id: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    meta: dict | None = None,
) -> AuditLog:
    audit = AuditLog(
        workspace_id=workspace_id,
        actor_id=actor_id,
        action=action,
        status=status,
        entity_type=entity_type,
        entity_id=entity_id,
        meta_json=meta,
        created_at=utc_now(),
    )
    session.add(audit)
    return audit
