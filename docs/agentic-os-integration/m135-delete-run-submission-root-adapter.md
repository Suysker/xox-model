# M135 Delete Run Submission Root Adapter

Status: Planned

Date: 2026-06-21

## Goal

Delete root `apps/api/src/agent/run-submission.ts`. The file is now a host submit adapter: it creates xox DB rows, writes the initial user message and queued event, chooses sync/background transport behavior, and returns xox response DTOs. That is product wiring, not an agent harness module, and it should not live as a root run-plane file.

## Module Division

| Responsibility | New xox path | Agentic OS owner |
| --- | --- | --- |
| xox submit DB row creation and response DTO mapping | `apps/api/src/agent/agentic-os/xox-run-submission-adapter.ts` | `@agentic-os/server` owns submitted-run fact projection through `xox-run-submission-view.ts` |
| route auth/body parsing | `apps/api/src/agent/routes.ts` | host route shell |
| sync run completion and background drain scheduling | `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts` after M137 | `@agentic-os/server` already owns scheduler primitives; later cuts should shrink the host-prefixed worker adapter |

## Dependency Graph

```text
routes.ts
  -> agentic-os/xox-run-submission-adapter.ts
      -> thread-store.ts
      -> run-worker.ts
      -> agentic-os/xox-run-event-store-adapter.ts
      -> agentic-os/xox-thread-signal-adapter.ts
      -> agentic-os/xox-run-submission-view.ts
```

## Reuse and Abstraction Plan

- Keep `submitAgentMessageRun()` and `failSubmittedAgentRun()` names to avoid changing route behavior.
- Do not leave a root compatibility re-export.
- Guard deleted `agent/run-submission.ts` in architecture tests.
- Continue to keep route parsing/auth in `routes.ts` and generic submitted-run projection in Agentic OS server via `xox-run-submission-view.ts`.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run check
git diff --check
```

Expected result:

- Deleted root file is guarded.
- API submit/background/sync run tests still pass.
- Full API suite remains green.

## Next Cut

After M137, `run-worker.ts` has also been deleted from the root agent directory and moved to `agentic-os/xox-run-worker-adapter.ts`. The remaining run-plane wiring is now explicitly host-prefixed; future cuts should move more durable worker/recovery behavior into `@agentic-os/server` ports rather than restoring root files.
