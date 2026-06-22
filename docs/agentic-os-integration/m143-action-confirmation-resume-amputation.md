# M143 Action Confirmation Resume Amputation

Status: Implemented

Date: 2026-06-21

## Goal

Delete the hidden xox-owned runner that still lives inside action confirmation.

After M143, confirming a pending xox action must not make xox evaluate the goal, rebuild evidence, run final review, plan obligations, or call the provider continuation path by itself. Confirmation is a host peripheral operation:

```text
HTTP route / xox adapter
  loads and authorizes the pending action
  asks Agentic OS ActionRuntime to confirm and execute it
  returns xox DTOs to the frontend

Agentic OS
  owns confirm -> action execution observation -> AgentRunEngine.resume()
  owns the post-observation loop, final review, repair obligations, and final answer decision
```

This directly addresses the architecture error that kept `xox-action-approval-adapter.ts` looking like a downstream harness runner.

## Reference Alignment

- `openai-agents-js` keeps the loop inside the Runner: model invocation, tool output append, interruption/resume, and final output are not rebuilt in the host app.
- Hermes' conversation loop appends tool results back into the same loop and only then decides whether to continue or finalize.
- OpenClaw's embedded runner treats tool-call results and incomplete turns as runner facts; the app surface does not hand-write a second continuation protocol.

The M143 target follows that shape: xox confirms a business action, but Agentic OS receives the resulting observation and resumes the loop.

## Current Problem

`apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` still owns these harness responsibilities:

- `executeAgentActionRequest()` and `autoExecuteAgentActionRequest()` live in an approval adapter instead of the business tool executor.
- `confirmAgentActionRequest()` calls `actionExecutionObservation()` and `continueModelAfterToolObservations()` directly.
- It runs `evaluateAgentGoal()`, `buildEvidenceLedger()`, `evaluateAssistantResponse()`, `loopObligationsFromResponseEvaluation()`, and `planLoopObligations()` after confirmation.
- It writes `goalEvaluated` and `responseEvaluated` lifecycle events from the route-side adapter.
- `xox-action-graph-adapter.ts` depends on the approval adapter for business execution and `AgentActionDraft`, creating a false dependency on a harness-shaped file.

That is not a host peripheral. It is a second runner.

## Target Module Division

| Responsibility | Owner after M143 |
| --- | --- |
| Business action row execution, domain write, audit row, plan-step status update | `apps/api/src/agent/tool-executor.ts` |
| Action draft DTO type and planned item helpers | `apps/api/src/agent/host-profile/xox-planned-items.ts` |
| Pending action HTTP confirm/cancel/edit response shape | `apps/api/src/agent/routes.ts` transport handlers |
| Confirm action guard, audit envelope, observation validation | `@agentic-os/core` `ActionRuntime` through `createAgentHostKit()` |
| Post-confirmation resume, provider turn, final review, obligation repair | `@agentic-os/core` `AgentRunEngine` through `createAgentHostKit().resume()` |
| xox row-to-Agentic-OS host wiring | `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts` |
| Auto-execute from materialized action graph | Agentic OS materializer + xox business executor callback |

## Dependency Graph

Target direction:

```text
routes.ts
  -> xox-agentic-os-host-kit.ts
  -> @agentic-os/core createAgentHostKit()
  -> Agentic OS ActionRuntime / AgentRunEngine

xox-agentic-os-host-kit.ts
  -> tool-executor.ts
  -> xox domain modules / audit / DB

xox-action-graph-adapter.ts
  -> host-profile/xox-planned-items.ts
  -> tool-executor.ts
```

Forbidden direction after M143:

```text
xox routes / adapters
  -> xox-loop-readiness-adapter
  -> xox-final-review-adapter
  -> host-profile/xox-goal-facts
  -> xox-tool-observation-adapter continuation
  -> addMessage for final assistant continuation
```

## Implementation Plan

1. Move `AgentActionDraft` out of the approval adapter and into the xox planned-item boundary. After M158 this is `host-profile/xox-planned-items.ts`.
2. Move `executeAgentActionRequest()` and `autoExecuteAgentActionRequest()` into `tool-executor.ts`, because they are business write/audit execution peripherals.
3. Add a host-kit helper that reconstructs the current run/action state, calls `kit.confirmAction()`, and resumes the same Agentic OS loop with the action execution observation.
4. Rewrite the confirm route helper so it only loads/authorizes the action, calls the host-kit confirmation/resume helper, updates thread freshness, and returns legacy DTOs.
5. Delete `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` instead of preserving a thin renamed approval facade.
6. Strengthen architecture guards so the deleted approval adapter cannot return and routes cannot import loop readiness, final review, runtime goal facts, or observation continuation.
7. Validate with the full API suite because this cut intentionally removes a route-side runner.

## Implementation Result

- `AgentActionDraft` now lives in `apps/api/src/agent/host-profile/xox-planned-items.ts`.
- `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` has been deleted.
- xox business action execution and audit writes now live in `apps/api/src/agent/tool-executor.ts`.
- `xox-action-graph-adapter.ts` owns pending action row materialization beside the Agentic OS action graph store adapter and no longer imports the approval adapter.
- the confirm route helper now delegates confirmation to `resumeXoxAgenticOsRunAfterActionConfirmation()`.
- `resumeXoxAgenticOsRunAfterActionConfirmation()` uses `createAgentHostKit()`, calls `confirmAction()`, and resumes the same Agentic OS loop with the executed action observation.
- If a run still has other pending confirmation cards after one action is executed, the helper preserves the Agentic OS human-interrupt boundary and does not burn an extra provider planning turn. The loop resumes after the last pending action is handled.
- Architecture guards now fail if the deleted approval adapter returns or if routes reintroduce local readiness/final-review/evidence/obligation/continuation logic.

## Acceptance Criteria

- `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` does not exist.
- `apps/api/src/agent/routes.ts` does not import:
  - `xox-loop-readiness-adapter`
  - `xox-final-review-adapter`
  - `host-profile/xox-goal-facts`
  - `xox-tool-observation-adapter`
  - `xox-thread-store-adapter` for final assistant continuation
- the confirm route helper contains no goal evaluation, evidence ledger, response evaluation, obligation planning, or provider continuation code.
- `xox-action-graph-adapter.ts` no longer imports business execution helpers or action draft types from the approval adapter.
- Confirming a pending action still returns the existing xox API shape: updated action request, result, messages, run events, plan steps, and thread id.
- Post-confirmation final answers, repairs, and goal status changes come from the Agentic OS host kit resume path.
- Architecture tests guard the deleted semantics from returning.

## Validation

Executed after the batch cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "creates agent navigation events, confirmation cards, and executes confirmed ledger writes|plans multiple editable confirmation cards|restores pending confirmation state|plans team member add and delete|plans shareholder and cost structure add/delete|plans a comprehensive operating model through one high-level editable confirmation"
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd test -w @agentic-os/core
git diff --check
```

Result:

- `build:api` passed.
- `agent-architecture.test.ts` passed: 51 tests.
- Focused confirmation-card API tests passed.
- `test:api` passed: 14 files, 260 tests.
- `@agentic-os/core` build passed.
- `@agentic-os/core` tests passed: 195 tests.
- `git diff --check` passed in both repos.
