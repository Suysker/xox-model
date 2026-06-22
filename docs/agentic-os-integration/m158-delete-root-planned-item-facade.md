# M158: Delete Root Planned Item Facade

Status: verified
Date: 2026-06-22

## Goal

Delete the root `apps/api/src/agent/action-draft-builder.ts` facade.

The file no longer belonged at the root agent layer. Its remaining work was xox product planned-item DTOs and provider-normalized tool-step to xox business draft/read mapping. That is HostProfile product wiring, not a local harness agent implementation.

This cut also removes the misleading `runtimeIntentHandlers` export name. The registry is now `xoxBusinessToolHandlers` in `tool-executor.ts`.

## Boundary

Agentic OS owns:

- agent loop state and turn progression;
- provider tool-call normalization and boundary failure observations;
- generic tool supervisor empty-result observations.

xox owns:

- product `AgentActionDraft` and `ReadDraft` DTO shapes;
- Chinese product copy and navigation hints;
- mapping provider-normalized tool steps to xox business tools;
- wrapping Agentic OS observations into legacy xox planned-item DTOs.

## Module Division

- `host-profile/xox-planned-items.ts`
  - owns `PlannerContext`, `AgentActionDraft`, `ReadDraft`, and xox planned-item helpers;
  - wraps Agentic OS core/runtime observation facts into xox product DTOs.
- `tool-executor.ts`
  - owns `xoxBusinessToolHandlers`, the xox business tool handler registry.
- `action-draft-builder.ts`
  - deleted and guarded from returning.

## Validation

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Expected:

- root `apps/api/src/agent/action-draft-builder.ts` is absent;
- no source imports `action-draft-builder`;
- no source uses the old `runtimeIntentHandlers` name;
- xox behavior remains unchanged.
