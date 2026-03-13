from __future__ import annotations

import hashlib
from datetime import timedelta

from fastapi import HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .audit import record_audit
from .core import get_settings, hash_password, issue_session_token, utc_now, verify_password
from .defaults import create_default_model
from .models import User, UserCredential, UserSession, Workspace, WorkspaceDraft, WorkspaceEvent, WorkspaceMember
from .projection import project_model


def _as_utc(value):
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=utc_now().tzinfo)
    return value


def get_user_by_email(session: Session, email: str) -> User | None:
    return session.scalar(select(User).where(User.email == email.lower()))


def create_user_with_workspace(session: Session, *, email: str, display_name: str, password: str) -> User:
    if get_user_by_email(session, email):
        record_audit(
            session,
            action="auth.register",
            status="failed",
            entity_type="user",
            meta={"email": email.lower(), "reason": "email_exists"},
        )
        session.commit()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")
    user = User(email=email.lower(), display_name=display_name, status="active")
    session.add(user)
    session.flush()
    session.add(UserCredential(user_id=user.id, password_hash=hash_password(password)))
    workspace = Workspace(owner_id=user.id, name="默认工作区", schema_version=1)
    session.add(workspace)
    session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    config = create_default_model()
    result = project_model(config)
    session.add(
        WorkspaceDraft(
            workspace_id=workspace.id,
            revision=1,
            config_json=config.model_dump(),
            result_json=result.model_dump(),
            last_autosaved_at=utc_now(),
            updated_by=user.id,
        )
    )
    session.add(
        WorkspaceEvent(
            workspace_id=workspace.id,
            actor_id=user.id,
            event_type="workspace_initialized",
            meta_json={"revision": 1},
        )
    )
    record_audit(
        session,
        action="auth.register",
        workspace_id=workspace.id,
        actor_id=user.id,
        entity_type="user",
        entity_id=user.id,
        meta={"email": user.email},
    )
    session.commit()
    session.refresh(user)
    return user


def authenticate_user(session: Session, *, email: str, password: str) -> User:
    user = get_user_by_email(session, email)
    if not user or user.status != "active":
        record_audit(
            session,
            action="auth.login",
            status="failed",
            entity_type="user",
            meta={"email": email.lower(), "reason": "invalid_credentials"},
        )
        session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    credential = session.get(UserCredential, user.id)
    if not credential or not verify_password(password, credential.password_hash):
        record_audit(
            session,
            action="auth.login",
            status="failed",
            workspace_id=None,
            actor_id=user.id,
            entity_type="user",
            entity_id=user.id,
            meta={"email": user.email, "reason": "invalid_credentials"},
        )
        session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return user


def create_session_cookie(session: Session, response: Response, user: User, request: Request) -> None:
    token, token_hash, expires_at = issue_session_token()
    session.add(
        UserSession(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=expires_at,
            user_agent=request.headers.get("user-agent"),
            ip_address=request.client.host if request.client else None,
        )
    )
    record_audit(
        session,
        action="auth.login",
        actor_id=user.id,
        entity_type="user",
        entity_id=user.id,
        meta={"email": user.email},
    )
    session.commit()
    response.set_cookie(
        key=get_settings().session_cookie_name,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        expires=int(expires_at.timestamp()),
        path="/",
    )


def refresh_current_session(session: Session, request: Request, response: Response, user: User) -> None:
    token = request.cookies.get(get_settings().session_cookie_name)
    if not token:
        return
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db_session = session.scalar(select(UserSession).where(UserSession.token_hash == token_hash))
    if db_session is None or db_session.revoked_at is not None:
        return
    db_session.expires_at = utc_now() + timedelta(days=get_settings().session_ttl_days)
    record_audit(
        session,
        action="auth.session_refreshed",
        actor_id=user.id,
        entity_type="session",
        entity_id=db_session.id,
        meta={"email": user.email},
    )
    session.commit()
    response.set_cookie(
        key=get_settings().session_cookie_name,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        expires=int(db_session.expires_at.timestamp()),
        path="/",
    )


def revoke_current_session(session: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(get_settings().session_cookie_name)
    if token:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        db_session = session.scalar(select(UserSession).where(UserSession.token_hash == token_hash))
        if db_session and db_session.revoked_at is None:
            db_session.revoked_at = utc_now()
            record_audit(
                session,
                action="auth.logout",
                actor_id=db_session.user_id,
                entity_type="session",
                entity_id=db_session.id,
            )
            session.commit()
    response.delete_cookie(get_settings().session_cookie_name, path="/")


def require_current_user(session: Session, request: Request) -> User:
    token = request.cookies.get(get_settings().session_cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db_session = session.scalar(select(UserSession).where(UserSession.token_hash == token_hash))
    expires_at = _as_utc(db_session.expires_at) if db_session else None
    revoked_at = _as_utc(db_session.revoked_at) if db_session else None
    if not db_session or revoked_at or (expires_at and expires_at < utc_now()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    user = session.get(User, db_session.user_id)
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


def cancel_account(session: Session, user: User) -> None:
    user.status = "cancelled"
    user.cancelled_at = utc_now()
    for db_session in session.scalars(select(UserSession).where(UserSession.user_id == user.id)).all():
        db_session.revoked_at = utc_now()
    record_audit(
        session,
        action="auth.cancel_account",
        actor_id=user.id,
        entity_type="user",
        entity_id=user.id,
        meta={"email": user.email},
    )
    session.commit()
