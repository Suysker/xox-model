# xox-model Project Architecture

## Goal

Build a maintainable forecasting platform with:

- account registration, login, logout, and cancellation
- autosaved forecast drafts with publish and rollback
- read-only public sharing for immutable released versions
- bookkeeping against forecast income and cost subjects
- period-based variance analysis between forecast and actuals

See `docs/project-plan.md` for the detailed project blueprint, repo strategy, data model, roadmap, and acceptance criteria.

## Repository Structure

- `apps/web`: React application
- `apps/api`: Python FastAPI service
- `docs`: architecture, APIs, acceptance, and operating guides
- `infra/scripts`: deploy and utility scripts

Local development currently uses SQLite. Production should move to PostgreSQL without changing the service boundary.

## Data Architecture

### Transaction Layer

- `users`
- `user_credentials`
- `user_sessions`
- `workspaces`
- `workspace_members`
- `workspace_drafts`
- `workspace_events`
- `workspace_version_shares`
- `ledger_periods`
- `actual_entries`
- `actual_entry_allocations`

### Planning Layer

- `workspace_versions`
- `forecast_line_item_facts`

### Analytics Layer

- variance views grouped by period, month, subject, and version

## Modeling Rules

- Drafts are mutable.
- Published versions are immutable.
- Public share links can only target published releases.
- Rollback creates a new draft from a historical version.
- Each bookkeeping period points to a baseline published version.
- Actual entries can allocate to one or many forecast subjects.

## Delivery Phases

1. Repository restructure and Python backend skeleton.
2. Authentication and workspace draft persistence.
3. Version publish and rollback with normalized forecast facts.
4. Public release sharing with revoke flow.
5. Bookkeeping periods and actual entries.
6. Variance analysis and browser-tested acceptance.

## Acceptance Summary

- authenticated users can access only their own workspaces
- forecast edits autosave and survive refresh
- published versions remain immutable
- shared links expose released data without exposing draft editing
- rollback does not mutate history
- bookkeeping entries reconcile with their allocations
- variance totals match baseline forecast facts and posted actuals
