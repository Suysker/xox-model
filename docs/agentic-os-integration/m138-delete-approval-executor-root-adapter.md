# M138 Delete Approval Executor Root Adapter

Status: Implemented

## Implementation Notes

- Moved `apps/api/src/agent/approval-executor.ts` to `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts`.
- Updated routes, host kit, action graph adapter and business action draft builders to import the host-prefixed adapter.
- Added architecture guards so the deleted root file and old `./approval-executor.js` / `../approval-executor.js` imports cannot return.

Date: 2026-06-21

## Goal

Delete root `apps/api/src/agent/approval-executor.ts`.

Generic edit/confirm/reject/execute lifecycle belongs to Agentic OS action runtime. xox still owns business writes, DB row mapping, localized run events, memory candidate persistence and audit rows, but that is host action decision wiring. It should live under an explicit host adapter path:

```text
apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts
```

No root compatibility re-export should remain.

## Module Division

| Responsibility | New xox path | Agentic OS owner |
| --- | --- | --- |
| xox action confirm/cancel/edit route wiring | `agentic-os/xox-action-approval-adapter.ts` | `@agentic-os/core` `ActionRuntime` and future server action decision ports |
| xox business write execution and audit | `agentic-os/xox-action-approval-adapter.ts` calling `tool-executor.ts` | host business |
| xox action draft type consumed by business draft builders | `agentic-os/xox-action-approval-adapter.ts` export preserved for compatibility | future contracts/action port |
| continuation after action observation | `agentic-os/xox-action-approval-adapter.ts` callback into existing observation adapter | Agentic OS owns observation envelope and provider continuation helpers |

## Dependency Graph

```text
routes.ts
  -> agentic-os/xox-action-approval-adapter.ts

agentic-os/xox-action-graph-adapter.ts
  -> agentic-os/xox-action-approval-adapter.ts

agentic-os/xox-agentic-os-host-kit.ts
  -> agentic-os/xox-action-approval-adapter.ts

business action draft builders
  -> agentic-os/xox-action-approval-adapter.ts type AgentActionDraft
```

## Reuse and Abstraction Plan

- Keep exported names to preserve route/test behavior:
  - `AgentActionDraft`
  - `AgentPlanContext`
  - `addAgentActionRequest`
  - `executeAgentActionRequest`
  - `autoExecuteAgentActionRequest`
  - `confirmAgentActionRequest`
  - `cancelAgentActionRequest`
  - `updateAgentActionRequest`
- Do not move xox `tool-executor.ts`, business draft builders, memory policy, audit tables, DB schema or localized copy into Agentic OS in this slice.
- Add architecture guards so root `agent/approval-executor.ts` and old `./approval-executor.js` / `../approval-executor.js` imports cannot return.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts tests/action-observation.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run check
git diff --check
```

Expected result:

- Root `apps/api/src/agent/approval-executor.ts` is absent.
- Confirmation, cancel, edit, auto-execute, audit, memory-candidate and continuation tests still pass.
- No production source imports the old root approval executor path.
