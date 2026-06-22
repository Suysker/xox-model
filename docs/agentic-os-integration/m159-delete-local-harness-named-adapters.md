# M159 Delete Local Harness-Named Adapters

## Decision

Delete the remaining xox files whose names made the downstream app look like it still owned a local harness:

- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts`
- `apps/api/src/agent/agentic-os/xox-final-review-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-runtime-adapter.ts`

The surviving xox-specific behavior is kept under HostProfile names:

- `apps/api/src/agent/host-profile/xox-agent-run-profile.ts`
- `apps/api/src/agent/host-profile/xox-final-review-policy.ts`
- `apps/api/src/agent/host-profile/xox-provider-runtime.ts`

This is an amputation of misleading local harness boundaries, not a claim that every remaining line is already ideal. The rule is stricter now: `apps/api/src/agent/agentic-os` may hold concrete store, transport, durable row, action graph, observation DTO, worker, and run-plane adapters. It must not hold xox-owned files named like the harness runner, provider runtime, or final-review engine.

## Why

The target architecture is:

- Agentic OS is the SaaS harness computer.
- xox is storage, memory, display, business tools, provider settings, tenant policy, and transport peripherals.
- A downstream app should not expose files that look like a local CPU implementation.

The deleted files were no longer pure Agentic OS code. They contained xox product policy and adapter wiring, but their old names still invited future changes to treat them as a local harness. Moving that residue under `host-profile` makes the boundary honest:

- run profile: wires xox DB/tools/context into Agentic OS loop ports;
- final-review policy: supplies xox financial/shareholder evidence requirements and localized DTO mapping;
- provider runtime: maps xox provider settings, prompts, tool catalog materialization, localized events, and legacy planner-step DTOs into Agentic OS runtime packages.

## Module Division

| Module | Owner | Responsibility |
| --- | --- | --- |
| `@agentic-os/core` | Agentic OS | Agent loop state machine, tool supervision, evidence/obligation mechanics, readiness, action runtime, observation semantics |
| `@agentic-os/server` | Agentic OS | scheduler, lifecycle event drafts, run-state projection, final-answer claim extraction, durable server primitives |
| `@agentic-os/runtime-openai-compatible` | Agentic OS | OpenAI-compatible request shaping, transport, streaming, normalization, retry, tool-call repair |
| `@agentic-os/runtime-openai-agents` | Agentic OS | OpenAI Agents SDK lifecycle and tool-call capture |
| `host-profile/xox-agent-run-profile.ts` | xox HostProfile | xox run-profile wiring into Agentic OS ports, DB row loading, xox tool execution handoff, legacy DTO result projection |
| `host-profile/xox-final-review-policy.ts` | xox HostProfile | financial/shareholder requirements, evidence source mapping, localized review copy, legacy final-review DTO projection |
| `host-profile/xox-provider-runtime.ts` | xox HostProfile | provider settings, prompt/context input mapping, business tool budgets, localized runtime event copy, normalized provider call to xox planner-step mapping |
| `agentic-os/xox-*store/adapter.ts` | xox peripherals | Kysely stores, event appenders, thread/run/action graph persistence, observation DTO bridging, worker process wiring |

## Dependency Graph

```text
routes / worker
  -> host-profile/xox-agent-run-profile.ts
  -> @agentic-os/core and @agentic-os/server
  -> xox concrete peripherals

host-profile/xox-agent-run-profile.ts
  -> host-profile/xox-provider-runtime.ts
  -> host-profile/xox-final-review-policy.ts
  -> agentic-os/xox-run-event-store-adapter.ts
  -> agentic-os/xox-thread-store-adapter.ts
  -> agentic-os/xox-action-graph-adapter.ts
  -> agentic-os/xox-tool-observation-adapter.ts
  -> agentic-os/xox-goal-store-adapter.ts

agentic-os/xox-* peripheral adapters
  -> @agentic-os/server/core primitives
  -> xox DB, tool executor, contracts, localized DTOs
```

Forbidden shape:

```text
apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts
apps/api/src/agent/agentic-os/xox-final-review-adapter.ts
apps/api/src/agent/agentic-os/xox-runtime-adapter.ts
```

## Reuse and Interface Plan

No compatibility shims were kept. Importers now point directly at the honest boundary:

- `routes.ts` imports `resumeXoxAgenticOsRunAfterActionConfirmation` from `host-profile/xox-agent-run-profile.ts`.
- `xox-run-worker-adapter.ts` imports `executeXoxAgenticOsRun` from `host-profile/xox-agent-run-profile.ts`.
- tests and type imports read `RuntimePlanResult` from `host-profile/xox-provider-runtime.ts`.
- `tool-catalog.ts` imports `AgentLoopObligationPlan` from `host-profile/xox-final-review-policy.ts`.

Architecture guards assert the obsolete files are absent, and that worker imports go through `host-profile/xox-agent-run-profile.ts`.

## Validation

Required gate for this cut:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
git diff --check
```

Expected result:

- TypeScript compiles without old import paths.
- architecture test fails if the deleted three files return.
- full API test suite remains green, proving xox behavior is preserved while local harness-named files are removed.

## Status

M159 completes the filename and directory amputation for the three most misleading local harness boundaries. It does not close M142. The next pressure point is to keep shrinking `host-profile/xox-agent-run-profile.ts` until it is only HostProfile/HostAdapter wiring, not a readable loop narrative.
