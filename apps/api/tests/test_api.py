from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import os
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select


def build_client(database_path: Path) -> TestClient:
    os.environ["XOX_DATABASE_URL"] = f"sqlite:///{database_path.as_posix()}"
    from app.core import get_settings

    get_settings.cache_clear()

    from app.main import create_app

    return TestClient(create_app())


def register_user(client: TestClient, *, email: str, display_name: str = "User") -> dict:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "password123", "displayName": display_name},
    )
    assert response.status_code == 200
    return response.json()


def login_user(client: TestClient, *, email: str) -> dict:
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "password123"},
    )
    assert response.status_code == 200
    return response.json()


def app_session(client: TestClient):
    return client.app.state.db_factory()


def resize_draft_horizon(config: dict, horizon_months: int) -> dict:
    from app.defaults import get_month_label

    next_config = deepcopy(config)
    source_months = next_config["months"]
    fallback_month = deepcopy(source_months[-1])
    next_months = []

    for month_index in range(horizon_months):
        month = deepcopy(source_months[month_index] if month_index < len(source_months) else fallback_month)
        month["id"] = f"month-test-{month_index + 1}"
        month["label"] = get_month_label(next_config["planning"]["startMonth"], month_index)
        next_months.append(month)

    next_config["planning"]["horizonMonths"] = horizon_months
    next_config["months"] = next_months
    return next_config


def test_run_migrations_is_repeatable(tmp_path: Path) -> None:
    database_path = tmp_path / "migrations.db"
    os.environ["XOX_DATABASE_URL"] = f"sqlite:///{database_path.as_posix()}"

    from app.core import get_settings
    from app.migrations import run_migrations

    get_settings.cache_clear()
    run_migrations()
    run_migrations()

    client = build_client(database_path)
    register = client.post(
        "/api/v1/auth/register",
        json={"email": "repeatable@example.com", "password": "password123", "displayName": "Repeatable"},
    )
    assert register.status_code == 200


def test_auth_session_lifecycle_and_audit(tmp_path: Path) -> None:
    client = build_client(tmp_path / "auth.db")

    register_user(client, email="owner@example.com", display_name="Owner")

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"
    assert "xox_session" in me.headers.get("set-cookie", "")

    logout = client.post("/api/v1/auth/logout")
    assert logout.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401

    login_user(client, email="owner@example.com")
    assert client.get("/api/v1/auth/me").status_code == 200

    cancel = client.delete("/api/v1/auth/me")
    assert cancel.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401

    invalid_login = client.post(
        "/api/v1/auth/login",
        json={"email": "owner@example.com", "password": "password123"},
    )
    assert invalid_login.status_code == 401

    with app_session(client) as session:
        from app.models import AuditLog, UserSession

        actions = set(session.scalars(select(AuditLog.action)).all())
        assert {"auth.register", "auth.login", "auth.logout", "auth.cancel_account", "auth.session_refreshed"} <= actions
        active_sessions = session.scalar(
            select(func.count()).select_from(UserSession).where(UserSession.revoked_at.is_(None))
        )
        assert active_sessions == 0


def test_draft_autosave_conflict_and_release_fact_tables(tmp_path: Path) -> None:
    client = build_client(tmp_path / "draft.db")
    register_user(client, email="planner@example.com", display_name="Planner")

    draft = client.get("/api/v1/workspace/draft")
    assert draft.status_code == 200
    payload = draft.json()

    payload["config"]["operating"]["offlineUnitPrice"] = 99
    save = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": payload["revision"], "workspaceName": "Updated Workspace", "config": payload["config"]},
    )
    assert save.status_code == 200
    assert save.json()["revision"] == payload["revision"] + 1

    stale_save = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": payload["revision"], "workspaceName": "Stale", "config": payload["config"]},
    )
    assert stale_save.status_code == 409
    assert stale_save.json()["detail"] == "Draft revision conflict"

    snapshot = client.post("/api/v1/workspace/versions", json={"kind": "snapshot", "name": "Draft Snapshot"})
    assert snapshot.status_code == 200
    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200
    assert snapshot.json()["versionNo"] == 1
    assert release.json()["versionNo"] == 2

    versions = client.get("/api/v1/workspace/versions")
    assert versions.status_code == 200
    assert [item["versionNo"] for item in versions.json()] == [2, 1]

    with app_session(client) as session:
        from app.models import AuditLog, ForecastLineItemFact, ForecastMonthFact

        release_id = release.json()["id"]
        month_fact_count = session.scalar(
            select(func.count()).select_from(ForecastMonthFact).where(ForecastMonthFact.version_id == release_id)
        )
        line_fact_count = session.scalar(
            select(func.count()).select_from(ForecastLineItemFact).where(ForecastLineItemFact.version_id == release_id)
        )
        assert month_fact_count and month_fact_count > 0
        assert line_fact_count and line_fact_count > 0
        draft_audits = session.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == "workspace.draft_autosave")
        )
        assert draft_audits and draft_audits >= 2


