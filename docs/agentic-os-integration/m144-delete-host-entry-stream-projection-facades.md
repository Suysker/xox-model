# M144 Delete Host Entry, Stream, and Projection Facades

Status: Implemented

Date: 2026-06-21

## Goal

Delete host files that survived only as thin Agentic OS wrappers.

This cut is intentionally not another rename. xox must not keep one-file "subsystems" whose only purpose is to call Agentic OS core/server helpers and pass data to the next xox adapter. Those facades make the downstream app look like it still owns a harness computer.

## Deleted Files

- `apps/api/src/agent/agentic-os/xox-turn-intake-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-direct-answer-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-clarification-resume-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-observation-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-thread-state-stream-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-thread-signal-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-run-submission-view.ts`
- `apps/api/src/agent/agentic-os/xox-agentic-os-facts.ts`

## Resulting Boundaries

| Removed facade | New owner |
| --- | --- |
| Turn intake adapter | `xox-run-worker-adapter.ts` holds only DB/model callback wiring around Agentic OS `resolveAgentTurnIntake()` |
| Direct answer adapter | `xox-run-worker-adapter.ts` holds only prompt/provider/storage callbacks around Agentic OS `runDirectAnswerLane()` |
| Clarification resume adapter | `xox-goal-store-adapter.ts` loads prior goal/evaluation/action rows and calls Agentic OS `buildClarificationResumeScaffold()` |
| Observation bridge adapter | `xox-tool-observation-adapter.ts` owns xox `AgentToolObservation` DTO projection and calls Agentic OS `createHostObservationBridge()` |
| Thread state stream adapter | `routes.ts` owns HTTP/SSE headers, heartbeat, close handling, and calls Agentic OS `openAgentServerSignalStateStream()` |
| Thread signal adapter | `xox-run-event-store-adapter.ts` owns xox reason names around Agentic OS `AgentServerSignalBus` |
| Submitted-run view | `xox-run-submission-adapter.ts` owns the single submitted-run response projection call site |
| Agentic OS facts facade | `xox-thread-state-view.ts` owns xox-to-Agentic-OS view fact mapping for product projection |

## Architecture Guard

`apps/api/tests/agent-architecture.test.ts` now asserts that all eight deleted files stay absent. The guard also checks that the surviving call sites still consume Agentic OS core/server helpers directly instead of recreating the deleted wrapper files.

## Validation

Executed during this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
```

Full-suite validation completed before committing this M144 cut:

```powershell
cd C:\Github\xox-model
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
git diff --check
```

Result:

- `build:api` passed.
- `agent-architecture.test.ts` passed: 51 tests.
- `test:api` passed: 14 files, 260 tests.
- `git diff --check` passed in both repos, with only Windows line-ending warnings.
