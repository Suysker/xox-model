# xox-model Project Plan

## 1. Project Positioning

`xox-model` is no longer just a frontend calculator. It is a versioned forecasting and actuals analysis platform with four core product loops:

1. `Forecast`: edit a mutable draft, autosave continuously, and publish immutable baseline versions.
2. `Bookkeeping`: post actual income and expense entries against forecast subjects by period.
3. `Variance`: compare posted actuals with the baseline release bound to each accounting period.
4. `Sharing`: expose a read-only public link for an immutable released version.

The design goal is not only to "add a backend", but to keep forecasting data, version data, and ledger data consistent over time.

## 2. Repository Structure

The repository should stay layered and deployable. Frontend, backend, docs, and infrastructure must not be flattened into the root.

```text
xox-model/
├─ apps/
│  ├─ web/              # React + Vite client
│  └─ api/              # FastAPI + SQLAlchemy service
├─ docs/                # Architecture, project plan, acceptance, operations
├─ infra/
│  └─ scripts/          # Deploy and utility scripts
├─ .agent/              # Planning and lessons for engineering workflow
├─ package.json         # Workspace-level frontend orchestration only
└─ README.md
```

Recommended long-term expansion paths:

- `apps/web/src/features/*` for domain-focused frontend modules.
- `apps/api/app/services/*` or `apps/api/app/modules/*` when backend module count grows.
- `apps/api/alembic/` when formal migrations are introduced.
- `tests/e2e/` only if browser automation becomes repo-owned instead of agent-run.

## 3. Runtime Architecture

### Frontend

- Stack: `React 19 + TypeScript + Vite`
- Responsibility:
  - authentication UI and session bootstrap
  - forecasting workbench
  - version workspace interactions
  - bookkeeping and variance screens
  - client-side autosave orchestration

### Backend

- Stack: `FastAPI + SQLAlchemy 2.0 + Pydantic`
- Current local profile: `SQLite`
- Production target: `PostgreSQL`
- Responsibility:
  - auth/session management
  - draft persistence with optimistic revision control
  - version publish / rollback
  - normalized forecast facts
  - ledger periods and entries
  - variance aggregation APIs

### Deployment Boundary

- `apps/web` is deployable as a static asset bundle.
- `apps/api` is deployable as an application service.
- Infra scripts belong under `infra/scripts`, not root.
- In production, frontend and backend should be independently releasable.

## 4. Domain Architecture

### 4.1 Identity Domain

- `users`
- `user_credentials`
- `user_sessions`
- `workspace_members`

Rules:

- `register`: create user, credential, default workspace, default draft, session cookie.
- `login`: create session cookie.
- `logout`: revoke current session only.
- `cancel account`: revoke all active sessions and deactivate the account.
- Workspace data access is always scoped through membership.

### 4.2 Workspace Domain

- `workspaces`
- `workspace_drafts`
- `workspace_events`

Rules:

- A workspace always has one mutable draft.
- The draft carries a `revision` for optimistic locking.
- Every autosave writes a workspace event.
- Frontend autosave must debounce, but snapshot/publish actions must flush pending draft changes first.

### 4.3 Version Domain

- `workspace_versions`
- `forecast_line_item_facts`
- `workspace_version_shares`

Rules:

- `snapshot`: immutable checkpoint for working rollback.
- `release`: immutable checkpoint used as bookkeeping/variance baseline.
- `share`: public read-only access to a released version only.
- `rollback`: copy a historical version back into the mutable draft.
- Historical versions are never edited in place.
- Version APIs must return the real version payload, not the current draft, otherwise export/import semantics break.
- Public share pages must read the frozen released result payload, not a live recomputation from the latest frontend code.

### 4.4 Ledger Domain

- `ledger_periods`
- `actual_entries`
- `actual_entry_allocations`

Rules:

- Ledger data is period-based, not workspace-global.
- Each period points to one baseline release.
- Actual entries post against normalized forecast subjects.
- A single actual entry may be allocated across multiple subjects.
- Allocation totals must equal the original entry amount.

### 4.5 Variance Domain

- Derived from `forecast_line_item_facts + actual_entry_allocations + ledger_periods`

Rules:

- Planned values come from the period baseline release.
- Actual values come only from posted, non-voided ledger allocations.
- Variance must be stable even after future replanning.

## 5. Core Data Model

The current codebase implements a pragmatic subset of the target data architecture.

### Operational Tables

- `users(id, email, display_name, status, cancelled_at, created_at, updated_at)`
- `user_credentials(user_id, password_hash, created_at, updated_at)`
- `user_sessions(id, user_id, token_hash, expires_at, revoked_at, user_agent, ip_address)`
- `workspaces(id, owner_id, name, schema_version, active_version_id, created_at, updated_at)`
- `workspace_members(id, workspace_id, user_id, role, created_at, updated_at)`
- `workspace_drafts(workspace_id, revision, config_json, result_json, last_autosaved_at, updated_by)`
- `workspace_events(id, workspace_id, actor_id, event_type, meta_json, created_at)`

### Planning Tables