def test_ledger_is_available_from_current_draft_without_release(tmp_path: Path) -> None:
    client = build_client(tmp_path / "draft-ledger.db")
    register_user(client, email="draft-ledger@example.com", display_name="Finance")

    periods = client.get("/api/v1/ledger/periods")
    assert periods.status_code == 200
    period = periods.json()[0]
    assert period["plannedRevenue"] > 0

    subjects = client.get(f"/api/v1/ledger/periods/{period['id']}/subjects")
    assert subjects.status_code == 200
    subject_map = {item["subjectKey"]: item for item in subjects.json()}
    assert "revenue.offline_sales" in subject_map
    assert "cost.training.rehearsal" in subject_map
    assert subject_map["cost.other.refund"]["subjectName"] == "退费退款"
    assert subject_map["cost.other.refund"]["subjectType"] == "revenue"

    create_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "expense",
            "amount": 120,
            "allocations": [
                {
                    "subjectKey": "cost.training.rehearsal",
                    "subjectName": subject_map["cost.training.rehearsal"]["subjectName"],
                    "subjectType": subject_map["cost.training.rehearsal"]["subjectType"],
                    "amount": 120,
                }
            ],
        },
    )
    assert create_entry.status_code == 200

    refund_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "income",
            "amount": 50,
            "allocations": [
                {
                    "subjectKey": "cost.other.refund",
                    "subjectName": subject_map["cost.other.refund"]["subjectName"],
                    "subjectType": subject_map["cost.other.refund"]["subjectType"],
                    "amount": 50,
                }
            ],
        },
    )
    assert refund_entry.status_code == 200

    variance = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert variance.status_code == 200
    assert variance.json()["actualRevenue"] == 50
    assert variance.json()["actualCost"] == 120


def test_ledger_periods_follow_current_draft_horizon_when_shrinking(tmp_path: Path) -> None:
    client = build_client(tmp_path / "ledger-horizon.db")
    register_user(client, email="ledger-horizon@example.com", display_name="Finance")

    initial_draft = client.get("/api/v1/workspace/draft")
    assert initial_draft.status_code == 200
    initial_payload = initial_draft.json()

    expand_config = resize_draft_horizon(initial_payload["config"], 24)
    expanded = client.patch(
        "/api/v1/workspace/draft",
        json={
            "revision": initial_payload["revision"],
            "workspaceName": initial_payload["workspaceName"],
            "config": expand_config,
        },
    )
    assert expanded.status_code == 200

    expanded_periods = client.get("/api/v1/ledger/periods")
    assert expanded_periods.status_code == 200
    assert len(expanded_periods.json()) == 24
    assert expanded_periods.json()[-1]["monthIndex"] == 24

    shrink_config = resize_draft_horizon(expanded.json()["config"], 12)
    shrunk = client.patch(
        "/api/v1/workspace/draft",
        json={
            "revision": expanded.json()["revision"],
            "workspaceName": expanded.json()["workspaceName"],
            "config": shrink_config,
        },
    )
    assert shrunk.status_code == 200

    shrunk_periods = client.get("/api/v1/ledger/periods")
    assert shrunk_periods.status_code == 200
    assert len(shrunk_periods.json()) == 12
    assert [period["monthIndex"] for period in shrunk_periods.json()] == list(range(1, 13))


