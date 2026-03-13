from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .core import utc_now


def new_uuid() -> str:
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(32), default="active")
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserCredential(Base, TimestampMixin):
    __tablename__ = "user_credentials"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    password_hash: Mapped[str] = mapped_column(Text())


class UserSession(Base, TimestampMixin):
    __tablename__ = "user_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_agent: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    active_version_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_versions.id"))


class WorkspaceMember(Base, TimestampMixin):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32), default="owner")


class WorkspaceDraft(Base, TimestampMixin):
    __tablename__ = "workspace_drafts"

    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    config_json: Mapped[dict] = mapped_column(JSON)
    result_json: Mapped[dict | None] = mapped_column(JSON)
    last_autosaved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))


class WorkspaceEvent(Base):
    __tablename__ = "workspace_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    meta_json: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class WorkspaceVersion(Base):
    __tablename__ = "workspace_versions"
    __table_args__ = (UniqueConstraint("workspace_id", "version_no", name="uq_workspace_version_no"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(180))
    kind: Mapped[str] = mapped_column(String(32), index=True)
    note: Mapped[str | None] = mapped_column(Text())
    baseline_scenario: Mapped[str] = mapped_column(String(16), default="base")
    source_draft_revision: Mapped[int] = mapped_column(Integer)
    source_version_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_versions.id"))
    payload_json: Mapped[dict] = mapped_column(JSON)
    result_json: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class WorkspaceVersionShare(Base, TimestampMixin):
    __tablename__ = "workspace_version_shares"
    __table_args__ = (UniqueConstraint("version_id", name="uq_workspace_version_share_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("workspace_versions.id", ondelete="CASCADE"), index=True)
    share_token: Mapped[str] = mapped_column(String(96), unique=True, index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ForecastMonthFact(Base):
    __tablename__ = "forecast_month_facts"
    __table_args__ = (
        UniqueConstraint("version_id", "scenario_key", "month_index", name="uq_forecast_month_fact"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("workspace_versions.id", ondelete="CASCADE"), index=True)
    scenario_key: Mapped[str] = mapped_column(String(16), index=True)
    month_index: Mapped[int] = mapped_column(Integer, index=True)
    month_label: Mapped[str] = mapped_column(String(32))
    planned_revenue: Mapped[float] = mapped_column(Float, default=0)
    planned_cost: Mapped[float] = mapped_column(Float, default=0)
    planned_profit: Mapped[float] = mapped_column(Float, default=0)


class ForecastLineItemFact(Base):
    __tablename__ = "forecast_line_item_facts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("workspace_versions.id", ondelete="CASCADE"), index=True)
    scenario_key: Mapped[str] = mapped_column(String(16), index=True)
    month_index: Mapped[int] = mapped_column(Integer, index=True)
    month_label: Mapped[str] = mapped_column(String(32))
    subject_key: Mapped[str] = mapped_column(String(255), index=True)
    subject_name: Mapped[str] = mapped_column(String(180))
    subject_type: Mapped[str] = mapped_column(String(32))
    subject_group: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(128))
    planned_amount: Mapped[float] = mapped_column(Float, default=0)


class LedgerPeriod(Base, TimestampMixin):
    __tablename__ = "ledger_periods"
    __table_args__ = (UniqueConstraint("workspace_id", "month_index", name="uq_workspace_month_index"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    baseline_version_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_versions.id"))
    month_index: Mapped[int] = mapped_column(Integer)
    month_label: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), default="open")


class ActualEntry(Base, TimestampMixin):
    __tablename__ = "actual_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    ledger_period_id: Mapped[str] = mapped_column(ForeignKey("ledger_periods.id", ondelete="CASCADE"), index=True)
    direction: Mapped[str] = mapped_column(String(16))
    amount: Mapped[float] = mapped_column(Float)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    counterparty: Mapped[str | None] = mapped_column(String(180))
    description: Mapped[str | None] = mapped_column(Text())
    related_entity_type: Mapped[str | None] = mapped_column(String(32), index=True)
    related_entity_id: Mapped[str | None] = mapped_column(String(128), index=True)
    related_entity_name: Mapped[str | None] = mapped_column(String(180))
    status: Mapped[str] = mapped_column(String(16), default="posted")
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ActualEntryAllocation(Base):
    __tablename__ = "actual_entry_allocations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    actual_entry_id: Mapped[str] = mapped_column(ForeignKey("actual_entries.id", ondelete="CASCADE"), index=True)
    subject_key: Mapped[str] = mapped_column(String(255), index=True)
    subject_name: Mapped[str] = mapped_column(String(180))
    subject_type: Mapped[str] = mapped_column(String(32))
    amount: Mapped[float] = mapped_column(Float)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    workspace_id: Mapped[str | None] = mapped_column(ForeignKey("workspaces.id", ondelete="SET NULL"), index=True)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    action: Mapped[str] = mapped_column(String(96), index=True)
    status: Mapped[str] = mapped_column(String(32), default="success", index=True)
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64), index=True)
    meta_json: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)
