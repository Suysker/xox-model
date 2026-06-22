# M161 Delete Tool Observation Adapter Facade

Status: completed.

Date: 2026-06-22

## Why

`apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` had become a misleading downstream harness facade. It mixed four responsibilities:

- xox `AgentToolObservation` DTO projection;
- Agentic OS canonical observation bridge wiring;
- action preview/result/failure observation helpers;
- provider observation-to-final-answer continuation wiring.

That shape violated the integration rule that xox must not keep a local harness layer. Agentic OS owns the loop, observation semantics, prompt skeleton, and provider replay assembly. xox should keep only product DTOs, durable storage, business copy, provider settings, and final message persistence at concrete host boundaries.

## Cut

The standalone facade is deleted:

```text
apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts
```

The surviving responsibilities are collapsed into existing concrete boundaries, without creating a replacement wrapper:

| Residual responsibility | New xox boundary | Reason |
| --- | --- | --- |
| `AgentToolObservation` DTO and canonical observation bridge | `apps/api/src/agent/host-profile/xox-planned-items.ts` | Product planned-item/read DTO definitions already live here. The bridge is DTO projection, not a runner. |
| Tool supervisor failure DTO wrapper | `apps/api/src/agent/host-profile/xox-planned-items.ts` | Agentic OS core owns the canonical failure envelope; xox owns localized read draft copy. |
| Action preview/result/failure observation helpers | `apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts` | These helpers depend on action rows, business result summaries, durable action graph writes, and localized product projection. |
| Provider observation continuation host wiring | `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` | This is still a pressure point, but it now sits at the actual run profile boundary and consumes Agentic OS core/runtime helpers rather than a fake observation adapter. |

## Dependency Rules

- No production import may reference `agentic-os/xox-tool-observation-adapter.ts`.
- No xox file may hand-build OpenAI-compatible assistant `tool_calls` plus `tool` replay messages.
- No xox file may hand-write `action_preview` or `action_result` model payloads.
- No xox file may recreate canonical observation id/tool-call id merge/dedupe maps outside `createHostObservationBridge()`.
- `host-profile/xox-agent-run-profile.ts` remains the next pressure point: any continuation lifecycle semantics that can become host-neutral should move into Agentic OS rather than into another xox adapter.

## Architecture Guards

`apps/api/tests/agent-architecture.test.ts` now asserts:

- the deleted file remains absent;
- action observation envelopes come from `@agentic-os/core` builders;
- host observation bridge wiring comes from `@agentic-os/core` `createHostObservationBridge()`;
- provider observation continuation messages come from `@agentic-os/runtime-openai-compatible`;
- same-thread runtime conversation replay remains sourced from Agentic OS core helpers.

## Validation

Evidence from this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
git diff --check
```

Observed result:

- `build:api` passed.
- `tests/agent-architecture.test.ts` passed: 55 tests.
- `test:api` passed: 11 test files, 219 tests.
- `git diff --check` passed in both repositories.

## Alignment

This cut moves xox closer to the target shape: Agentic OS is the complete SaaS harness computer, and xox is storage, memory, display, and peripheral drivers. The downstream app keeps only data/tool/product boundaries and no longer has a standalone tool-observation harness facade.