def test_rollback_resyncs_ledger_plan_to_current_draft(tmp_path: Path) -> None:
    client = build_client(tmp_path / "rollback-ledger.db")
    register_user(client, email="rollback-ledger@example.com", display_name="Planner")

    cost_item_id = "custom-rent"
    draft = client.get("/api/v1/workspace/draft").json()
    draft["config"]["operating"]["monthlyFixedCosts"].append({"id": cost_item_id, "name": "Studio Rent", "amount": 600})
    save_v1 = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": draft["revision"], "workspaceName": draft["workspaceName"], "config": draft["config"]},
    )
    assert save_v1.status_code == 200

    release_v1 = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release_v1.status_code == 200

    period_before = client.get("/api/v1/ledger/periods").json()[0]
    subjects_before = client.get(f"/api/v1/ledger/periods/{period_before['id']}/subjects").json()
    assert any(item["subjectKey"] == f"cost.operating.monthly.{cost_item_id}" for item in subjects_before)

    draft_v2 = client.get("/api/v1/workspace/draft").json()
    draft_v2["config"]["operating"]["monthlyFixedCosts"] = [
        item for item in draft_v2["config"]["operating"]["monthlyFixedCosts"] if item["id"] != cost_item_id
    ]
    save_v2 = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": draft_v2["revision"], "workspaceName": draft_v2["workspaceName"], "config": draft_v2["config"]},
    )
    assert save_v2.status_code == 200

    period_after_save = client.get("/api/v1/ledger/periods").json()[0]
    subjects_after_save = client.get(f"/api/v1/ledger/periods/{period_after_save['id']}/subjects").json()
    assert not any(item["subjectKey"] == f"cost.operating.monthly.{cost_item_id}" for item in subjects_after_save)
    assert period_after_save["plannedCost"] < period_before["plannedCost"]

    rolled_back = client.post(f"/api/v1/workspace/versions/{release_v1.json()['id']}/rollback")
    assert rolled_back.status_code == 200

    period_after_rollback = client.get("/api/v1/ledger/periods").json()[0]
    subjects_after_rollback = client.get(f"/api/v1/ledger/periods/{period_after_rollback['id']}/subjects").json()
    assert any(item["subjectKey"] == f"cost.operating.monthly.{cost_item_id}" for item in subjects_after_rollback)
    assert period_after_rollback["plannedCost"] == period_before["plannedCost"]


def test_release_rollback_and_share_lifecycle(tmp_path: Path) -> None:
    client = build_client(tmp_path / "rollback.db")
    register_user(client, email="share@example.com", display_name="Sharer")

    draft = client.get("/api/v1/workspace/draft").json()
    draft["config"]["operating"]["offlineUnitPrice"] = 88
    save = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": draft["revision"], "workspaceName": draft["workspaceName"], "config": draft["config"]},
    )
    assert save.status_code == 200

    release_v1 = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release_v1.status_code == 200

    refreshed = client.get("/api/v1/workspace/draft").json()
    refreshed["config"]["operating"]["offlineUnitPrice"] = 120
    save_v2 = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": refreshed["revision"], "workspaceName": refreshed["workspaceName"], "config": refreshed["config"]},
    )
    assert save_v2.status_code == 200

    release_v2 = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V2"})
    assert release_v2.status_code == 200

    rolled_back = client.post(f"/api/v1/workspace/versions/{release_v1.json()['id']}/rollback")
    assert rolled_back.status_code == 200
    assert rolled_back.json()["config"]["operating"]["offlineUnitPrice"] == 88

    version_list = client.get("/api/v1/workspace/versions")
    assert version_list.status_code == 200
    assert [item["versionNo"] for item in version_list.json()] == [2, 1]

    snapshot_share = client.post(f"/api/v1/workspace/versions/{release_v1.json()['id']}/share")
    assert snapshot_share.status_code == 200
    token = snapshot_share.json()["shareToken"]

    public_payload = client.get(f"/api/v1/public/shares/{token}")
    assert public_payload.status_code == 200
    assert public_payload.json()["config"]["operating"]["offlineUnitPrice"] == 88
    assert public_payload.json()["result"]["scenarios"][1]["label"] == "基准"

    revoke = client.delete(f"/api/v1/workspace/versions/{release_v1.json()['id']}/share")
    assert revoke.status_code == 200
    assert client.get(f"/api/v1/public/shares/{token}").status_code == 404

    reshared = client.post(f"/api/v1/workspace/versions/{release_v1.json()['id']}/share")
    assert reshared.status_code == 200
    assert reshared.json()["shareToken"] != token

    with app_session(client) as session:
        from app.models import AuditLog

        actions = set(session.scalars(select(AuditLog.action)).all())
        assert {"workspace.rollback", "version_shared", "version_share_revoked", "version_share_reissued"} <= actions


