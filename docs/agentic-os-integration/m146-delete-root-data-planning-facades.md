# M146 Delete Root Data and Planning Facades

Status: Implemented

Date: 2026-06-21

## Goal

Remove two more misleading root files from `apps/api/src/agent`:

- `apps/api/src/agent/data-agent.ts`
- `apps/api/src/agent/planning-context.ts`

Neither file owned a real Agentic OS harness primitive. They were xox peripheral details using agent-shaped names:

- `data-agent.ts` was a business read implementation for the `data.query_workspace` tool.
- `planning-context.ts` was a shared xox tool/action execution context type.

Keeping them as standalone root agent files made xox look like it still had a local agent framework.

## What Changed

- Deleted `data-agent.ts`.
- Folded `answerWorkspaceDataQuestion()` and workspace data query DTOs into `runtime-intent-handlers.ts`, the concrete xox tool handler registry.
- Renamed the exported query DTO from `DataAgentQueryStep` to `WorkspaceDataQueryStep`.
- Deleted `planning-context.ts`.
- Moved `PlannerContext` into `action-draft-builder.ts`, next to the xox action/read draft DTOs that consume it.
- Updated all imports to use the real boundary files.

## Boundary

This is an amputation of misleading root files, not a claim that xox is finished.

xox may still own:

- business data reads;
- business action draft builders;
- provider settings;
- memory store adapters;
- tool catalog and manifest metadata;
- localized product DTOs.

xox must not keep standalone files that imply it owns:

- a data sub-agent;
- a planner framework;
- a local agent context engine.

## Architecture Guard

`apps/api/tests/agent-architecture.test.ts` now asserts:

- `data-agent.ts` is absent;
- `planning-context.ts` is absent;
- workspace data query code lives in `runtime-intent-handlers.ts`;
- `PlannerContext` lives in `action-draft-builder.ts`;
- the deleted `data-agent.ts` import cannot return.

## Validation

Executed during this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
```

Results:

- `build:api`: passed.
- `agent-architecture.test.ts`: 52 tests passed.
- `test:api`: 14 test files passed, 261 tests passed.
