# M176 Five Host CPU Cuts

Status: Implemented for this slice

Date: 2026-06-25

## Goal

Delete the next five host-owned CPU surfaces from `apps/api/src/agent`.

Agentic OS is the SaaS agent computer. xox-model is only the downstream peripherals: business tools, business stores, provider settings, prompts, product DTOs, HTTP/SSE transport, and localized copy.

## Cuts

### 1. HostProfile CPU Logic

Delete from xox:

- local tool-result runtime port construction
- runtime adapter switch wiring details
- OpenAI Agents runtime event translation
- final-review event projection
- Agentic OS lifecycle event classification

Keep in xox:

- provider settings lookup
- business tool registry
- store/action/sandbox/memory ports
- localized product event copy as data passed to Agentic OS

### 2. Sandbox Execution Loop

Delete from xox:

- sandbox tool execution loop
- nested tool runtime bridge orchestration
- aggregate nested action planning
- generic sandbox observation status/proof/output projection

Keep in xox:

- workspace data bundle construction
- manifest policy and exposed SDK document
- upload file inspection
- localized sandbox read/action copy

### 3. Tool Executor Runtime Wiring

Delete from xox:

- memory tool runtime wiring
- sandbox tool runtime wiring
- generic read-observation packaging where Agentic OS can own it

Keep in xox:

- business read/write tool handlers
- business action execution
- xox domain validation and audit

### 4. Memory Kernel Semantics

Delete from xox:

- memory capture policy
- memory search/get tool projection
- citation/ranking/tool item projection

Keep in xox:

- tenant memory DB repository
- Memory Center CRUD/projection endpoints
- permission checks and SQL row mapping

### 5. Generic Projection

Delete from xox:

- generic action graph materializer pieces
- transcript/timeline/AG-UI projection composition
- run-submission projection composition

Keep in xox:

- durable row mapping
- legacy DTO compatibility
- localized product labels/navigation DTOs

## Validation

Commands run for this slice:

```bash
cd C:/Github/agentic-os
npm run build -w @agentic-os/core
npm run build -w @agentic-os/server
npm run build -w @agentic-os/sandbox
npm run build -w @agentic-os/runtime-openai-agents

cd C:/Github/xox-model
npm run build:api
cd C:/Github/xox-model/apps/api
npx vitest run tests/agent-architecture.test.ts
npx vitest run tests/action-observation.test.ts
```

All commands above passed on 2026-06-25.

Full API parity failures must be fixed only by reusable Agentic OS projection/runtime helpers or xox DTO/store adapters. Do not restore local xox harness loops.

## Implementation Notes

- HostProfile no longer directly constructs `createAgentHostToolResultRuntime`; xox now uses `createAgentServerHostToolResultPort`.
- HostProfile no longer directly calls `createAgentServerRuntimeSwitchAdapter`; xox now uses `createAgentServerSaaSRuntimePort`.
- OpenAI Agents runtime event projection moved into `@agentic-os/runtime-openai-agents` via `projectOpenAIAgentsRuntimeRunEventDraft`.
- Agentic OS lifecycle run-event projection moved into `@agentic-os/server` via `projectAgentServerSaaSRunEventDrafts`.
- Sandbox nested tool bridge and aggregate action planning moved behind `@agentic-os/sandbox` `runAgenticSandboxToolLoop`.
- Tool executor no longer constructs `createAgentMemoryToolRuntime`; it uses `createAgentServerMemoryToolHandlers`.
- xox no longer directly calls `projectAgentServerAgUiEvents` or `projectAgentServerRunSubmissionView`; it uses SaaS projection wrappers.
- Architecture tests now guard these low-level CPU entrypoints from returning to downstream production agent code.

## Remaining Work

- `xox-host-profile.ts` still owns provider adapter construction and localized runtime copy. This is now thinner, but a future cut should make provider adapter registration declarative.
- `memory.ts` still owns tenant memory repository/search DTO and Memory Center projection. The next memory cut should move scoring/citation projection behind an Agentic OS memory repository port.
- `xox-action-graph-adapter.ts` still owns durable action graph SQL materialization and xox legacy plan-step DTOs. This remains a host store adapter, but more generic status/navigation projection can move into `@agentic-os/server`.

## Completion Guard

Architecture tests must forbid host-owned CPU entrypoints from returning:

- `toolResultPort` in `xox-host-profile.ts`
- `toolResultPort` in `sandbox-service.ts`
- `createAgentHostToolResultRuntime` in downstream production agent code
- `createAgentMemoryToolRuntime` in downstream production agent code
- `executeXoxSandboxTool`
- `createSandboxToolRuntimeBridge` in downstream production agent code
- `planSandboxAggregateToolActions` in downstream production agent code
- `projectAgentServerAgUiEvents` in downstream production agent code
- `projectAgentServerRunSubmissionView` in downstream production agent code
- `createAgentServerRuntimeSwitchAdapter` in downstream production agent code