def test_cross_workspace_access_returns_403(tmp_path: Path) -> None:
    database_path = tmp_path / "access.db"
    owner_client = build_client(database_path)
    outsider_client = build_client(database_path)

    register_user(owner_client, email="owner@example.com", display_name="Owner")
    register_user(outsider_client, email="outsider@example.com", display_name="Outsider")

    release = owner_client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Owner Budget"})
    assert release.status_code == 200

    owner_period = owner_client.get("/api/v1/ledger/periods").json()[0]
    owner_version_id = release.json()["id"]

    forbidden_requests = [
        outsider_client.get(f"/api/v1/ledger/periods/{owner_period['id']}/subjects"),
        outsider_client.get(f"/api/v1/ledger/entries?periodId={owner_period['id']}"),
        outsider_client.get(f"/api/v1/variance/periods/{owner_period['id']}"),
        outsider_client.post(f"/api/v1/workspace/versions/{owner_version_id}/rollback"),
        outsider_client.delete(f"/api/v1/workspace/versions/{owner_version_id}"),
        outsider_client.post(f"/api/v1/workspace/versions/{owner_version_id}/share"),
    ]

    for response in forbidden_requests:
        assert response.status_code == 403


def test_member_income_uses_occurred_date_and_auto_derives_commission(tmp_path: Path) -> None:
    client = build_client(tmp_path / "member-income.db")
    register_user(client, email="member-income@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    period = client.get("/api/v1/ledger/periods").json()[0]
    subjects = client.get(f"/api/v1/ledger/periods/{period['id']}/subjects").json()
    subject_map = {item["subjectKey"]: item for item in subjects}
    occurred_at = "2026-03-05T10:00:00+00:00"

    income_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "income",
            "amount": 880,
            "occurredAt": occurred_at,
            "relatedEntityType": "teamMember",
            "relatedEntityId": "member-a",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 880,
                }
            ],
        },
    )
    assert income_entry.status_code == 200
    assert income_entry.json()["occurredAt"].startswith("2026-03-05T10:00:00")
    assert income_entry.json()["entryOrigin"] == "manual"

    entries = client.get(f"/api/v1/ledger/entries?periodId={period['id']}")
    assert entries.status_code == 200
    payload = entries.json()
    manual_entry = next(item for item in payload if item["id"] == income_entry.json()["id"])
    derived_entry = next(item for item in payload if item["sourceEntryId"] == manual_entry["id"])

    assert manual_entry["postedAt"] is not None
    assert derived_entry["entryOrigin"] == "derived"
    assert derived_entry["derivedKind"] == "member_commission"
    assert derived_entry["direction"] == "expense"
    assert derived_entry["amount"] == 308
    assert derived_entry["occurredAt"].startswith("2026-03-05T10:00:00")
    assert derived_entry["allocations"][0]["subjectKey"] == "cost.member.commission"

    variance = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert variance.status_code == 200
    variance_payload = variance.json()
    assert variance_payload["actualRevenue"] == 880
    assert variance_payload["actualCost"] == 308

    blocked_direct_void = client.post(f"/api/v1/ledger/entries/{derived_entry['id']}/void")
    assert blocked_direct_void.status_code == 409

    voided = client.post(f"/api/v1/ledger/entries/{manual_entry['id']}/void")
    assert voided.status_code == 200

    after_void = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert after_void.status_code == 200
    assert after_void.json()["actualRevenue"] == 0
    assert after_void.json()["actualCost"] == 0

    blocked_direct_restore = client.post(f"/api/v1/ledger/entries/{derived_entry['id']}/restore")
    assert blocked_direct_restore.status_code == 409

    restored = client.post(f"/api/v1/ledger/entries/{manual_entry['id']}/restore")
    assert restored.status_code == 200

    after_restore = client.get(f"/api/v1/ledger/entries?periodId={period['id']}")
    assert after_restore.status_code == 200
    restored_payload = after_restore.json()
    restored_manual = next(item for item in restored_payload if item["id"] == manual_entry["id"])
    restored_derived = next(item for item in restored_payload if item["id"] == derived_entry["id"])
    assert restored_manual["status"] == "posted"
    assert restored_derived["status"] == "posted"

    restored_variance = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert restored_variance.status_code == 200
    assert restored_variance.json()["actualRevenue"] == 880
    assert restored_variance.json()["actualCost"] == 308


