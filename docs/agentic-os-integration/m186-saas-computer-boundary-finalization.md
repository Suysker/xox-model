# M186 SaaS Computer Boundary Finalization

## Goal

Make `apps/api/src/agent` behave like a downstream SaaS peripheral layer, not a local harness agent. XOX may provide tools, prompts, tenant stores, business writes, workspace bundles, product DTOs, HTTP/SSE routes, and localized copy. It must not visibly assemble the Agentic OS CPU: provider runtime construction, durable worker coordination, memory tool runtime, sandbox aggregate protocol, or generic action/run lifecycle projection.

## Current Overreach

The old local harness files are gone, but five files still expose CPU-level helpers:

- `apps/api/src/agent/host-profile/xox-host-profile.ts` imports and composes `createOpenAISaaSHostRuntimeAdapter()` and `createAgentServerSaaSHostComputer()`.
- `apps/api/src/agent/agentic-os/xox-run-store-adapter.ts` imports durable coordinator/projection helpers and owns visible worker/recovery lifecycle assembly.
- `apps/api/src/agent/tool-executor.ts` imports memory tool runtime, SaaS tool planner, and sandbox aggregate execution directly.
- `apps/api/src/agent/sandbox-service.ts` imports sandbox SaaS peripheral runner directly and declares nested bridge/aggregate policy inline.
- `apps/api/src/agent/memory.ts` is acceptable as a tenant store, but must not grow back into a memory kernel.

## Design

### Agentic OS Changes

1. `@agentic-os/runtime-openai-agents`
   - Add a SaaS host computer factory that owns OpenAI runtime creation and Agentic OS host profile assembly in one API.
   - Downstream hosts pass provider settings, prompt/context callbacks, tool catalog, store, and business execution callbacks.

2. `@agentic-os/server`
   - Add a durable run host registry/factory so downstream apps no longer directly import coordinator registries.
   - Add SaaS business tool planner and tenant memory handler factory APIs that are consumed as stable runtime objects, not one-off low-level helper calls.

3. `@agentic-os/sandbox`
   - Add a SaaS peripheral runner object so downstream apps configure a sandbox peripheral once and call `read()`.
   - Keep aggregate/nested tool protocol inside the sandbox package API.

### XOX Changes

1. `xox-host-profile.ts`
   - Delete direct imports of `createOpenAISaaSHostRuntimeAdapter` and `createAgentServerSaaSHostComputer`.
   - Use the new Agentic OS SaaS host computer factory.

2. `xox-run-store-adapter.ts`
   - Delete direct use of durable coordinator registry.
   - Use the new Agentic OS durable host registry/factory.
   - Keep only SQL row loading, lease SQL effects, localized failure persistence, and materialized legacy result DTO.

3. `tool-executor.ts`
   - Replace visible memory/planner/aggregate one-off imports with stable Agentic OS runtime objects.
   - Keep only XOX business handlers and concrete business action execution.

4. `sandbox-service.ts`
   - Replace direct SaaS peripheral runner call with a configured Agentic OS sandbox peripheral object.
   - Keep workspace bundle, manifest, file inspection, SDK allowlist, and product read DTO.

5. Tests and docs
   - Update architecture guards so the deleted low-level helper names cannot return to XOX.
   - Validate Agentic OS packages and XOX API tests.

## Acceptance Gates

- `apps/api/src/agent` has no direct references to:
  - `createOpenAISaaSHostRuntimeAdapter`
  - `createAgentServerSaaSHostComputer`
  - `createAgentServerDurableRunCoordinatorRegistry`
  - `projectAgentServerQueuedRunCompletion`
  - `projectAgentServerRunRecoveryFailClosedInterruption`
  - `hasAgentServerRunPartialOutput`
- XOX still builds and agent architecture tests pass.
- Agentic OS server/runtime/sandbox packages build.

