# M134 Delete Run-Plane Root Adapters

Status: Planned

Date: 2026-06-21

## Goal

Delete the remaining run-plane root adapter files that make `apps/api/src/agent` look like it still owns a harness runtime. xox should expose storage, transport, and product DTO adapters to Agentic OS, not keep root files named as generic run/event/thread/lease framework modules.

This slice removes these root paths:

- `apps/api/src/agent/thread-events.ts`
- `apps/api/src/agent/thread-state-stream.ts`
- `apps/api/src/agent/run-lease.ts`
- `apps/api/src/agent/run-events.ts`

The behavior remains in xox only where it is host-peripheral behavior: Kysely persistence, Node SSE response wiring, thread reason names, Chinese/product run-event copy, and xox contract DTO serialization.

## Reference Alignment

- `C:/Github/openclaw/src/acp/control-plane/session-actor-queue.ts` keeps per-session queueing in the control plane, not inside transport handlers.
- `C:/Github/openclaw/src/acp/control-plane/manager.turn-runner.ts` and `manager.turn-stream.ts` separate runtime turn execution/stream normalization from host delivery.
- `C:/Github/openai-agents-js/packages/agents-core/src/run.ts` keeps the outer loop, interruption handling, streaming loop, and next-step progression in the runner.
- `C:/Github/hermes-agent/acp_adapter/session.py` and `acp_adapter/server.py` keep session running state, queued prompts, cancellation, and stream callbacks around the loop rather than duplicating loop logic in each UI route.

The shared pattern is the same: the harness owns run/turn/session/event mechanics; host layers provide stores, session identity, transport, and product display.

## Module Division

| Responsibility | New xox adapter path | Agentic OS package owner |
| --- | --- | --- |
| Thread signal reason mapping | `apps/api/src/agent/agentic-os/xox-thread-signal-adapter.ts` | `@agentic-os/server` `AgentServerSignalBus` owns listener mechanics and sequencing |
| HTTP SSE stream wiring | `apps/api/src/agent/agentic-os/xox-thread-state-stream-adapter.ts` | `@agentic-os/server` `openAgentServerSignalStateStream()` owns signal-to-state lifecycle |
| Run lease SQL adapter | `apps/api/src/agent/agentic-os/xox-run-lease-store-adapter.ts` | `@agentic-os/server` owns lease lost error, expiry helper, assertion, heartbeat loop |
| Run event SQL/product copy adapter | `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts` | `@agentic-os/server` owns sequenced append and runtime stream event projection |

## Dependency Graph

```text
run-worker.ts
  -> agentic-os/xox-run-lease-store-adapter.ts
  -> agentic-os/xox-run-event-store-adapter.ts
  -> agentic-os/xox-thread-signal-adapter.ts

routes.ts
  -> agentic-os/xox-thread-signal-adapter.ts
  -> agentic-os/xox-thread-state-stream-adapter.ts

agentic-os/xox-thread-state-stream-adapter.ts
  -> thread-store.ts
  -> run-worker.ts safeRunErrorMessage
  -> @agentic-os/server openAgentServerSignalStateStream

agentic-os/xox-run-event-store-adapter.ts
  -> @agentic-os/server createAgentServerSequencedRunEventAppender
  -> @agentic-os/server addAgentServerRuntimeStreamRunEvent
  -> agentic-os/xox-thread-signal-adapter.ts
```

## Reuse and Abstraction Plan

- Do not add compatibility re-export files at the deleted root paths. That would preserve the false root harness boundary.
- Keep the existing public function names for now (`addRunEvent`, `claimAgentRunLease`, `openAgentThreadStateStream`) to minimize behavioral blast radius.
- Enforce the deletion with `apps/api/tests/agent-architecture.test.ts`.
- Do not move xox DB schema, auth, contract DTOs, or Chinese copy into Agentic OS. Those are host peripherals.

## Naming and Style

All moved files use the current xox Agentic OS adapter naming convention:

- `xox-<domain>-adapter.ts` for transport/signal adapters.
- `xox-<domain>-store-adapter.ts` for Kysely persistence adapters.

This follows M132/M133 naming and avoids another generic root framework name.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts tests/provider-runtime.test.ts tests/action-observation.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run check
git diff --check
```

Expected result:

- TypeScript build passes.
- Focused architecture/API/runtime tests pass.
- Full `test:api` passes with the same suite count as before.
- Agentic OS package checks pass.
- `git diff --check` reports no whitespace errors.

## Follow-Up Boundary

After this slice, the next high-value root deletions are:

- `run-worker.ts`: should become a small xox worker bootstrap once Agentic OS server owns more durable queue/recovery orchestration.
- `thread-store.ts`: should become a server store/projection adapter once generic thread state projection is fully package-owned.
- `run-submission.ts`: should become submit transport + xox DTO mapping only.