def test_member_income_combines_offline_and_online_for_commission(tmp_path: Path) -> None:
    client = build_client(tmp_path / "member-income-combo.db")
    register_user(client, email="member-income-combo@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    period = client.get("/api/v1/ledger/periods").json()[0]
    subjects = client.get(f"/api/v1/ledger/periods/{period['id']}/subjects").json()
    subject_map = {item["subjectKey"]: item for item in subjects}

    income_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "income",
            "amount": 1000,
            "relatedEntityType": "teamMember",
            "relatedEntityId": "member-a",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 700,
                },
                {
                    "subjectKey": "revenue.online_sales",
                    "subjectName": subject_map["revenue.online_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 300,
                },
            ],
        },
    )
    assert income_entry.status_code == 200

    entries = client.get(f"/api/v1/ledger/entries?periodId={period['id']}")
    assert entries.status_code == 200
    payload = entries.json()
    manual_entry = next(item for item in payload if item["id"] == income_entry.json()["id"])
    derived_entry = next(item for item in payload if item["sourceEntryId"] == manual_entry["id"])

    assert len(manual_entry["allocations"]) == 2
    assert derived_entry["direction"] == "expense"
    assert derived_entry["amount"] == 350
    assert derived_entry["allocations"][0]["subjectKey"] == "cost.member.commission"


