# M145 Delete Readiness and Runtime Planning Facades

Status: Implemented

Date: 2026-06-21

## Goal

Delete two remaining host-owned harness facade files before doing deeper Agentic OS extraction:

- `apps/api/src/agent/agentic-os/xox-loop-readiness-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts`

This cut is intentionally an amputation first. It does not claim that xox is fully clean. It removes misleading standalone "readiness" and "runtime planning" adapter files so the remaining host responsibilities are forced into concrete xox peripheral boundaries instead of surviving as separate harness-looking subsystems.

## Deleted Files

| Deleted file | Why it was deleted | Remaining xox owner |
| --- | --- | --- |
| `xox-loop-readiness-adapter.ts` | Looked like a host-owned loop readiness subsystem even though Agentic OS owns readiness priority through `decideAgentReadiness()` | `xox-goal-store-adapter.ts` now owns only xox goal row loading, domain finding generation, and goal/evaluation persistence |
| `xox-runtime-planning-adapter.ts` | Looked like a host-owned provider planning runner around Agentic OS runtime recovery | `xox-runtime-adapter.ts` now owns provider/runtime boundary wiring, xox host-profile context pack input, tool catalog callback, business high-volume budgets, localized run events, and legacy `RuntimePlanResult` projection |

## What This Does Not Claim

This is not the final state. The remaining large files still show more work:

- `xox-agentic-os-host-kit.ts` is still too much of the loop narrative.
- `xox-final-review-adapter.ts` still contains a large financial final-review/evidence policy surface.
- M149 has since deleted `xox-thread-timeline-adapter.ts` and `xox-thread-transcript-adapter.ts`; xox now keeps only thin legacy DTO projection in `xox-thread-state-view.ts`.
- `xox-tool-observation-adapter.ts` still owns a model-continuation helper that should move further into Agentic OS.

## Architecture Guard

`apps/api/tests/agent-architecture.test.ts` now asserts that both deleted files stay absent. It also checks:

- host kit imports `evaluateAgentGoal()` from the concrete goal store adapter, not from a readiness subsystem;
- runtime planning recovery and provider observation planning messages live at the runtime adapter boundary;
- old root files such as `loop-readiness-check.ts`, `observation-collector.ts`, and `runtime-planning-call.ts` remain deleted.

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
- `agent-architecture.test.ts`: 51 tests passed.
- `test:api`: 14 test files passed, 260 tests passed.
