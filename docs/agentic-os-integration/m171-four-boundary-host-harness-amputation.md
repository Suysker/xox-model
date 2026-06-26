# M171 Four-Boundary Host Harness Amputation

Status: In progress - event-store and runtime-policy regressions corrected

Date: 2026-06-24

## Goal

Cut the remaining four xox-owned harness pressure points so `xox-model` behaves like a downstream SaaS host: tools, prompts, stores, DTOs, and product transport only. Agentic OS must own the reusable run worker lifecycle, provider/runtime loop entry, memory lifecycle semantics, and sandbox runtime bridge.

## Scope

This slice targets:

- `apps/api/src/agent/host-profile/xox-host-profile.ts`
- `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts`
- `apps/api/src/agent/memory.ts`
- `apps/api/src/agent/sandbox-service.ts`

## Module Boundary

```text
@agentic-os/server
  owns: queued-run execution, drain lifecycle, recovery classification, run completion projection
  calls: host queue store + host run plane

@agentic-os/core
  owns: memory policy, ranking, prompt eligibility, recall prompt pack, memory event drafts
  calls: host memory repository

@agentic-os/sandbox
  owns: sandbox broker, runtime backend, tool RPC protocol, SDK helper files, result parsing
  calls: host business tool runtime handler

xox-model
  owns: SQL rows, tenant/user/workspace authorization, provider settings, business tool catalog,
        workspace bundle data, Memory Center DTOs, HTTP/SSE routes, localized product copy
```

## Dependency Graph

```text
xox routes
  -> xox run submission adapter
    -> @agentic-os/server queued-run worker primitive
      -> xox durable queue store
      -> xox HostProfile factory
        -> @agentic-os/core AgentRunEngine
        -> @agentic-os/runtime-* provider packages
        -> xox business tools/action store/sandbox/memory repository
```

No xox production file should own a second drain scheduler, recovery decision tree, memory recall lifecycle state machine, sandbox RPC parser, or final loop runner.

## Reuse and Interface Plan

- Add or consume `@agentic-os/server` worker primitives so synchronous submit and background worker use the same queued-run execution path.
- Keep `xox-run-worker-adapter.ts` only as durable SQL queue/store adapter and product cancellation/fail-closed persistence.
- Keep `xox-host-profile.ts` only as HostProfile/HostAdapter wiring. Provider runtime calls remain only at the provider-settings boundary until Agentic OS exposes a higher-level provider runtime profile builder; no local loop/recovery/final-review branching is allowed. Final review must use `@agentic-os/server` completion ports, not xox-local evaluator wrappers.
- Keep `memory.ts` as memory repository, Memory Center DTO, and explicit memory tools. Ranking/policy/citation helpers must stay imported from `@agentic-os/core`; active recall lifecycle must not return to xox.
- Keep `sandbox-service.ts` as workspace bundle and business SDK manifest adapter. Sandbox execution protocol, backend selection, staged SDK files, tool RPC file protocol, and result parsing must stay in `@agentic-os/sandbox`.
- Keep `xox-run-event-store-adapter.ts` as run-event persistence, stream copy, action-event localization, and thread signal transport only. It must not own goal contracts, evaluation status mapping, final-review projection, or readiness/evidence bookkeeping.

## Naming and Style

- xox files that remain must be named after concrete peripherals: `*-store-adapter`, `*-submission-adapter`, `tool-catalog`, `tool-executor`, `memory`, `sandbox-service`.
- Avoid new root harness names such as `runner`, `planner`, `runtime`, `loop`, `evaluator`, `readiness`, or `gateway`.
- Prefer deleting host code or moving generic behavior to Agentic OS over preserving thin wrappers.

## Validation

Required commands:

```bash
cd C:/Github/agentic-os
npm run build
npm run test -w @agentic-os/server
npm run test -w @agentic-os/core
npm run test -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
npx vitest run apps/api/tests/agent-architecture.test.ts apps/api/tests/sandbox-tool.test.ts apps/api/tests/tool-runtime.test.ts
```

Escalate to `npm run test:api` after build and focused tests pass.

## Acceptance

- xox background worker no longer owns drain exclusivity, active controller lifecycle, or recovery classification.
- xox synchronous submit uses the same Agentic OS queued-run execution primitive as background worker.
- xox memory code contains no active recall runtime, lifecycle callback orchestration, or local memory kernel duplicates.
- xox sandbox code contains no local sandbox backend/runtime/result parser implementation.
- Architecture tests guard the four boundaries from regressing.

## Course Correction - 2026-06-24

During M171, a compatibility attempt temporarily grew `xox-run-event-store-adapter.ts` with goal/evaluation/final-review projection helpers. That was rejected as a boundary regression: old xox UI tables cannot justify rebuilding evaluator/goal logic downstream.

The corrected direction is:

- delete generic goal/evaluation projection from `xox-run-event-store-adapter.ts`;
- move reusable final review completion behavior into `@agentic-os/server`;
- let xox keep only event persistence/localized copy and concrete SQL/DTO adapters;
- treat remaining `xox-run-worker-adapter.ts` size as a store-adapter audit item, not as permission to rebuild run-plane lifecycle locally.

Validation evidence after correction:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/server
npm run test -w @agentic-os/server

cd C:/Github/xox-model
npm run build:api
```

## Three-File Boundary Audit - 2026-06-24

The following corrections were made after auditing the three largest remaining xox agent files:

- `agentic-os/xox-action-graph-adapter.ts`: removed the hard-coded `workspace_configure_operating_model` / redundant workspace rename filter. Business action de-duplication must live in the concrete business draft/tool layer or in Agentic OS generic repeated-action policy, not in the Agentic OS action-graph store adapter.
- `agentic-os/xox-run-worker-adapter.ts`: removed the local in-memory completed-run side table and stopped making partial-output fail-closed decisions in `claimPendingRuns()`. xox now exposes durable facts and persistence callbacks; Agentic OS durable queue recovery performs the recover / fail-closed classification.
- `host-profile/xox-host-profile.ts`: removed xox tool-name-driven provider stable mode (`HIGH_VOLUME_RUNTIME_TOOL_NAMES`, `buildProviderRuntimeStableToolPatch`, and `provider_stable_long_tool_mode`). Provider runtime stability and same-turn retry remain Agentic OS runtime responsibilities. Provider retry, runtime evidence, and final-review product events now use `agentServerRunLifecycleEvents.*` builders with xox providing only localized copy and durable event writes.

Allowed residual responsibilities:

- `xox-action-graph-adapter.ts` may map xox `PlannedItem` / action rows / navigation DTOs into `@agentic-os/server` action graph materialization ports.
- `xox-run-worker-adapter.ts` may claim SQL rows, load tenant/workspace/user/message facts, maintain SQL leases, and persist Agentic OS completion/fail-closed callbacks.
- `xox-host-profile.ts` may wire provider settings, prompt assets, tool catalog, business action execution, memory repository reads, sandbox bundle execution, and localized event persistence into Agentic OS ports.

Validation evidence:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/contracts
npm run build -w @agentic-os/core
npm run build -w @agentic-os/server
npm run build -w @agentic-os/runtime-openai-compatible
npm run build -w @agentic-os/sandbox
npm run test -w @agentic-os/core
npm run test -w @agentic-os/server
npm run test -w @agentic-os/runtime-openai-compatible
npm run test -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
npx vitest run tests/agent-architecture.test.ts
```