def test_manual_entry_can_be_updated_and_recomputes_member_commission(tmp_path: Path) -> None:
    client = build_client(tmp_path / "member-income-update.db")
    register_user(client, email="member-income-update@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    period = client.get("/api/v1/ledger/periods").json()[0]
    subjects = client.get(f"/api/v1/ledger/periods/{period['id']}/subjects").json()
    subject_map = {item["subjectKey"]: item for item in subjects}

    created = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "income",
            "amount": 880,
            "occurredAt": "2026-03-05T10:00:00+00:00",
            "relatedEntityType": "teamMember",
            "relatedEntityId": "member-a",
            "description": "初始收入",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 880,
                }
            ],
        },
    )
    assert created.status_code == 200

    updated = client.patch(
        f"/api/v1/ledger/entries/{created.json()['id']}",
        json={
            "amount": 1000,
            "occurredAt": "2026-03-06T12:00:00+00:00",
            "relatedEntityType": "teamMember",
            "relatedEntityId": "member-a",
            "description": "更新后收入",
            "counterparty": "Walk-in",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 700,
                },
                {
                    "subjectKey": "revenue.online_sales",
                    "subjectName": subject_map["revenue.online_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 300,
                },
            ],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["amount"] == 1000
    assert updated.json()["description"] == "更新后收入"
    assert updated.json()["counterparty"] == "Walk-in"
    assert updated.json()["occurredAt"].startswith("2026-03-06T12:00:00")
    assert len(updated.json()["allocations"]) == 2

    entries = client.get(f"/api/v1/ledger/entries?periodId={period['id']}")
    assert entries.status_code == 200
    payload = entries.json()
    manual_entry = next(item for item in payload if item["id"] == created.json()["id"])
    derived_entries = [item for item in payload if item["sourceEntryId"] == manual_entry["id"] and item["status"] == "posted"]

    assert len(derived_entries) == 1
    derived_entry = derived_entries[0]
    assert derived_entry["amount"] == 350
    assert derived_entry["occurredAt"].startswith("2026-03-06T12:00:00")
    assert derived_entry["allocations"][0]["subjectKey"] == "cost.member.commission"

    blocked_direct_update = client.patch(
        f"/api/v1/ledger/entries/{derived_entry['id']}",
        json={
            "amount": 350,
            "allocations": [
                {
                    "subjectKey": "cost.member.commission",
                    "subjectName": subject_map["cost.member.commission"]["subjectName"],
                    "subjectType": "cost",
                    "amount": 350,
                }
            ],
        },
    )
    assert blocked_direct_update.status_code == 409

    variance = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert variance.status_code == 200
    assert variance.json()["actualRevenue"] == 1000
    assert variance.json()["actualCost"] == 350


def test_entry_is_posted_into_the_period_matching_its_occurred_month(tmp_path: Path) -> None:
    client = build_client(tmp_path / "entry-period-sync.db")
    register_user(client, email="entry-period-sync@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    periods = client.get("/api/v1/ledger/periods")
    assert periods.status_code == 200
    march_period, april_period = periods.json()[:2]

    subjects = client.get(f"/api/v1/ledger/periods/{march_period['id']}/subjects")
    assert subjects.status_code == 200
    subject_map = {item["subjectKey"]: item for item in subjects.json()}

    created = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": march_period["id"],
            "direction": "income",
            "amount": 88,
            "occurredAt": "2026-04-05T12:00:00+00:00",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 88,
                }
            ],
        },
    )
    assert created.status_code == 200
    assert created.json()["ledgerPeriodId"] == april_period["id"]

    march_entries = client.get(f"/api/v1/ledger/entries?periodId={march_period['id']}")
    assert march_entries.status_code == 200
    assert created.json()["id"] not in {item["id"] for item in march_entries.json()}

    april_entries = client.get(f"/api/v1/ledger/entries?periodId={april_period['id']}")
    assert april_entries.status_code == 200
    april_entry = next(item for item in april_entries.json() if item["id"] == created.json()["id"])
    assert april_entry["occurredAt"].startswith("2026-04-05T12:00:00")


def test_listing_entries_realigns_dirty_period_assignment_to_occurred_month(tmp_path: Path) -> None:
    client = build_client(tmp_path / "entry-period-realign.db")
    register_user(client, email="entry-period-realign@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    periods = client.get("/api/v1/ledger/periods")
    assert periods.status_code == 200
    march_period, april_period = periods.json()[:2]

    subjects = client.get(f"/api/v1/ledger/periods/{march_period['id']}/subjects")
    assert subjects.status_code == 200
    subject_map = {item["subjectKey"]: item for item in subjects.json()}

    created = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": march_period["id"],
            "direction": "income",
            "amount": 88,
            "occurredAt": "2026-03-05T12:00:00+00:00",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 88,
                }
            ],
        },
    )
    assert created.status_code == 200
    assert created.json()["ledgerPeriodId"] == march_period["id"]

    with app_session(client) as session:
        from app.models import ActualEntry

        entry = session.get(ActualEntry, created.json()["id"])
        assert entry is not None
        entry.occurred_at = datetime.fromisoformat("2026-04-05T12:00:00+00:00")
        session.commit()

    march_entries = client.get(f"/api/v1/ledger/entries?periodId={march_period['id']}")
    assert march_entries.status_code == 200
    assert created.json()["id"] not in {item["id"] for item in march_entries.json()}

    april_entries = client.get(f"/api/v1/ledger/entries?periodId={april_period['id']}")
    assert april_entries.status_code == 200
    realigned_entry = next(item for item in april_entries.json() if item["id"] == created.json()["id"])
    assert realigned_entry["ledgerPeriodId"] == april_period["id"]
    assert realigned_entry["occurredAt"].startswith("2026-04-05T12:00:00")


