# M141 Move Active Memory Lifecycle Events into Agentic OS

Status: Implemented

Date: 2026-06-21

## Goal

Remove active-memory recall lifecycle callbacks from xox `context-pack.ts`.

After M140, xox no longer owned the active-memory runtime file, but it still implemented harness lifecycle details through:

- `onStarted`;
- `onSkipped`;
- `onCompleted`;
- `onInjected`.

That is still too much. xox should not know when the recall loop starts, completes, skips or injects context. Agentic OS should own that lifecycle and produce canonical event drafts.

Implemented in M141. `@agentic-os/core` now owns active-memory lifecycle event drafts. xox `context-pack.ts` only passes `appendRunEvent` and `recordRecalledMemories` adapters.

## Target Shape

```text
context-pack.ts
  -> createAgentActiveMemoryRecallRuntime({
       retrieve: xox memory DB adapter,
       recordRecalledMemories: xox memory store adapter,
       appendRunEvent: xox run-event sink
     })
  -> uses recall result in xox context DTO
```

No xox code should implement active-memory lifecycle event sequencing.

## Module Division

| Responsibility | xox after M141 | Agentic OS owner |
| --- | --- | --- |
| decide when recall lifecycle events fire | none | `@agentic-os/core` active-memory runtime |
| event type/status/payload for recall lifecycle | none | `@agentic-os/core` active-memory runtime |
| append event draft to xox SQL table | `appendRunEvent` sink adapter | host storage peripheral |
| mark selected memories recalled | `recordRecalledMemories` store adapter | host memory peripheral |
| retrieve candidate memories | `retrieve` DB adapter | host memory peripheral |
| consume recall result in context DTO | `context-pack.ts` | host product DTO |

## Guardrail

`apps/api/tests/agent-architecture.test.ts` should reject:

- `onStarted`;
- `onSkipped`;
- `onCompleted`;
- `onInjected`;
- handwritten `memory_recall_started`, `memory_recall_completed`, `memory_recall_skipped`, or `memory_injected` event construction inside `context-pack.ts`.

## Validation

```powershell
cd C:\Github\agentic-os
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api
git diff --check
```
