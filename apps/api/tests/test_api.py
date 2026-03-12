from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient


def build_client(tmp_path: Path) -> TestClient:
    os.environ["XOX_DATABASE_URL"] = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    from app.main import create_app

    app = create_app()
    return TestClient(app)


def test_auth_and_draft_roundtrip(tmp_path: Path) -> None:
    client = build_client(tmp_path)
    register = client.post(
        "/api/v1/auth/register",
        json={"email": "owner@example.com", "password": "password123", "displayName": "Owner"},
    )
    assert register.status_code == 200

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"

    draft = client.get("/api/v1/workspace/draft")
    assert draft.status_code == 200
    body = draft.json()
    assert body["revision"] == 1
    assert body["workspaceName"] == "Default Workspace"

    body["config"]["operating"]["offlineUnitPrice"] = 99
    save = client.patch(
        "/api/v1/workspace/draft",
        json={"revision": body["revision"], "workspaceName": "Updated Workspace", "config": body["config"]},
    )
    assert save.status_code == 200
    assert save.json()["workspaceName"] == "Updated Workspace"
    assert save.json()["revision"] == 2


def test_publish_bookkeeping_and_variance(tmp_path: Path) -> None:
    client = build_client(tmp_path)
    client.post(
        "/api/v1/auth/register",
        json={"email": "finance@example.com", "password": "password123", "displayName": "Finance"},
    )

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Budget V1"})
    assert release.status_code == 200

    periods = client.get("/api/v1/ledger/periods")
    assert periods.status_code == 200
    first_period = periods.json()[0]
    assert first_period["baselineVersionId"] == release.json()["id"]

    subjects = client.get(f"/api/v1/ledger/periods/{first_period['id']}/subjects")
    assert subjects.status_code == 200
    revenue_subject = next(item for item in subjects.json() if item["subjectKey"] == "revenue.offline_sales")

    create_entry = client.post(
        "/api/v1/ledger/entries",
        json={
            "ledgerPeriodId": first_period["id"],
            "direction": "income",
            "amount": 1000,
            "counterparty": "Test Customer",
            "description": "Walk-in sales",
            "allocations": [
                {
                    "subjectKey": revenue_subject["subjectKey"],
                    "subjectName": revenue_subject["subjectName"],
                    "subjectType": revenue_subject["subjectType"],
                    "amount": 1000,
                }
            ],
        },
    )
    assert create_entry.status_code == 200

    variance = client.get(f"/api/v1/variance/periods/{first_period['id']}")
    assert variance.status_code == 200
    assert variance.json()["actualRevenue"] == 1000
    assert variance.json()["plannedRevenue"] > 0


def test_release_share_lifecycle(tmp_path: Path) -> None:
    client = build_client(tmp_path)
    client.post(
        "/api/v1/auth/register",
        json={"email": "share@example.com", "password": "password123", "displayName": "Sharer"},
    )

    snapshot = client.post("/api/v1/workspace/versions", json={"kind": "snapshot", "name": "Draft Checkpoint"})
    assert snapshot.status_code == 200

    snapshot_share = client.post(f"/api/v1/workspace/versions/{snapshot.json()['id']}/share")
    assert snapshot_share.status_code == 422

    release = client.post("/api/v1/workspace/versions", json={"kind": "release", "name": "Board Budget"})
    assert release.status_code == 200

    share = client.post(f"/api/v1/workspace/versions/{release.json()['id']}/share")
    assert share.status_code == 200
    token = share.json()["shareToken"]

    version_list = client.get("/api/v1/workspace/versions")
    assert version_list.status_code == 200
    release_item = next(item for item in version_list.json() if item["id"] == release.json()["id"])
    assert release_item["activeShare"]["shareToken"] == token

    public_payload = client.get(f"/api/v1/public/shares/{token}")
    assert public_payload.status_code == 200
    assert public_payload.json()["versionId"] == release.json()["id"]
    assert public_payload.json()["versionName"] == "Board Budget"
    assert public_payload.json()["result"]["scenarios"][1]["key"] == "base"

    revoke = client.delete(f"/api/v1/workspace/versions/{release.json()['id']}/share")
    assert revoke.status_code == 200

    revoked_public = client.get(f"/api/v1/public/shares/{token}")
    assert revoked_public.status_code == 404

    reshared = client.post(f"/api/v1/workspace/versions/{release.json()['id']}/share")
    assert reshared.status_code == 200
    assert reshared.json()["shareToken"] != token