def test_multi_allocation_locking_and_variance_reconciliation(tmp_path: Path) -> None:
    client = build_client(tmp_path / "ledger.db")
    register_user(client, email="finance@example.com", display_name="Finance")

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    periods = client.get("/api/v1/ledger/periods")
    assert periods.status_code == 200
    first_period, second_period = periods.json()[:2]

    subjects = client.get(f"/api/v1/ledger/periods/{first_period['id']}/subjects")
    assert subjects.status_code == 200
    subject_map = {item["subjectKey"]: item for item in subjects.json()}

    income_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": first_period["id"],
            "direction": "income",
            "amount": 1000,
            "counterparty": "Walk-in",
            "description": "Split income",
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 700,
                },
                {
                    "subjectKey": "revenue.online_sales",
                    "subjectName": subject_map["revenue.online_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 300,
                },
            ],
        },
    )
    assert income_entry.status_code == 200
    assert len(income_entry.json()["allocations"]) == 2

    mismatch = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": first_period["id"],
            "direction": "income",
            "amount": 100,
            "allocations": [
                {
                    "subjectKey": "cost.member.commission",
                    "subjectName": subject_map["cost.member.commission"]["subjectName"],
                    "subjectType": "cost",
                    "amount": 100,
                }
            ],
        },
    )
    assert mismatch.status_code == 422

    manual_commission = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": second_period["id"],
            "direction": "expense",
            "amount": 200,
            "allocations": [
                {
                    "subjectKey": "cost.member.commission",
                    "subjectName": subject_map["cost.member.commission"]["subjectName"],
                    "subjectType": "cost",
                    "amount": 200,
                }
            ],
        },
    )
    assert manual_commission.status_code == 422

    cost_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": second_period["id"],
            "direction": "expense",
            "amount": 450,
            "allocations": [
                {
                    "subjectKey": "cost.member.base_pay",
                    "subjectName": subject_map["cost.member.base_pay"]["subjectName"],
                    "subjectType": "cost",
                    "amount": 200,
                },
                {
                    "subjectKey": "cost.employee.base_pay",
                    "subjectName": subject_map["cost.employee.base_pay"]["subjectName"],
                    "subjectType": "cost",
                    "amount": 250,
                },
            ],
        },
    )
    assert cost_entry.status_code == 200

    first_variance = client.get(f"/api/v1/variance/periods/{first_period['id']}")
    assert first_variance.status_code == 200
    first_payload = first_variance.json()
    revenue_line_total = sum(line["actualAmount"] for line in first_payload["lines"] if line["subjectType"] == "revenue")
    cost_line_total = sum(line["actualAmount"] for line in first_payload["lines"] if line["subjectType"] == "cost")
    assert first_payload["actualRevenue"] == revenue_line_total
    assert first_payload["actualCost"] == cost_line_total
    assert first_payload["revenueVarianceAmount"] == first_payload["actualRevenue"] - first_payload["plannedRevenue"]

    second_variance = client.get(f"/api/v1/variance/periods/{second_period['id']}")
    assert second_variance.status_code == 200
    second_payload = second_variance.json()
    assert second_payload["cumulativeActualRevenue"] == first_payload["actualRevenue"] + second_payload["actualRevenue"]
    assert second_payload["cumulativeActualCost"] == first_payload["actualCost"] + second_payload["actualCost"]
    assert second_payload["cumulativeRevenueVarianceAmount"] == (
        second_payload["cumulativeActualRevenue"] - second_payload["cumulativePlannedRevenue"]
    )

    lock = client.post(f"/api/v1/ledger/periods/{first_period['id']}/lock")
    assert lock.status_code == 200
    assert lock.json()["status"] == "locked"

    blocked_create = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": first_period["id"],
            "direction": "income",
            "amount": 50,
            "allocations": [
                {
                    "subjectKey": "revenue.offline_sales",
                    "subjectName": subject_map["revenue.offline_sales"]["subjectName"],
                    "subjectType": "revenue",
                    "amount": 50,
                }
            ],
        },
    )
    assert blocked_create.status_code == 422

    blocked_void = client.post(f"/api/v1/ledger/entries/{income_entry.json()['id']}/void")
    assert blocked_void.status_code == 409

    unlock = client.post(f"/api/v1/ledger/periods/{first_period['id']}/unlock")
    assert unlock.status_code == 200
    assert unlock.json()["status"] == "open"

    voided = client.post(f"/api/v1/ledger/entries/{income_entry.json()['id']}/void")
    assert voided.status_code == 200

    after_void = client.get(f"/api/v1/variance/periods/{first_period['id']}")
    assert after_void.status_code == 200
    assert after_void.json()["actualRevenue"] == 0


