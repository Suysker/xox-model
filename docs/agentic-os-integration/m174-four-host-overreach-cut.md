# M174 Four Host Overreach Cut

Status: Implemented

Date: 2026-06-25

## Goal

This slice removes the four remaining host-owned harness residues identified in `apps/api/src/agent` after M173.

The target boundary remains:

- Agentic OS is the complete SaaS harness machine: projection primitives, sandbox tool-runtime bridge, memory tool runtime, and high-level SaaS HostProfile assembly.
- xox-model is a downstream host peripheral set: business tools, product prompts, tenant stores, provider settings, workspace bundles, business action execution, Memory Center DTOs, localized copy, and HTTP/SSE transport.

## Four Cuts

### 1. Projection Cut

Current smell:

- `agentic-os/xox-thread-store-adapter.ts` still owns generic transcript/timeline/tree projection via `buildXoxProjectionViews()`, `timelineItemFromTranscriptItem()`, `transcriptNodeFromTimelineItem()`, and OS transcript kind/status/title/summary mapping.

Target:

- `@agentic-os/server` owns reusable legacy projection from Agentic OS transcript facts to transcript/timeline/node views through host-neutral callbacks.
- xox keeps only DTO field names, Chinese copy, navigation/action DTO mapping, and product state assembly.

### 2. Sandbox Bridge Cut

Current smell:

- `sandbox-service.ts` still owns nested sandbox tool-runtime bridge mechanics and aggregate action planning via `sandboxToolRuntimeHandler()` and `aggregateSandboxActions()`.

Target:

- Agentic OS sandbox/server owns nested tool runtime response semantics, observation tracking, and aggregate action planning helper.
- xox keeps workspace bundle building, exposed SDK manifest, business tool step mapping, business action draft execution, and aggregate confirmation copy.

### 3. Memory Tool Runtime Cut

Current smell:

- `memory.ts` still exposes `runMemorySearchTool()` / `runMemoryGetTool()` as xox-owned memory tool runtime implementations.

Target:

- Agentic OS core/server owns memory search/get/remember tool runtime helpers over a host memory repository port.
- xox keeps tenant-scoped memory repository, authorization, Memory Center DTOs, and localized tool copy.

### 4. HostProfile Wiring Cut

Current smell:

- `host-profile/xox-host-profile.ts` still manually assembles runtime, event sink, completion, active memory context source, sandbox port, tool registry, action port, and base context inside one giant host file.

Target:

- Agentic OS server exposes a higher-level SaaS host profile factory that wires common ports and lifecycle event sinks.
- xox keeps concrete callbacks: provider settings/runtime adapter inputs, store adapter, business tool registry, business action port, sandbox bundle port, memory repository, context facts, and localized copy.

## Module Plan

```text
@agentic-os/server
  projectAgentServerLegacyTranscriptViews()
  createAgentServerSaaSHostAdapter()

@agentic-os/sandbox
  createSandboxToolRuntimeBridge()
  planSandboxAggregateToolActions()

@agentic-os/core
  createAgentMemoryToolRuntime()

xox-model apps/api/src/agent
  agentic-os/xox-thread-store-adapter.ts  product DTO labels/action mapping only
  sandbox-service.ts                      workspace bundle + business SDK/payload policy only
  memory.ts                               tenant memory repository + Memory Center only
  tool-executor.ts                        business tool handler table only
  host-profile/xox-host-profile.ts        SaaS HostProfile configuration only
```

## Validation

Implementation evidence:

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
npx vitest run tests/api.test.ts
```

Results on 2026-06-25:

- `@agentic-os/core` build passed; test passed with 219 tests.
- `@agentic-os/sandbox` build passed; test passed with 6 tests.
- `@agentic-os/server` build passed; test passed with 49 tests.
- `xox-model` `npm run build:api` passed.
- `xox-model/apps/api` `npx vitest run tests/agent-architecture.test.ts` passed with 10 tests.
- `xox-model/apps/api` `npx vitest run tests/api.test.ts` still reports 62 passed / 27 failed. This matches the known legacy parity gap class from M173: product navigation DTOs, old goal/evaluation/status event assertions, provider failure plan-step shape, memory recall signal projection, redundant action de-duplication, and complex-goal pacing. These must be fixed through Agentic OS-owned reusable projection/runtime behavior or thin product projection adapters, not by restoring xox-owned harness code.

## Completion Gate

This slice is complete only when architecture tests forbid these host-owned helper names from returning:

- `buildXoxProjectionViews`
- `timelineItemFromTranscriptItem`
- `transcriptNodeFromTimelineItem`
- `transcriptKindFromOs`
- `sandboxToolRuntimeHandler`
- `aggregateSandboxActions`
- `runMemorySearchTool`
- `runMemoryGetTool`
- direct `createAgentHostAdapterFromProfile` usage in `xox-host-profile.ts`

## Implementation Notes

- Projection: xox now calls `projectAgentServerLegacyTranscriptViews()` through `projectXoxProductViews()` and keeps only Chinese copy plus action/navigation DTO adapters.
- Sandbox: xox now calls `createSandboxToolRuntimeBridge()` and `planSandboxAggregateToolActions()`; local nested observation and aggregate loop functions were deleted.
- Memory: xox deleted `runMemorySearchTool()` and `runMemoryGetTool()`; `tool-executor.ts` uses `createAgentMemoryToolRuntime()` with xox tenant-scoped `searchTenantMemory()` / `getTenantMemory()` callbacks.
- HostProfile: xox no longer imports `createAgentHostAdapterFromProfile`; `createXoxHostProfile()` returns an `AgentServerSaaSHostProfile`, and `@agentic-os/server` creates the adapter through `createAgentServerSaaSHostAdapter()`.