- `workspace_versions(id, workspace_id, version_no, name, kind, note, baseline_scenario, source_draft_revision, source_version_id, payload_json, result_json, created_by, created_at)`
- `workspace_version_shares(id, workspace_id, version_id, share_token, created_by, revoked_at, created_at, updated_at)`
- `forecast_line_item_facts(id, workspace_id, version_id, scenario_key, month_index, month_label, subject_key, subject_name, subject_type, subject_group, entity_type, entity_id, planned_amount)`

### Ledger Tables

- `ledger_periods(id, workspace_id, baseline_version_id, month_index, month_label, status, created_at, updated_at)`
- `actual_entries(id, workspace_id, ledger_period_id, direction, amount, occurred_at, counterparty, description, status, created_by, posted_at, created_at, updated_at)`
- `actual_entry_allocations(id, actual_entry_id, subject_key, subject_name, subject_type, amount)`

## 6. Forecast Subject Strategy

Forecast-to-actual mapping only works if forecast items are normalized into stable subject keys.

Examples:

- `revenue.offline_sales`
- `revenue.online_sales`
- `cost.member.commission`
- `cost.member.base_pay`
- `cost.employee.per_event`
- `cost.training.rehearsal`
- `cost.stage.perEvent.stage-cost-makeup`

This subject layer is the bridge between forecasting and bookkeeping. Without it, variance analysis becomes string matching and will fail after renames or refactors.

## 7. API Boundaries

### Auth

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `DELETE /api/v1/auth/me`

### Workspace

- `GET /api/v1/workspace/draft`
- `PATCH /api/v1/workspace/draft`
- `GET /api/v1/workspace/versions`
- `POST /api/v1/workspace/versions`
- `POST /api/v1/workspace/versions/{id}/share`
- `DELETE /api/v1/workspace/versions/{id}/share`
- `POST /api/v1/workspace/versions/{id}/rollback`
- `DELETE /api/v1/workspace/versions/{id}`

### Public Share

- `GET /api/v1/public/shares/{token}`

### Ledger

- `GET /api/v1/ledger/periods`
- `GET /api/v1/ledger/periods/{id}/subjects`
- `GET /api/v1/ledger/entries?periodId=...`
- `POST /api/v1/ledger/entries`
- `POST /api/v1/ledger/entries/{id}/void`

### Variance

- `GET /api/v1/variance/periods/{id}`

## 8. Delivery Roadmap

### Phase 1: Foundation

- repository split into `apps / docs / infra`
- Python backend bootstrapped
- auth and session persistence working
- default workspace and draft created at registration

### Phase 2: Forecast Persistence

- draft moved from browser-only storage to backend persistence
- autosave with revision conflict protection
- import/export still available as workspace bundle flow

### Phase 3: Version Management

- snapshot and release publishing
- immutable version storage
- rollback from historical versions
- forecast facts materialized on publish

### Phase 4: Ledger

- period generation from released forecast
- subject list generation per period
- entry posting, listing, and voiding

### Phase 5: Sharing

- release-only share link creation
- public read-only share page
- share revoke flow

### Phase 6: Variance

- plan vs actual summary by period
- line-level subject comparison
- browser-verified end-to-end acceptance

## 9. Acceptance Criteria

### Authentication

- user can register, login, and logout successfully
- refresh preserves session via cookie
- account cancellation deactivates the user and revokes access
- one user cannot read another user's workspace data

### Drafts and Autosave

- editing any forecast input writes back to the server automatically
- refresh restores the latest autosaved draft
- stale draft revisions are rejected by the API
- snapshot/publish actions include the latest unsaved local edits

### Versioning

- snapshot creates an immutable working checkpoint
- release creates an immutable baseline version
- only released versions can be shared publicly
- revoked share links stop resolving immediately
- rollback restores draft state from a historical version
- deleting a release in active use is rejected

### Ledger

- released versions create periods with baseline links
- users can post actual entries against forecast subjects
- voided entries no longer contribute to actual totals
- period totals equal the sum of posted allocations

### Variance

- planned totals match the selected baseline release facts
- actual totals match posted ledger entries
- subject-level variance lines reconcile to summary totals
- changing future draft assumptions does not mutate historical baseline comparisons

### Repository Quality

- frontend builds successfully
- frontend unit tests pass
- backend API tests pass
- browser smoke flow passes: register -> edit/autosave -> publish -> create share -> open public share -> edit draft -> verify shared release frozen -> revoke share

## 10. Current Status

Implemented in the current repository:

- Python backend introduced under `apps/api`
- modular repo structure introduced under `apps/`, `docs/`, `infra/`
- auth, workspace draft autosave, snapshot, release, rollback
- release sharing with public read-only page and revoke
- bookkeeping and variance UI/API
- browser-verified end-to-end flow for core acceptance path

Remaining medium-term improvements:

- formal Alembic migrations
- PostgreSQL production profile
- richer allocation UI for multi-subject entry splits
- period lock / close workflow
- audit views and export/reporting APIs
- accessibility cleanup for form metadata and labels