def test_subject_mapping_survives_rename_and_delete(tmp_path: Path) -> None:
    client = build_client(tmp_path / "mapping.db")
    register_user(client, email="mapping@example.com", display_name="Mapping")

    draft = client.get("/api/v1/workspace/draft").json()
    cost_item_id = "custom-rent"
    draft["config"]["operating"]["monthlyFixedCosts"].append({"id": cost_item_id, "name": "Studio Rent", "amount": 600})
    save_v1 = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": draft["revision"], "workspaceName": draft["workspaceName"], "config": draft["config"]},
    )
    assert save_v1.status_code == 200

    release_v1 = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release_v1.status_code == 200

    period = client.get("/api/v1/ledger/periods").json()[0]
    subjects = client.get(f"/api/v1/ledger/periods/{period['id']}/subjects").json()
    target_subject = next(item for item in subjects if item["subjectKey"] == f"cost.operating.monthly.{cost_item_id}")
    assert target_subject["subjectName"] == "Studio Rent"

    create_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": period["id"],
            "direction": "expense",
            "amount": 600,
            "allocations": [
                {
                    "subjectKey": target_subject["subjectKey"],
                    "subjectName": target_subject["subjectName"],
                    "subjectType": target_subject["subjectType"],
                    "amount": 600,
                }
            ],
        },
    )
    assert create_entry.status_code == 200

    draft_v2 = client.get("/api/v1/workspace/draft").json()
    draft_v2["config"]["operating"]["monthlyFixedCosts"] = [
        item for item in draft_v2["config"]["operating"]["monthlyFixedCosts"] if item["id"] != cost_item_id
    ]
    save_v2 = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": draft_v2["revision"], "workspaceName": draft_v2["workspaceName"], "config": draft_v2["config"]},
    )
    assert save_v2.status_code == 200

    release_v2 = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V2"})
    assert release_v2.status_code == 200

    variance = client.get(f"/api/v1/variance/periods/{period['id']}")
    assert variance.status_code == 200
    historical_line = next(line for line in variance.json()["lines"] if line["subjectKey"] == target_subject["subjectKey"])
    assert historical_line["subjectName"] == "Studio Rent"
    assert historical_line["actualAmount"] == 600

    with app_session(client) as session:
        from app.models import ActualEntryAllocation, ForecastLineItemFact

        v1_name = session.scalar(
            select(ForecastLineItemFact.subject_name).where(
                ForecastLineItemFact.version_id == release_v1.json()["id"],
                ForecastLineItemFact.subject_key == target_subject["subjectKey"],
            )
        )
        v2_count = session.scalar(
            select(func.count()).select_from(ForecastLineItemFact).where(
                ForecastLineItemFact.version_id == release_v2.json()["id"],
                ForecastLineItemFact.subject_key == target_subject["subjectKey"],
            )
        )
        allocation_name = session.scalar(
            select(ActualEntryAllocation.subject_name).where(
                ActualEntryAllocation.actual_entry_id == create_entry.json()["id"],
                ActualEntryAllocation.subject_key == target_subject["subjectKey"],
            )
        )
        assert v1_name == "Studio Rent"
        assert v2_count == 0
        assert allocation_name == "Studio Rent"
