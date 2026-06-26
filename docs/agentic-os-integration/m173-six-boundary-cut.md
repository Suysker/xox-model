# M173 Six-Boundary Host Harness Cut

Status: Implemented

Date: 2026-06-25

## Goal

This slice removes the six remaining host-owned harness residues identified in `apps/api/src/agent`.

The target boundary is strict:

- Agentic OS is the complete SaaS harness machine: loop, provider turn lifecycle, tool supervision, memory recall lifecycle, sandbox runtime protocol, final-answer claim review, run recovery semantics, and generic transcript facts.
- xox-model is a downstream host peripheral set: business tools, prompts, tenant/provider settings, SQL stores, workspace bundles, business action execution, product DTOs, localized copy, and transport.

## Six Cuts

### 1. HostProfile Runtime Cut

Current smell:

- `apps/api/src/agent/host-profile/xox-host-profile.ts` still owns provider runtime dispatch and post-run finalization.

Target:

- xox keeps only HostProfile wiring, xox context facts, business tool port, business action port, provider settings adapter, and product message persistence.
- Provider turn execution and finalization helpers are consumed through Agentic OS server/runtime APIs.

### 2. Tool Supervisor / Planned Item Cut

Current smell:

- `host-profile/xox-planned-items.ts` still builds generic empty-result supervisor fallback observations and classifies observation outcomes.

Target:

- Agentic OS owns empty-result failure envelope, canonical observation outcome, and bridge fallback behavior.
- xox keeps only `ReadDraft`, `AgentActionDraft`, and xox DTO mapping.

### 3. Run-Plane Recovery Cut

Current smell:

- `agentic-os/xox-run-worker-adapter.ts` still decides recover/fail/cancel details and constructs failure run shape.

Target:

- Agentic OS server owns recovery/fail/cancel decision projection.
- xox keeps SQL claim/lease/load/store writes and localized copy.

### 4. Projection Cut

Current smell:

- `agentic-os/xox-thread-store-adapter.ts` still owns generic transcript/timeline/tree projection from Agentic OS facts.

Target:

- Agentic OS server owns generic thread/run/transcript facts and projection helpers.
- xox keeps only legacy `@xox/contracts` DTO labels, Chinese copy, navigation links, and product visual fields.

### 5. Memory / Sandbox Runtime Cut

Current smell:

- `memory.ts` still exposes recall/rank/tool summaries directly.
- `sandbox-service.ts` still owns sandbox SDK bridge, nested tool aggregation, and observation status interpretation around the runtime protocol.

Target:

- Agentic OS owns active-memory lifecycle, citations, recall tool observation summary helpers, sandbox structured tool-call collection, result parsing, proof/status/output helpers, and generic nested tool protocol.
- xox keeps tenant memory repository, Memory Center DTO, workspace data bundle, and xox business SDK entries.

### 6. Final-Answer Claim Tool Cut

Current smell:

- `tool-catalog.ts` still exposes `final_answer_extract_claims` as a xox provider tool.

Target:

- Final-answer claim extraction tool schema and prompt are Agentic OS server-owned.
- xox supplies subject taxonomy and optional domain prompt additions only.

## Module Plan

```text
@agentic-os/core
  memory-kernel.ts
  tool-call-supervisor.ts
  host-observation-bridge.ts

@agentic-os/server
  final-answer claim extraction
  run queue / recovery projection
  thread state projector
  submitted run projection
  host-profile runner helpers

@agentic-os/sandbox
  SandboxBroker
  result-parser structured tool calls
  observation proof/status/output helpers

xox-model apps/api/src/agent
  tool-catalog.ts              business tool manifest only
  tool-executor.ts             business execution only
  memory.ts                    tenant store + Memory Center + explicit memory tools
  sandbox-service.ts           workspace bundle + xox business SDK adapter
  host-profile/xox-host-profile.ts
                              thin HostProfile wiring
  agentic-os/*-adapter.ts      durable SQL/event/route/product projection adapters only
```

## Validation

Run after implementation:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/core
npm run test -w @agentic-os/core
npm run build -w @agentic-os/server
npm run test -w @agentic-os/server
npm run build -w @agentic-os/sandbox
npm run test -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
cd C:/Github/xox-model/apps/api
npx vitest run tests/agent-architecture.test.ts
```

Expected:

- All listed commands pass.
- `apps/api/src/agent` contains no xox-owned provider runtime runner, final-answer claim tool, generic tool-supervisor failure envelope, local memory recall lifecycle, local sandbox proof/status/parser, or generic transcript engine.

Actual M173 evidence:

- `C:/Github/agentic-os`: `npm run build -w @agentic-os/core` passed.
- `C:/Github/agentic-os`: `npm run test -w @agentic-os/core` passed, 218 tests.
- `C:/Github/agentic-os`: `npm run build -w @agentic-os/server` passed.
- `C:/Github/agentic-os`: `npm run test -w @agentic-os/server` passed, 48 tests.
- `C:/Github/agentic-os`: `npm run build -w @agentic-os/runtime-openai-compatible` passed.
- `C:/Github/agentic-os`: `npm run test -w @agentic-os/runtime-openai-compatible` passed, 51 tests.
- `C:/Github/agentic-os`: `npm run build -w @agentic-os/sandbox` passed.
- `C:/Github/agentic-os`: `npm run test -w @agentic-os/sandbox` passed, 4 tests.
- `C:/Github/xox-model`: `npm run build:api` passed.
- `C:/Github/xox-model/apps/api`: `npx vitest run tests/agent-architecture.test.ts` passed, 10 tests.
- `C:/Github/xox-model/apps/api`: `npx vitest run tests/api.test.ts` ran and reported 62 passed / 27 failed. The failing assertions are legacy parity gaps around navigation DTO projection, old goal/evaluation/status events, provider failure plan-step shapes, memory recall signals, redundant action de-duplication, and complex-goal pacing. M173 does not close full API parity; it prevents the six harness residues from returning while keeping the remaining failures out of xox-local harness restoration.
- `C:/Github/xox-model/apps/api/src/agent`: `rg` found no references to `runOpenAICompatiblePlanningRuntimeTurn`, `runOpenAIAgentsTurn`, `classifyToolObservationOutcome`, `buildToolSupervisorEmptyResultFailureObservation`, `final_answer_extract_claims`, `executeXoxDirectAnswerLane`, `objectiveImpliesForecastOnly`, `objectiveRequiresActionWrite`, `shouldCollectPendingActionsBeforePause`, `ENTITY_SUMMARY_TOOL_ARGUMENTS`, `readableObservationText`, `collectSandboxStructuredToolCalls`, `function summarizeMemoryToolItems`, or `function sandboxToolCalls`.

## Completion Gate

This slice is complete only when:

- Architecture tests forbid the six residues from returning.
- The xox API build passes.
- Agentic OS packages that receive moved behavior build and test.
- `README.md` points to this M173 document as the latest status.
