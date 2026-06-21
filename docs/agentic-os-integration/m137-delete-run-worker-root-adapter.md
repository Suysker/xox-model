# M137 Delete Run Worker Root Adapter

Status: Implemented

Date: 2026-06-21

## Goal

Delete root `apps/api/src/agent/run-worker.ts`.

After M134-M136, this is the main remaining root run-plane file. It no longer owns the canonical agent loop: turn intake, direct answer lane, complex goal loop, scheduler primitives, lease heartbeat, run events, thread signals, submission and thread state projection are already Agentic OS-owned or host-prefixed adapters.

The remaining code is xox host worker wiring:

- Kysely status/fail-closed writes;
- process bootstrap and queue polling;
- xox recoverable-row validation;
- localized run event copy;
- route-facing controller/cancel/recover exports.

That is still host adapter work, not a root agent framework. It should live under `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts`.

## Module Division

| Responsibility | New xox path | Agentic OS owner |
| --- | --- | --- |
| xox worker bootstrap and cancellation facade | `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts` | `@agentic-os/server` scheduler/active controller primitives |
| xox durable fail/cancel completion SQL | `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts` | future `@agentic-os/server` durable worker/recovery ports |
| turn intake and direct answer execution | existing host adapters under `agentic-os/` | `@agentic-os/core` turn intake and direct answer state machines |
| complex goal loop execution | `agentic-os/xox-agentic-os-host-kit.ts` | `@agentic-os/core` agent loop |

## Dependency Graph

```text
routes.ts
  -> agentic-os/xox-run-worker-adapter.ts

agentic-os/xox-run-submission-adapter.ts
  -> agentic-os/xox-run-worker-adapter.ts

agentic-os/xox-thread-state-stream-adapter.ts
  -> agentic-os/xox-run-worker-adapter.ts

api tests
  -> agentic-os/xox-run-worker-adapter.ts
```

## Reuse and Abstraction Plan

- Keep existing exported function names to preserve route/test behavior:
  - `completeAgentRun`
  - `createAgentRunController`
  - `cancelRunningAgentRun`
  - `recoverRunningAgentRuns`
  - `scheduleAgentRunQueueDrain`
  - `startAgentRunQueueWorker`
  - `safeRunErrorMessage`
- Do not leave a root compatibility re-export.
- Update architecture tests so `agent/run-worker.ts` cannot return.
- Do not move xox DB schema, localized copy, provider settings lookup, or business completion writes into Agentic OS in this slice.

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

- Root `apps/api/src/agent/run-worker.ts` is absent.
- No production source imports `./run-worker.js` or `../run-worker.js`.
- Route, background run, cancel, recovery, SSE and thread restore tests still pass.

## Next Cut

After M140, `approval-executor.ts`, `action-graph-store.ts`, `active-memory-recall.ts`, and `memory/active-memory-subagent.ts` are also deleted from the root agent directory or memory subtree. Remaining root `apps/api/src/agent` files are mostly business adapters, provider settings, memory persistence/Memory Center, action/evidence/domain projection and product transcript/timeline. The next high-value cuts should target large mixed root files where generic harness responsibilities still remain, especially `context-pack.ts` and transcript/timeline projection.

## Implementation Notes

- Moved `apps/api/src/agent/run-worker.ts` to `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts`.
- Updated routes, submission adapter, thread-state stream adapter and API tests to import the host-prefixed adapter.
- Added architecture guards so the deleted root file and old `./run-worker.js` / `../run-worker.js` imports cannot return.
