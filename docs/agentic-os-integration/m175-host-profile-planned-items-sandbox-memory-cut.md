# M175 HostProfile Planned-Items Sandbox Memory Cut

Status: Implemented for this slice

Date: 2026-06-25

## Goal

This slice removes the next four host overreach surfaces from `apps/api/src/agent` under the stricter boundary:

- Agentic OS is the SaaS harness machine: runtime routing, host event lifecycle projection, final-review wiring, active-memory context source, planned-item/result bridge, sandbox execution lifecycle, and memory capture/write runtime.
- xox-model is a downstream peripheral set: tool manifests, business tool handlers, product prompts, tenant stores, workspace bundles, business writes, Memory Center DTOs, localized copy, HTTP/SSE transport, and product projection.

## Four Cuts

### 1. HostProfile Composition Cut

Current smell:

- `host-profile/xox-host-profile.ts` still owns runtime adapter selection, provider runtime event persistence, final-review completion wiring, active-memory source wiring, and host event mapping.

Target:

- `@agentic-os/server` owns reusable SaaS HostProfile composition helpers.
- xox supplies callbacks and localized copy only: provider settings, runtime adapters, event appenders, memory retrieval callback, context facts, business action callbacks, and tool registry.

### 2. Planned-Items Cut

Current smell:

- `host-profile/xox-planned-items.ts` owns generic planned-item/read/action result types, tool-result metadata attachment, canonical observation bridge conversion, empty-result supervisor projection, and `buildPlannedItemFromRuntimeStep()`.

Target:

- `@agentic-os/core` owns generic host tool result/read/action types and the tool-result runtime bridge.
- xox keeps business action/read DTO payload fields and business handler table.
- `host-profile/xox-planned-items.ts` is deleted or reduced to a temporary type alias shell with architecture guards against returning generic runtime functions.

### 3. Sandbox Execution Lifecycle Cut

Current smell:

- `sandbox-service.ts` no longer owns nested tool runtime bridge or aggregate loop, but still owns `runSandboxCode()` / `planSandboxRunCode()` execution lifecycle, observation DTO assembly, and sandbox action aggregation call shape.

Target:

- `@agentic-os/sandbox` owns a reusable sandbox execution planner that runs the broker, tracks nested observations, builds model-readable execution facts, and appends aggregate actions through callbacks.
- xox keeps data bundle construction, manifest copy/policy, tool SDK manifest copy, uploaded file inspection, and localized action/read copy.

### 4. Memory Capture Runtime Cut

Current smell:

- `memory.ts` no longer owns search/get tool runtime, but `rememberAgentMemory()` still owns memory capture/write lifecycle: policy decision, candidate normalization, DB write, and event write.

Target:

- `@agentic-os/core` owns generic memory capture runtime over a repository port.
- xox keeps a tenant-scoped repository implementation and Memory Center management endpoints.

## Module Plan

```text
@agentic-os/core
  createAgentHostToolResultRuntime()
  createAgentMemoryCaptureRuntime()

@agentic-os/server
  createAgentServerRuntimeSwitchAdapter()
  createAgentServerHostLifecycleEventPort()
  createAgentServerSaaSHostProfile()

@agentic-os/sandbox
  runAgenticSandboxToolExecution()
  planAgenticSandboxToolResult()

xox-model apps/api/src/agent
  host-profile/xox-host-profile.ts       HostProfile callback declaration only
  host-profile/xox-planned-items.ts      delete or type-only shell
  sandbox-service.ts                     bundle/policy/file adapters/localized copy only
  memory.ts                              tenant memory repository + Memory Center only
```

## Validation

Commands run for this slice:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/core
npm run build -w @agentic-os/server
npm run build -w @agentic-os/sandbox

cd C:/Github/xox-model
npm run build:api
cd C:/Github/xox-model/apps/api
npx vitest run tests/agent-architecture.test.ts
npx vitest run tests/action-observation.test.ts
```

All commands above passed on 2026-06-25.

Full API parity failures must not be fixed by restoring local xox harness logic.

## Implementation Notes

- `apps/api/src/agent/xox-tool-result-config.ts` was deleted. A downstream app must not keep a file whose only purpose is wrapping Agentic OS tool-result, observation bridge, or empty-result harness behavior.
- `@agentic-os/core` now owns the default host tool observation bridge key, so downstream apps do not hand-write generic observation de-duplication keys.
- `xox-host-profile.ts`, `xox-action-graph-adapter.ts`, and `sandbox-service.ts` call Agentic OS core helpers directly at their real peripheral boundaries.
- `agent-architecture.test.ts` now guards the deleted file and helper names from returning.
- `action-observation.test.ts` validates the empty-result supervisor envelope through `@agentic-os/core`, not through a xox-local helper.

## Completion Gate

Architecture tests must forbid these host-owned entrypoints from returning:

- `createXoxRuntimeAdapter`
- `recordOpenAIAgentsEvent`
- local `appendEvent: async (event: OsRunEvent)`
- `createAgentServerActiveMemoryContextSource` in xox
- `createAgentServerFinalReviewCompletionPort` in xox
- `buildPlannedItemFromRuntimeStep`
- `createXoxObservationBridge`
- `agenticOsObservationFromXox`
- `xoxObservationFromAgenticOs`
- `runSandboxCode`
- `planSandboxRunCode`
- `rememberAgentMemory`
- `xox-tool-result-config`
- `createXoxToolObservationBridge`
- `runXoxBusinessToolStep`
- `xoxEmptyToolResultRead`
- `xoxToolResultRuntime`
