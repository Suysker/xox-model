from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .core import utc_now
from .domain_types import ModelConfig
from .models import Base, User
from .schemas import (
    CreateEntryRequest,
    DraftResponse,
    EntryResponse,
    LoginRequest,
    PeriodResponse,
    PublicShareResponse,
    PublishRequest,
    RegisterRequest,
    SubjectResponse,
    UpdateEntryRequest,
    UserResponse,
    VarianceSummaryResponse,
    VersionResponse,
    VersionShareResponse,
)
from .services_share import create_version_share, get_public_share_payload, list_active_shares, revoke_version_share, serialize_share
from .services_auth import (
    authenticate_user,
    cancel_account,
    create_session_cookie,
    create_user_with_workspace,
    refresh_current_session,
    require_current_user,
    revoke_current_session,
)
from .services_ledger import (
    create_actual_entry,
    list_entries,
    list_periods,
    list_subjects_for_period,
    restore_entry,
    set_period_status,
    update_actual_entry,
    variance_for_period,
    void_entry,
)
from .services_workspace import (
    delete_version,
    get_workspace_draft,
    get_workspace_for_user,
    list_versions,
    publish_version,
    rollback_to_version,
    save_draft,
    serialize_draft,
)


router = APIRouter(prefix="/api/v1")


def serialize_version(version, active_share=None) -> dict:
    return {
        "id": version.id,
        "name": version.name,
        "kind": version.kind,
        "versionNo": version.version_no,
        "sourceVersionId": version.source_version_id,
        "createdAt": version.created_at,
        "config": version.payload_json,
        "activeShare": serialize_share(active_share) if active_share is not None else None,
    }


def get_db(request: Request) -> Session:
    db_factory = request.app.state.db_factory
    with db_factory() as session:
        yield session


def current_user(request: Request, session: Session = Depends(get_db)) -> User:
    return require_current_user(session, request)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/auth/register", response_model=UserResponse)
def register(payload: RegisterRequest, request: Request, response: Response, session: Session = Depends(get_db)) -> dict:
    user = create_user_with_workspace(session, email=payload.email, display_name=payload.displayName, password=payload.password)
    create_session_cookie(session, response, user, request)
    return {"id": user.id, "email": user.email, "displayName": user.display_name, "status": user.status}


@router.post("/auth/login", response_model=UserResponse)
def login(payload: LoginRequest, request: Request, response: Response, session: Session = Depends(get_db)) -> dict:
    user = authenticate_user(session, email=payload.email, password=payload.password)
    create_session_cookie(session, response, user, request)
    return {"id": user.id, "email": user.email, "displayName": user.display_name, "status": user.status}


