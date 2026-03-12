# xox-model

Forecast planning, bookkeeping, and variance analysis for small operating teams.

## Repository Layout

- `apps/web`: React + Vite frontend.
- `apps/api`: FastAPI + SQLAlchemy backend.
- `docs`: architecture, delivery plan, and acceptance criteria.
- `infra/scripts`: deployment and utility scripts.

## Product Scope

- Authentication: register, login, logout, and account cancellation.
- Forecast modeling: editable draft, autosave, publish, version rollback, and public release sharing.
- Bookkeeping: record actual income and cost entries against forecast subjects.
- Variance analysis: compare actuals with the published baseline version by period and subject.
- Sharing: generate read-only public links for immutable released versions and revoke them when needed.

## Local Development

### Frontend

```bash
npm.cmd install
npm.cmd run dev:web
```

### Backend

```bash
python -m pip install -e ./apps/api
python -m uvicorn app.main:app --app-dir apps/api --reload
```

## Validation

```bash
npm.cmd run test:web
npm.cmd run build:web
python -m pytest apps/api/tests
```

## Documentation

- Architecture and delivery plan: `docs/project-architecture.md`
- Detailed project blueprint and acceptance criteria: `docs/project-plan.md`

## Notes

- The frontend package lives under `apps/web` so the repository can grow without flattening everything into the root.
- The backend is centered on mutable drafts, immutable published versions, period-based bookkeeping, and variance analysis against baseline versions.
- Public sharing is constrained to immutable releases so external links never drift with later draft edits.
