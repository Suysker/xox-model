# M172 Four Overreach Cut

Status: Implemented - focused validation passed, full API parity still failing

Date: 2026-06-24

## Goal

Resolve the four remaining overreach points where `xox-model` still looks like it owns harness internals instead of acting as a SaaS host peripheral.

The target shape is:

```text
Agentic OS
  owns: provider turn assembly, retry/recovery, run resume/confirmation orchestration,
        final/goal/evaluation loop facts, sandbox observation proof/status semantics.

xox-model
  owns: provider settings, prompt assets, SQL rows, product DTOs, business tool execution,
        workspace sandbox bundles, Memory Center/product display, HTTP/SSE transport.
```

This is an amputation milestone, not a compatibility wrapper milestone. If a piece of code is generic loop/runtime/status logic, it must move into Agentic OS or disappear from xox.

## Scope

This slice edits:

- `C:/Github/agentic-os/packages/runtime-openai-compatible/src/*`
- `C:/Github/agentic-os/packages/server/src/index.ts`
- `C:/Github/agentic-os/packages/sandbox/src/*`
- `C:/Github/xox-model/apps/api/src/agent/host-profile/xox-host-profile.ts`
- `C:/Github/xox-model/apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts`
- `C:/Github/xox-model/apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts`
- `C:/Github/xox-model/apps/api/src/agent/sandbox-service.ts`
- `C:/Github/xox-model/apps/api/tests/agent-architecture.test.ts`
- impacted API tests that still assert legacy local goal/evaluation tables.

## Module Division

### 1. Provider Runtime Boundary

Agentic OS runtime-openai-compatible should expose a higher-level planning turn helper that:

- converts Agentic OS `RuntimeToolDescriptor` values into OpenAI-compatible tools;
- builds provider-native observation replay messages;
- applies runtime planning recovery and same-turn retry;
- converts normalized provider tool calls back into Agentic OS `AgentToolCall` values;
- redacts provider error text through a generic safe formatter.

`xox-host-profile.ts` should keep only:

- provider/model/base URL/API key settings;
- prompt text and context facts;
- localized runtime event copy;
- planner source metadata.

### 2. Server Run Plane Boundary

Agentic OS server should expose small run-plane helpers for:

- creating a configured server from a HostProfile;
- resuming a run with the canonical default engine options;
- confirming an action and resuming the same run from the action observation.

`xox-host-profile.ts` should stop hand-orchestrating `createAgentServer().confirmAction().resumeRun()` as a local runner. It may still assemble the xox HostProfile, load SQL rows, and persist final assistant messages through existing store functions.

### 3. Legacy Goal/Evaluation Projection Boundary

`xox-thread-store-adapter.ts` should stop querying and serializing `agent_goals` and `agent_evaluations`.

The xox contract fields remain for DTO compatibility, but they should be emitted as empty arrays until Agentic OS exposes a canonical server projection for these concepts. Rebuilding legacy goal contracts downstream is a host-owned evaluator smell.

`xox-run-worker-adapter.ts` should stop updating `agent_goals` and should avoid using `goal_status` as a lifecycle owner. Durable run status, action rows, plan rows, events, and thread timestamps are valid host storage; legacy goal rows are not.

### 4. Sandbox Observation Semantics Boundary

Agentic OS sandbox should own reusable observation predicates and proof/status helpers:

- model-readable output detection;
- deterministic output hash;
- evidence proof construction;
- observation status mapping.

`sandbox-service.ts` should keep only:

- xox workspace bundle/data extraction;
- sandbox manifest metadata tied to xox workspace/run/tool identity;
- exposed xox business SDK entries;
- nested xox action aggregation and product `ReadDraft` projection.

## Dependency Graph

```text
xox HostProfile
  -> @agentic-os/server run helpers
    -> @agentic-os/core AgentRunEngine
    -> @agentic-os/runtime-openai-compatible planning turn helper
    -> xox business tool/action/sandbox/memory ports

xox sandbox-service
  -> @agentic-os/sandbox SandboxBroker
  -> @agentic-os/sandbox observation helpers
  -> xox workspace bundle + xox business tool bridge

xox thread/run stores
  -> SQL row loading/persistence only
  -> @agentic-os/server projection helpers
```

No edge may point from xox adapter code into a local final-review, goal, evaluator, provider retry, sandbox proof, or resume-loop implementation.