@router.get("/auth/me", response_model=UserResponse)
def me(request: Request, response: Response, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    refresh_current_session(session, request, response, user)
    return {"id": user.id, "email": user.email, "displayName": user.display_name, "status": user.status}


@router.post("/auth/logout")
def logout(request: Request, response: Response, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _ = user
    revoke_current_session(session, request, response)
    return {"ok": True}


@router.delete("/auth/me")
def deactivate_account(request: Request, response: Response, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    cancel_account(session, user)
    revoke_current_session(session, request, response)
    return {"ok": True}


@router.get("/workspace/draft", response_model=DraftResponse)
def get_draft(session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    draft = get_workspace_draft(session, workspace)
    return serialize_draft(workspace, draft)


@router.patch("/workspace/draft", response_model=DraftResponse)
def patch_draft(payload: dict, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        config = ModelConfig.model_validate(payload["config"])
        draft = save_draft(
            session,
            workspace=workspace,
            actor=user,
            revision=payload["revision"],
            workspace_name=payload["workspaceName"],
            config=config,
            timestamp=utc_now(),
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    return serialize_draft(workspace, draft)


@router.get("/workspace/versions", response_model=list[VersionResponse])
def versions(session: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    workspace = get_workspace_for_user(session, user)
    active_shares = list_active_shares(session, workspace)
    return [serialize_version(version, active_shares.get(version.id)) for version in list_versions(session, workspace)]


@router.post("/workspace/versions", response_model=VersionResponse)
def create_version(payload: PublishRequest, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    version = publish_version(session, workspace=workspace, actor=user, kind=payload.kind, name=payload.name, note=payload.note)
    return serialize_version(version)


@router.post("/workspace/versions/{version_id}/share", response_model=VersionShareResponse)
def share_version(version_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        share = create_version_share(session, workspace=workspace, actor=user, version_id=version_id, timestamp=utc_now())
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
    return serialize_share(share)


@router.delete("/workspace/versions/{version_id}/share")
def unshare_version(version_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        revoke_version_share(session, workspace=workspace, actor=user, version_id=version_id, timestamp=utc_now())
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    return {"ok": True}


@router.post("/workspace/versions/{version_id}/rollback", response_model=DraftResponse)
def rollback(version_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        draft = rollback_to_version(session, workspace=workspace, actor=user, version_id=version_id, timestamp=utc_now())
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    return serialize_draft(workspace, draft)


@router.delete("/workspace/versions/{version_id}")
def destroy_version(version_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        delete_version(session, workspace=workspace, version_id=version_id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    return {"ok": True}


@router.get("/ledger/periods", response_model=list[PeriodResponse])
def periods(session: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    workspace = get_workspace_for_user(session, user)
    return list_periods(session, workspace)


@router.get("/ledger/periods/{period_id}/subjects", response_model=list[SubjectResponse])
def subjects(period_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    workspace = get_workspace_for_user(session, user)
    try:
        return list_subjects_for_period(session, workspace, period_id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error


@router.get("/ledger/entries", response_model=list[EntryResponse])
def entries(periodId: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    workspace = get_workspace_for_user(session, user)
    try:
        return list_entries(session, workspace, periodId)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error


@router.post("/ledger/entries", response_model=EntryResponse)
def create_entry(payload: CreateEntryRequest, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        return create_actual_entry(
            session,
            workspace=workspace,
            actor_id=user.id,
            ledger_period_id=payload.ledgerPeriodId,
            direction=payload.direction,
            amount=payload.amount,
            occurred_at=payload.occurredAt,
            counterparty=payload.counterparty,
            description=payload.description,
            related_entity_type=payload.relatedEntityType,
            related_entity_id=payload.relatedEntityId,
            related_entity_name=payload.relatedEntityName,
            allocations=payload.allocations,
            timestamp=utc_now(),
        )
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error


@router.patch("/ledger/entries/{entry_id}", response_model=EntryResponse)
def update_entry(entry_id: str, payload: UpdateEntryRequest, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        return update_actual_entry(
            session,
            workspace=workspace,
            actor_id=user.id,
            entry_id=entry_id,
            amount=payload.amount,
            occurred_at=payload.occurredAt,
            counterparty=payload.counterparty,
            description=payload.description,
            related_entity_type=payload.relatedEntityType,
            related_entity_id=payload.relatedEntityId,
            related_entity_name=payload.relatedEntityName,
            allocations=payload.allocations,
            timestamp=utc_now(),
        )
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error


@router.post("/ledger/entries/{entry_id}/void")
def remove_entry(entry_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        void_entry(session, workspace, entry_id, actor_id=user.id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    return {"ok": True}


@router.post("/ledger/entries/{entry_id}/restore")
def restore_removed_entry(entry_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        restore_entry(session, workspace, entry_id, actor_id=user.id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    return {"ok": True}


@router.post("/ledger/periods/{period_id}/lock", response_model=PeriodResponse)
def lock_period(period_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        return set_period_status(session, workspace, period_id, actor_id=user.id, status_value="locked")
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error


@router.post("/ledger/periods/{period_id}/unlock", response_model=PeriodResponse)
def unlock_period(period_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        return set_period_status(session, workspace, period_id, actor_id=user.id, status_value="open")
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error


@router.get("/variance/periods/{period_id}", response_model=VarianceSummaryResponse)
def variance(period_id: str, session: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    workspace = get_workspace_for_user(session, user)
    try:
        return variance_for_period(session, workspace, period_id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error


@router.get("/public/shares/{share_token}", response_model=PublicShareResponse)
def public_share(share_token: str, session: Session = Depends(get_db)) -> dict:
    try:
        return get_public_share_payload(session, share_token)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
