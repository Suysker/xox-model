# M147 Delete Memory Root Facades

Status: Implemented

Date: 2026-06-21

## Goal

Delete misleading root memory harness files from `apps/api/src/agent` and collapse remaining xox memory responsibilities into one durable store boundary.

Deleted files:

- `memory-events.ts`
- `memory-retriever.ts`
- `memory-candidate-detector.ts`
- `memory-promotion-policy.ts`
- `memory-consolidator.ts`

## What Changed

- `memory.ts` is now the single xox durable memory store boundary for:
  - memory row writes and serialization;
  - memory event row writes;
  - governed memory candidate policy;
  - tenant-scoped retrieval and recall marking;
  - executed-action and confirmation-edit/cancel memory candidate generation;
  - memory candidate consolidation and long-context flush wiring.
- `context-pack.ts`, routes, Memory Center, memory tool backend, host kit, and tests now import memory store functions from `memory.ts`.
- Architecture tests assert the deleted memory root files stay absent.

## Boundary

This does not mean xox owns a generic memory harness.

Agentic OS still owns active recall runtime, lifecycle event drafts, prompt budget/citations/untrusted-memory rendering, and future generic memory OS APIs.

xox keeps only downstream peripherals:

- tenant/workspace/user SQL rows;
- Memory Center DTOs;
- xox business candidate text and evidence;
- recall-signal rows and daily-note storage;
- localized run-event copy through Agentic OS lifecycle drafts.

## Validation

Executed during this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
```

Results after memory deletion expansion:

- `build:api`: passed.
- `agent-architecture.test.ts`: 52 tests passed.
- `test:api`: 14 test files passed, 261 tests passed.
