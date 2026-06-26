# M183 Five File CPU Amputation

## Goal

Cut the remaining CPU-shaped responsibilities from the five thick xox agent files:

- `host-profile/xox-host-profile.ts`
- `agentic-os/xox-run-worker-adapter.ts`
- `sandbox-service.ts`
- `tool-executor.ts`
- `memory.ts`

## Boundary

xox may keep:

- tool catalog and business handlers
- prompt/product policy
- tenant stores and SQL row mapping
- sandbox data bundle and manifest policy
- product DTO projection and transport

xox must not own:

- runtime/profile factory choreography
- worker lifecycle orchestration
- sandbox nested-tool/aggregate protocol
- tool-result runtime and memory tool semantics
- action observation envelope creation
- active memory runtime profile semantics

## Validation

- `npm run build -w @agentic-os/core`
- `npm run build -w @agentic-os/server`
- `npm run build -w @agentic-os/sandbox`
- `npm run build:api`
- `npx vitest run tests/agent-architecture.test.ts tests/action-observation.test.ts tests/sandbox-tool.test.ts`

## Result

Implemented as an amputation-first slice.

Deleted from xox:

- Local SaaS tool-result port construction in `tool-executor.ts`.
- Local empty-result fallback planning in `tool-executor.ts`.
- Local memory tool copy/status wiring in `tool-executor.ts`.
- Local sandbox nested action serialization in `sandbox-service.ts`.
- Local sandbox aggregate confirmation details/payload construction in `sandbox-service.ts`.

Moved to Agentic OS:

- `@agentic-os/server` `createAgentServerSaaSBusinessToolPlanner()`.
- `@agentic-os/server` `createAgentServerSaaSTenantMemoryToolHandlers()`.
- `@agentic-os/sandbox` `createAgenticSandboxAggregateActionDraft()`.

Architecture guards now prevent these from returning to `apps/api/src/agent`:

- `createAgentServerSaaSHostToolResultPort`
- `createAgentServerTenantMemoryToolHandlers`
- `serializableNestedAction`
- `nestedActions: actions.map`
- `details: actions.map`

Still open:

- `xox-host-profile.ts` still contains provider/runtime/profile assembly.
- `xox-run-worker-adapter.ts` still contains durable worker lifecycle entrypoints.
- `memory.ts` still contains active-memory profile and tenant memory repository wiring.
