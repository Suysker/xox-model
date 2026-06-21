# M136 Delete Thread Store Root Adapter

Status: Implemented

Date: 2026-06-21

## Goal

Delete root `apps/api/src/agent/thread-store.ts`.

The file no longer owns a generic harness store. It is a xox host adapter for:

- xox Kysely row loading;
- workspace/user authorization;
- legacy contract serialization;
- product `AgentThreadState` projection via `xox-thread-state-view.ts`.

That is host storage and display adapter work, not an agent harness framework file. It should live behind the same explicit host adapter boundary as the other run-plane adapters.

## Module Division

| Responsibility | New xox path | Agentic OS owner |
| --- | --- | --- |
| xox thread row loading and authorization | `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts` | future `@agentic-os/server` store ports |
| xox legacy DTO serialization | `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts` | `@agentic-os/server` owns fact projection helpers; xox owns contracts |
| server-owned thread state projection bridge | `apps/api/src/agent/agentic-os/xox-thread-state-view.ts` | `@agentic-os/server` `AgentServerThreadStateProjector` |

## Dependency Graph

```text
routes.ts
  -> agentic-os/xox-thread-store-adapter.ts

run-worker.ts
  -> agentic-os/xox-thread-store-adapter.ts

agentic-os/xox-run-submission-adapter.ts
  -> agentic-os/xox-thread-store-adapter.ts

agentic-os/xox-thread-state-stream-adapter.ts
  -> agentic-os/xox-thread-store-adapter.ts
```

## Reuse and Abstraction Plan

- Keep exported function names (`buildThreadState`, `addMessage`, `serializeAction`, etc.) to preserve behavior.
- Do not leave a root compatibility re-export.
- Guard deleted `agent/thread-store.ts` in architecture tests.
- Do not move `@xox/contracts`, Kysely row shapes, authorization, Chinese titles, or xox thread summaries into Agentic OS.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts tests/agent-transcript.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run check
git diff --check
```

Expected result:

- Deleted root file is guarded.
- Thread restore, SSE state, transcript, submitted-run, and route tests pass.
- Full API suite remains green.

## Implementation Notes

- Moved `apps/api/src/agent/thread-store.ts` to `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts`.
- Updated routes, worker, approval executor, direct-answer, host-kit, submission, and state-stream imports to the host-prefixed adapter path.
- Added architecture guards so the deleted root file and old `./thread-store.js` / `../thread-store.js` imports cannot return.

## Next Cut

After M137, root `run-worker.ts` is also deleted and moved to `agentic-os/xox-run-worker-adapter.ts`. Future cuts should add stronger Agentic OS server durable worker/store ports before deleting more behavior, but the root run-plane filename has already been removed.