## Reuse and Interface Plan

- Reuse existing `runOpenAICompatibleRuntimeTurn()`, `buildProviderToolObservationTurnMessages()`, and `runOpenAICompatibleRuntimePlanningRecovery()` inside a new Agentic OS helper instead of duplicating that assembly in xox.
- Reuse existing `createAgentServer()`, `AgentRunResumeInput`, and action runtime result types through server helper functions, keeping default engine options in one place.
- Reuse existing `SandboxBroker` and result parser exports, adding observation helpers beside `result-parser.ts` rather than creating an xox-only proof builder.
- Keep xox SQL mappers where table schemas and product DTOs are required.

## Naming and Style

- New Agentic OS APIs must be named as generic runtime/server/sandbox helpers, not `xox`.
- xox files that remain must continue to be named as concrete peripherals: `xox-host-profile`, `xox-thread-store-adapter`, `xox-run-worker-adapter`, `sandbox-service`.
- Do not introduce new xox files with `runner`, `runtime`, `evaluator`, `goal`, `readiness`, `obligation`, or `proof` semantics.

## Validation

Required checks:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/runtime-openai-compatible
npm run build -w @agentic-os/server
npm run build -w @agentic-os/sandbox
npm run test -w @agentic-os/runtime-openai-compatible
npm run test -w @agentic-os/server
npm run test -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
npx vitest run tests/agent-architecture.test.ts
```

Escalation check after focused tests:

```bash
cd C:/Github/xox-model
npx vitest run apps/api/tests/api.test.ts --runInBand
```

If legacy API tests fail only because they assert `agent_goals` / `agent_evaluations` rows, update those tests to assert Agentic OS visible run facts instead of preserving downstream evaluator tables.

## Acceptance

- `xox-host-profile.ts` no longer defines OpenAI-compatible planning turn assembly, runtime retry tool selection, normalized provider call conversion, or local confirm-and-resume sequencing.
- `xox-thread-store-adapter.ts` no longer imports goal/evaluation contract types, queries `agent_goals` / `agent_evaluations`, or serializes legacy goal/evaluation records.
- `xox-run-worker-adapter.ts` no longer writes `agent_goals` or pushes `goal_status` lifecycle values.
- `xox-run-submission-adapter.ts` initializes legacy `goal_status` as `null` and no longer marks failed submissions through legacy goal state.
- `sandbox-service.ts` no longer owns generic sandbox output hashing, evidence proof construction, model-readable output checks, or observation status mapping.
- Architecture tests guard these four cuts from returning.

## Implementation Notes

Agentic OS now owns the reusable pieces added by this slice:

- `@agentic-os/runtime-openai-compatible` exports `runOpenAICompatiblePlanningRuntimeTurn()`, `openAICompatibleRuntimeInputFirstToolName()`, `formatOpenAICompatibleRuntimeTurnError()`, and related planning-runtime helpers.
- `@agentic-os/server` exports `createAgentServerSaaSRunPlane()`, `resumeAgentServerRun()`, and `confirmAgentServerActionAndResume()`.
- `@agentic-os/sandbox` exports `sandboxObservationEvidenceProof()`, `sandboxObservationHasModelReadableOutput()`, `sandboxObservationOutputHash()`, and `sandboxObservationStatus()`.

xox now consumes those helpers and keeps only provider settings, prompt/context inputs, SQL persistence, DTO mapping, business action execution, and sandbox bundle/business SDK wiring.

## Validation Evidence

Passed:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/runtime-openai-compatible
npm run build -w @agentic-os/server
npm run build -w @agentic-os/sandbox
npm run test -w @agentic-os/runtime-openai-compatible
npm run test -w @agentic-os/server
npm run test -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
npx vitest run tests/agent-architecture.test.ts
```

Full parity check:

```bash
cd C:/Github/xox-model/apps/api
npx vitest run tests/api.test.ts
```

Result: 62 passed, 27 failed. The failing cases are broad legacy API parity expectations outside this four-boundary cut: old navigation event placement, legacy goal/evaluation status assertions, local provider stable-mode expectations, old fail-plan-step shapes, and product-level behavior assertions that predate the host-harness amputation. They must be handled by updating product projection adapters or moving missing reusable projection behavior into Agentic OS, not by restoring local xox harness code.

