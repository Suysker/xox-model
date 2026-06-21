# M148 Data Query Manifest Constants

Status: Implemented

Date: 2026-06-21

## Goal

Remove duplicated hard-coded `data.query_workspace` scope and metric enums from the xox business tool handler. At the time this handler lived in `runtime-intent-handlers.ts`; after M156 it lives in `tool-executor.ts`.

The xox business tool handler should execute xox business reads. It should not carry a second provider-facing manifest for query scopes and metrics.

## What Changed

- `tool-catalog.ts` now exports the canonical `data_query_workspace` scope and metric constants:
  - `WORKSPACE_DATA_QUERY_SCOPE`
  - `WORKSPACE_DATA_QUERY_SCOPES`
  - `WORKSPACE_DATA_QUERY_METRIC`
  - `WORKSPACE_DATA_QUERY_METRICS`
  - metric groupings and type guards used by the runtime handler
- The `data_query_workspace` JSON schema now uses those exported constants for `scope.enum` and `metrics.items.enum`.
- `tool-executor.ts` consumes `isWorkspaceDataQueryScope()`, `isWorkspaceDataQueryMetric()`, `WORKSPACE_DATA_QUERY_SCOPE`, and metric group constants instead of duplicating string enum lists. This is the post-M156 location.
- Architecture tests guard against reintroducing `step.scope === '...'`, `metricSet.has('...')`, and `metrics.includes('...')` hard-coded enum checks in the handler.

## Boundary

xox still owns the business read implementation and Chinese product copy.

The enum catalog belongs to the xox tool manifest boundary because it is both:

- provider-facing tool schema;
- runtime input normalization contract.

Agentic OS should not learn xox-specific scopes such as `entity_summary` or `ledger_history`.

## Validation

Executed during this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Results:

- `build:api`: passed.
- `agent-architecture.test.ts`: 52 tests passed.
- `test:api`: 14 test files passed, 261 tests passed.
